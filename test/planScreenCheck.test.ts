import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_PLANNING, screenCheckNote } from '../src/plans/planning.js';
import { authoringBriefing } from '../src/validation/authoring.js';
import { PromptTemplates, defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Issue, Plan, WorldSnapshot } from '../src/types.js';
import { spentAppraisalAttempts } from './support/plans.js';

// → docs/spec/20-validation.md#who-carries-a-step

const NO_BROWSER: EnvironmentConfig[] = [{ name: 'acceptance', at: 'echo sha' }];

const WITH_BROWSER: EnvironmentConfig[] = [
  { name: 'acceptance', at: 'echo sha' },
  {
    name: 'production',
    at: 'echo sha',
    validate: {
      permits: ['check'],
      browser: { runner: 'npx playwright test', listSelectors: 'npx playwright test --list' },
    },
  },
];

// -------------------------------------------------------------- the templates

test('neither planning template nominates a person for looking at a screen', () => {
  for (const id of ['issue-plan', 'issue-replan'] as const) {
    const rendered = defaultPromptTemplates().render(id, {
      number: 12,
      title: 'Checkout',
      body: 'Do the thing.',
      branch: 'plan/issue/12',
      planFile: '.lubbdubb/plan.json',
      current: '',
    });
    assert.doesNotMatch(rendered, /person’s eyes|person's eyes/, `${id} does not name a person's eyes as the bar`);
    assert.doesNotMatch(
      rendered,
      /looking at a rendered screen/,
      `${id} does not offer a rendered screen as an example of what only a person can do`,
    );
  }
});

// -------------------------------------------------------------------- the note

test('the note says the fleet makes the trip and a person judges what came back', () => {
  const note = screenCheckNote(WITH_BROWSER);
  assert.match(note, /`screenshot` step/, 'and names the step that carries it');
  assert.match(note, /judgement/);
  assert.match(note, /never the going and looking/);
  assert.match(note, /not yours to nominate/, 'who carries a step is read off the configuration, not from the hint');
  assert.match(note, /`expectedKind: "human"`/, 'and the plan-part form of the same mistake is corrected too');
});

test('it is empty where no environment declares a browser runner', () => {
  assert.equal(screenCheckNote(NO_BROWSER), '', 'a deployment that drives no browser really does need a person');
  assert.equal(screenCheckNote([]), '');
});

function issue(number: number): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Issue ${number}`,
    body: 'Do the thing.',
    state: 'open',
    labels: [],
    linkedPrNumber: null,
  };
}

function world(issues: Issue[]): WorldSnapshot {
  return { takenAt: '2026-09-09T12:00:00.000Z', pullRequests: [], issues };
}

function planRow(status: Plan['status']): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Checkout',
    status,
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
}

async function plannerPrompt(
  environments: EnvironmentConfig[],
  which: 'plan' | 'replan',
  templates?: PromptTemplates,
): Promise<string> {
  const replan = which === 'replan';
  const context: DispatchContext = {
    world: world([issue(12)]),
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    plans: replan ? [planRow('planning')] : [],
    recentDecisions: spentAppraisalAttempts(12),
  };
  const dispatcher = new RuleDispatcher({
    templates,
    defaultBranch: 'main',
    planning: DEFAULT_PLANNING,
    validationRoot: '.lubbdubb/validation',
    prRefStyle: '#',
    reviewCharters: { routing: null, modes: {} },
    screenCheckNote: screenCheckNote(environments),
  });
  const { actions } = await dispatcher.decide(context);
  const action = actions.find((a) => a.rule === 'issue-plan');
  assert.ok(action && action.type === 'dispatch_code_agent', `no ${which} was dispatched`);
  assert.match(action.title, replan ? /^Replan/ : /^Plan/, 'the arm under test is the one that was rendered');
  return action.prompt;
}

test('both planning prompts carry the note where an environment declares a browser runner', async () => {
  const note = screenCheckNote(WITH_BROWSER);
  for (const which of ['plan', 'replan'] as const) {
    const prompt = await plannerPrompt(WITH_BROWSER, which);
    assert.ok(prompt.includes(note), `the ${which} prompt carries the note in full`);
  }
});

test('an override that never learned any new token still receives it', async () => {
  const overridden = new PromptTemplates({
    'issue-plan': 'Plan it. Nothing here but this sentence.',
    'issue-replan': 'Plan it again. Nothing here but this sentence.',
  });
  const note = screenCheckNote(WITH_BROWSER);
  for (const which of ['plan', 'replan'] as const) {
    const prompt = await plannerPrompt(WITH_BROWSER, which, overridden);
    assert.match(prompt, /Nothing here but this sentence/, 'the override really is what was rendered');
    assert.ok(prompt.includes(note), 'and the note is concatenated after it rather than interpolated into it');
    assert.ok(!/\{[a-zA-Z]+\}/.test(note), 'the note is a rendered string, so no template declares a token for it');
  }
});

test('neither prompt carries it where nothing drives a browser', async () => {
  for (const which of ['plan', 'replan'] as const) {
    const prompt = await plannerPrompt(NO_BROWSER, which);
    assert.doesNotMatch(prompt, /Somebody looking at a screen/, `the ${which} prompt says nothing about it`);
  }
});

// ------------------------------------------------------------- the check author

function briefing(hint: string | null): string {
  return authoringBriefing({ hint, parts: [], environments: '' });
}

test('the check author is told the hint is a hint, and where its author could not see', () => {
  const note = briefing('Somebody should look at the batch page after an import.');
  assert.match(note, /hint and not an order/);
  assert.match(
    note,
    /reading the repository \*before\* any of this existed/,
    'and why: it was written against code that did not exist',
  );
  assert.match(note, /apply your own/, 'so the authoring agent brings what it can see');
  assert.match(note, /drop what the code no longer does/);
  assert.match(note, /add\s+what it could not have known to ask for/);
});

test('but departing from it silently is still refused', () => {
  const note = briefing('Somebody should look at the batch page after an import.');
  assert.match(note, /silently/, 'the departure is stated, never withheld');
  assert.match(note, /\*\*say so in your note\*\*/);
  assert.match(note, /entitled to see what became of it/, 'and the operator who approved the intent is why');
});

test('no hint is still not a gap to fill in from the ticket', () => {
  const note = briefing(null);
  assert.match(note, /ordinary answer and not a gap to fill in/);
  assert.doesNotMatch(note, /hint and not an order/, 'there is no hint to say it about');
});

// ----------------------------------------------------------- the step vocabulary

test('the test plan note sends a look-at-it check to `screenshot` rather than `manual`', () => {
  const note = briefing(null);
  assert.match(note, /is a `screenshot` step, not a `manual` one/);
  assert.match(note, /no agent can\s+reach at all/, 'and says what `manual` is for instead');
});

test('the same correction is made at plan time, where the part form of it lives', () => {
  const spec = readFileSync('docs/spec/08-planning.md', 'utf8');
  const section = spec.slice(spec.indexOf('### A step for a person'));
  assert.doesNotMatch(
    section.slice(0, section.indexOf('\n## ')),
    /looking at a rendered screen/,
    'the spec no longer offers a screen as the example of work only a person can do',
  );
});
