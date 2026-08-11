import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAssessment } from '../src/mcp/assessment.js';
import { readFileSync } from 'node:fs';
import { quotedAssessment, shortfallEscalationPrompt } from '../src/delivery/shortfall.js';

/**
 * The shape an assessment has to arrive in, and the shape it leaves in.
 *
 * Both halves of one rule: an assessor writes a headline and an account, and the
 * harness quotes them rather than splicing them into its own sentence. Before
 * this, `summary` was one 2000-character field and rule `issue-shortfall`
 * interpolated the whole of it into the prompt — so what reached the operator was
 * a single paragraph with an agent's write-up buried in the middle of it.
 *
 * The refusals are what make it a rule. A cap nobody enforces is a suggestion,
 * and the failure it prevents is invisible at the call site: a prompt builder
 * that grew a paragraph would compile, pass, and put the wall straight back.
 */

const ok = { status: 'more_work', summary: 'the CLI half is missing', cause: 'plan' };

test('a summary with a line break is refused, and told where the text belongs', () => {
  // The load-bearing refusal. It turns a blob into a tool error the same agent
  // fixes inside its own turn, instead of something an operator reads hours later.
  const out = validateAssessment({ ...ok, summary: 'PRESENT: the docs\nMISSING: the stream half' });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /one line/i);
  assert.match(out.ok === false ? out.error : '', /`detail`/);
});

test('a carriage return counts as a line break', () => {
  // The write-up may have come off a Windows checkout; a refusal that only knew
  // about \n would let exactly the same blob through on half the machines.
  assert.equal(validateAssessment({ ...ok, summary: 'one\r\ntwo' }).ok, false);
});

test('an over-long summary is refused as a headline, not asked to be shorter prose', () => {
  const out = validateAssessment({ ...ok, summary: 'x'.repeat(161) });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /headline/);
  // 160 exactly is fine: the cap is the boundary, not a margin around one.
  assert.equal(validateAssessment({ ...ok, summary: 'x'.repeat(160) }).ok, true);
});

test('an over-long detail is refused, and the old cap is what it is refused against', () => {
  // The 2000-character cap moved off `summary` and onto `detail`; it did not
  // vanish, or an assessor could paste a transcript into the field instead.
  assert.equal(validateAssessment({ ...ok, detail: 'x'.repeat(2001) }).ok, false);
  assert.equal(validateAssessment({ ...ok, detail: 'x'.repeat(2000) }).ok, true);
});

test('detail is optional, and blank is the same as absent', () => {
  // An assessor with nothing to add writes nothing. Null rather than '' so the
  // card asks one question — is there a body? — instead of two.
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
  // The assertion the rule cannot make about itself. Everything the assessor
  // wrote rides in `detail`; if this ever carries a paragraph again, the card is
  // back to being one wall of orange text and nothing else would catch it.
  for (const cause of ['goal', null] as const) {
    const prompt = shortfallEscalationPrompt(205, 'Document the sentinel protocol', cause);
    assert.doesNotMatch(prompt, /[\r\n]/, `cause ${cause}: no line breaks`);
    assert.ok(prompt.length <= 320, `cause ${cause}: ${prompt.length} chars is not a lede`);
    assert.match(prompt, /#205/);
  }
  // The two causes say different things about *why* nothing is coming, which is
  // the only fact the operator needs before deciding to read on.
  assert.match(shortfallEscalationPrompt(1, 't', 'goal'), /no planner and no agent can fix a goal/);
  assert.match(shortfallEscalationPrompt(1, 't', null), /no delivery plan/);
});

test('the assessment is quoted whole, headline included', () => {
  // Both fields, so the card's body reads as one passage rather than repeating
  // the headline above it in the same words.
  const both = quotedAssessment('the goal names two protocols', '## Missing\n\nthe stream half');
  assert.match(both, /^\*\*the goal names two protocols\*\*/);
  assert.match(both, /## Missing/);
  // A row written before `detail` existed holds its whole blob in `summary`, and
  // yields exactly that — a tall block, not a lie about its own structure.
  assert.equal(quotedAssessment('one long legacy blob', null), 'one long legacy blob');
});

test('the rules that quote someone say who, rather than leaving it to be guessed', () => {
  // The escalation contexts carry a `detailFrom` beside every `detail` they set.
  // Without it the card falls back to what it actually knows, and the one thing
  // it must never do is infer a role: "no agent, therefore an assessor" captions
  // a planner's decomposition as an assessment, which is what it did until the
  // golden markup caught it.
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
