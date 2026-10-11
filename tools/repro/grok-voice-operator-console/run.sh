#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo_dir"

if [[ "${RUNTIME_ONLY:-0}" != "1" ]]; then
  echo "[1/3] TypeScript"
  timeout 120 ./node_modules/.bin/tsc --noEmit

  echo "[2/3] Operator-console targeted tests"
  test_output=$(mktemp)
  cleanup() {
    rm -f "$test_output"
  }
  trap cleanup EXIT
  if timeout 120 ./node_modules/.bin/vitest run \
    test/state.test.ts \
    test/media.test.ts \
    test/recordings.test.ts \
    test/auth.test.ts \
    test/telnyx.test.ts \
    test/console.test.ts >"$test_output" 2>&1; then
    :
  else
    status=$?
    cat "$test_output"
    exit "$status"
  fi
  cat "$test_output"
  "$repo_dir/tools/repro/grok-voice-operator-console/assert.sh" "$test_output"
  rm -f "$test_output"
  trap - EXIT
fi

echo "[3/3] Local Worker runtime probe"
worker_log=$(mktemp)
worker_state=$(mktemp -d)
worker_pid=""
cleanup_worker() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$worker_log"
  rm -rf "$worker_state"
}
trap cleanup_worker EXIT

./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 18787 \
  --persist-to "$worker_state" -c ./wrangler.toml >"$worker_log" 2>&1 &
worker_pid=$!
ready=""
for _ in $(seq 1 40); do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    cat "$worker_log"
    exit 1
  fi
  if ready=$(curl -fsS --max-time 1 http://127.0.0.1:18787/health 2>/dev/null); then
    break
  fi
  sleep 0.25
done
if [[ "$ready" != *'"ok":true'* ]]; then
  cat "$worker_log"
  echo "local Worker did not become healthy" >&2
  exit 1
fi
console_status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:18787/console)
me_status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:18787/api/me)
[[ "$console_status" == "503" ]]
[[ "$me_status" == "401" ]]
echo "health=${ready} anonymous_console=${console_status} anonymous_me=${me_status}"
echo "operator console reproduction harness: PASS"
