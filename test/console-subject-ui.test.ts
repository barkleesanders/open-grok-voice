// The console has to SAY what a call was about, in the log and in the detail.
//
// The complaint this answers, verbatim: "you need to label them better in
// interface so i know what each call in that section is about so i can know
// difference between them". Before this, a row carried a timestamp, a redacted
// number, a phase and a duration -- every one of which two calls to the same
// switchboard share.

import { describe, expect, it } from 'vitest';
import { renderConsolePage } from '../src/console-ui';

function consoleScript(html: string): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script): script is string => Boolean(script?.trim()));
  const script = scripts[0];
  if (scripts.length !== 1 || script === undefined) {
    throw new Error(`expected exactly one inline script, found ${scripts.length}`);
  }
  return script;
}

const PAGE = renderConsolePage('test-nonce', 'authorized', { name: 'Operator', image: null });
const SCRIPT = consoleScript(PAGE);

describe('naming a call when starting one', () => {
  it('offers a subject field, bounded to what R2 metadata will carry', () => {
    expect(PAGE).toContain('id="call-subject"');
    expect(PAGE).toContain('maxlength="120"');
  });

  it('sends the subject with the call request', () => {
    expect(SCRIPT).toContain("byId('call-subject').value");
  });

  it('omits an empty subject rather than sending a blank string', () => {
    // The schema treats absent as "derive one from the task"; '' would fail its
    // trim().max() shape and reject an otherwise valid call.
    expect(SCRIPT).toContain("byId('call-subject').value.trim() || undefined");
  });

  it('carries no explanatory subtitle under the field', () => {
    // House rule: a self-explanatory label, no helper paragraph restating it.
    expect(PAGE).not.toContain('<p class="fine-print">Name this call');
  });
});

describe('the call-log row', () => {
  it('renders the subject as its own element, styled as the headline', () => {
    expect(SCRIPT).toContain('calllog-subject');
    expect(PAGE).toContain('.calllog-subject{');
  });

  it('promotes to the headline ONLY a subject a human wrote', () => {
    // THE REGRESSION THIS PINS: version 3a7d4f0c promoted any non-empty
    // subject, including the task-derived fallback. Measured on the 10 archived
    // calls in production that produced 2 distinct derived subjects, 8 sharing
    // one boilerplate preamble -- so 8 rows rendered identically and the
    // number, which does differ, was pushed off the headline.
    expect(SCRIPT).toContain("call.subjectSource === 'operator'");
    expect(SCRIPT).toContain('title.textContent = named || number');
    expect(SCRIPT).toContain('row.append(title, who, when, meta)');
  });

  it('keeps the number as the headline for a derived or unattributed subject', () => {
    // Both non-operator states take the same branch, which is the branch that
    // existed before the subject shipped: number first.
    expect(SCRIPT).toContain('row.append(title, when, meta)');
    expect(SCRIPT).not.toContain('title.textContent = subject || number');
  });

  it('never prints the destination twice on one row', () => {
    expect(SCRIPT).toContain('who.textContent = named ? number : when.textContent');
  });

  it('guards the subject against a non-string, so no row can render "undefined"', () => {
    expect(SCRIPT).toContain("typeof call.subject === 'string'");
  });
});

describe('the detail panel', () => {
  it('has somewhere to show the subject and the task behind it', () => {
    expect(PAGE).toContain('id="call-subject-view"');
    expect(PAGE).toContain('id="subject-line"');
    expect(PAGE).toContain('id="task-text"');
  });

  it('starts hidden, so an unselected console shows no empty labelled box', () => {
    expect(PAGE).toContain('id="call-subject-view" class="subject-view" hidden');
  });

  it('hides itself again for a call that has neither subject nor task', () => {
    expect(SCRIPT).toContain("subjectView.hidden = subjectText === '' && taskText === ''");
  });

  it('reads both fields from the status payload', () => {
    expect(SCRIPT).toContain('data.subject');
    expect(SCRIPT).toContain('data.task');
  });

  it('says when the subject was derived rather than written by the operator', () => {
    // The panel has room for a derived subject and the operator opened this
    // call deliberately, so it is shown -- but under an honest label, not the
    // same word that names something they typed themselves.
    expect(PAGE).toContain('id="subject-label"');
    expect(SCRIPT).toContain("data.subjectSource !== 'operator'");
    expect(SCRIPT).toContain('SUBJECT (DERIVED FROM TASK)');
  });

  it('sets the task as TEXT, never as markup', () => {
    // The task is operator-authored free text rendered inside the operator's own
    // authenticated page. textContent is what keeps it data.
    expect(SCRIPT).toContain("byId('task-text').textContent = taskText");
    expect(SCRIPT).not.toContain("byId('task-text').innerHTML");
  });
});
