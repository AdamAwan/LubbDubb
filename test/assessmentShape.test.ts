import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAssessment } from '../src/mcp/assessment.js';
import { readFileSync } from 'node:fs';
import { quotedAssessment, shortfallEscalationPrompt } from '../src/delivery/shortfall.js';

const ok = { status: 'more_work', summary: 'the CLI half is missing', cause: 'plan' };

test('a summary with a line break is refused, and told where the text belongs', () => {
  const out = validateAssessment({ ...ok, summary: 'PRESENT: the docs\nMISSING: the stream half' });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /one line/i);
  assert.match(out.ok === false ? out.error : '', /`detail`/);
});

test('a carriage return counts as a line break', () => {
  assert.equal(validateAssessment({ ...ok, summary: 'one\r\ntwo' }).ok, false);
});

test('an over-long summary is refused as a headline, not asked to be shorter prose', () => {
  const out = validateAssessment({ ...ok, summary: 'x'.repeat(161) });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /headline/);
  assert.equal(validateAssessment({ ...ok, summary: 'x'.repeat(160) }).ok, true);
});

test('an over-long detail is refused, and the old cap is what it is refused against', () => {
  assert.equal(validateAssessment({ ...ok, detail: 'x'.repeat(2001) }).ok, false);
  assert.equal(validateAssessment({ ...ok, detail: 'x'.repeat(2000) }).ok, true);
});

test('detail is optional, and blank is the same as absent', () => {
  const bare = validateAssessment(ok);
  assert.equal(bare.ok, true);
  assert.equal(bare.ok === true ? bare.detail : 'unset', null);
  const blank = validateAssessment({ ...ok, detail: '   ' });
  assert.equal(blank.ok === true ? blank.detail : 'unset', null);
});

test('all five arguments round-trip', () => {
  const out = validateAssessment({
    status: 'more_work',
    summary: 'the sentinel docs cover the PTY runtime only',
    detail: '## Missing\n\nThe stream runtime has no sentinels at all.',
    cause: 'part',
    part: 'docs',
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.verdict, 'more_work');
  assert.equal(out.summary, 'the sentinel docs cover the PTY runtime only');
  assert.match(out.detail ?? '', /^## Missing/);
  assert.equal(out.cause, 'part');
  assert.equal(out.part, 'docs');
});

test("the escalation's prompt is a lede and stays one", () => {
  for (const cause of ['goal', null] as const) {
    const prompt = shortfallEscalationPrompt(205, 'Document the sentinel protocol', cause);
    assert.doesNotMatch(prompt, /[\r\n]/, `cause ${cause}: no line breaks`);
    assert.ok(prompt.length <= 320, `cause ${cause}: ${prompt.length} chars is not a lede`);
    assert.match(prompt, /#205/);
  }
  assert.match(shortfallEscalationPrompt(1, 't', 'goal'), /no planner and no agent can fix a goal/);
  assert.match(shortfallEscalationPrompt(1, 't', null), /no delivery plan/);
});

test('the assessment is quoted whole, headline included', () => {
  const both = quotedAssessment('the goal names two protocols', '## Missing\n\nthe stream half');
  assert.match(both, /^\*\*the goal names two protocols\*\*/);
  assert.match(both, /## Missing/);
  assert.equal(quotedAssessment('one long legacy blob', null), 'one long legacy blob');
});

test('the rules that quote someone say who, rather than leaving it to be guessed', () => {
  const sources = [
    'src/dispatcher/rules/issueShortfall.ts',
    'src/dispatcher/rules/prCiFailing.ts',
    'src/executor/actionExecutor.ts',
  ];
  for (const file of sources) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const details = text.match(/^\s*detail: /gm)?.length ?? 0;
    const froms = text.match(/^\s*detailFrom: /gm)?.length ?? 0;
    assert.ok(froms >= 1, `${file} sets an escalation detail, so it must name its author`);
    assert.ok(details >= froms, `${file}: ${froms} labels for ${details} details`);
  }
});
