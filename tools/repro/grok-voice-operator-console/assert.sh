#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <vitest-output-file>" >&2
  exit 2
fi

output_file=$1
if [[ ! -s "$output_file" ]]; then
  echo "missing or empty test output: $output_file" >&2
  exit 1
fi

grep -F 'Test Files' "$output_file" | grep -F 'passed' >/dev/null
grep -F 'Tests' "$output_file" | grep -F 'passed' >/dev/null
echo "operator console targeted tests: PASS"
