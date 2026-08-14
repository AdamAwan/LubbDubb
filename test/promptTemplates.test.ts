import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderTemplate,
  stripTemplateDoc,
  sampleTemplateFile,
  defaultPromptTemplates,
  loadPromptTemplates,
} from '../src/dispatcher/promptTemplates.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { overridePath } from '../web/src/components/PromptsTab.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { WorldSnapshot } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { singlePlan } from './support/plans.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lubbdubb-prompts-'));
}

test('renderTemplate fills tokens, stringifies numbers, leaves unknown tokens untouched', () => {
  assert.equal(renderTemplate('#{number} {title}', { number: 7, title: 'X' }), '#7 X');
  assert.equal(renderTemplate('{a} {b}', { a: 'x' }), 'x {b}');
});

test('stripTemplateDoc removes only a leading comment and trims', () => {
  assert.equal(stripTemplateDoc('<!-- docs here -->\n\nHello {x}'), 'Hello {x}');
  // A comment inside the body is preserved.
  assert.equal(stripTemplateDoc('Hello <!-- keep --> world'), 'Hello <!-- keep --> world');
});

test('defaults render the built-in prompt', () => {
  const t = defaultPromptTemplates();
  assert.equal(
    t.render('issue-pickup', { number: 3, title: 'Bug', body: 'It breaks', branch: 'issue/3' }),
    'GitHub issue #3 ("Bug") needs resolving.\n\nIt breaks\n\nImplement the fix on branch issue/3 and open a pull request that resolves it. ' +
      'Reference the issue as "closes #3" only if this PR completes the whole thing; if work remains afterwards, ' +
      'reference it as "part of #3" so it stays open for the rest.',
  );
});

test('sampleTemplateFile carries a doc header that strips back to the default', () => {
  const file = sampleTemplateFile('issue-pickup');
  assert.match(file, /^<!--/);
  const body = stripTemplateDoc(file);
  assert.equal(defaultPromptTemplates().render('issue-pickup', {}), renderTemplate(body, {}));
});

test('loadPromptTemplates: absent dir yields defaults', () => {
  const t = loadPromptTemplates(join(tmpDir(), 'does-not-exist'));
  assert.match(t.render('issue-pickup', { number: 7, title: 'T', body: 'B', branch: 'issue/7' }), /#7/);
});

test('loadPromptTemplates: an override file (with doc header) replaces the default', () => {
  const dir = tmpDir();
  try {
    writeFileSync(
      join(dir, 'issue-pickup.md'),
      '<!-- our house flow -->\n\nPlease fix #{number}: {title}. Branch {branch}.',
    );
    const t = loadPromptTemplates(dir);
    assert.equal(
      t.render('issue-pickup', { number: 9, title: 'Z', body: 'b', branch: 'issue/9' }),
      'Please fix #9: Z. Branch issue/9.',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPromptTemplates: unknown filename throws', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'isue-pickup.md'), 'oops');
    assert.throws(() => loadPromptTemplates(dir), /names no known prompt id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPromptTemplates: unknown placeholder throws', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'pr-ci-fix.md'), 'Fix {number} for {sprint}');
    assert.throws(() => loadPromptTemplates(dir), /unknown placeholder\(s\) \{sprint\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPromptTemplates: empty-after-header throws', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'pr-ci-fix.md'), '<!-- just docs, no body -->\n');
    assert.throws(() => loadPromptTemplates(dir), /empty after its doc header/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describe: every id carries its doc, placeholders and effective text', () => {
  const book = defaultPromptTemplates().describe();
  assert.ok(book.length >= 18, `expected the whole registry, got ${book.length}`);
  assert.equal(new Set(book.map((t) => t.id)).size, book.length, 'ids must be unique');
  for (const t of book) {
    // A new prompt id cannot ship undocumented: the doc seeds the sample override
    // file and is the only thing the panel can say about what a prompt is for.
    assert.ok(t.doc.trim().length > 0, `${t.id} has no doc`);
    assert.ok(t.template.trim().length > 0, `${t.id} has no template`);
    assert.equal(t.overridden, false, `${t.id} is not overridden by default`);
    // What the panel offers an operator as writable must be what the loader
    // actually accepts in an override file.
    for (const p of t.placeholders) {
      assert.doesNotThrow(() => renderTemplate(`{${p}}`, { [p]: 'x' }));
    }
  }
  const pickup = book.find((t) => t.id === 'issue-pickup');
  assert.ok(pickup);
  assert.deepEqual([...pickup.placeholders], ['number', 'title', 'body', 'branch']);
  assert.equal(pickup.template, renderTemplate(stripTemplateDoc(sampleTemplateFile('issue-pickup')), {}));
});

test('describe: overridden is true only for ids the loader actually replaced', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'pr-ci-fix.md'), '<!-- ours -->\n\nFix CI on PR #{number}.');
    const book = loadPromptTemplates(dir).describe();
    const overridden = book.filter((t) => t.overridden).map((t) => t.id);
    assert.deepEqual(overridden, ['pr-ci-fix']);
    // The *effective* text, so the panel shows what the dispatcher will send.
    assert.equal(book.find((t) => t.id === 'pr-ci-fix')?.template, 'Fix CI on PR #{number}.');
    // An untouched id still reports its built-in.
    assert.match(book.find((t) => t.id === 'issue-pickup')?.template ?? '', /issue/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the panel names the override file in the server\u2019s own path dialect', () => {
  // `promptTemplatesDir` is resolved to an absolute path server-side, so on
  // Windows it arrives backslashed. A hardcoded separator would hand the operator
  // a path in two dialects — one they cannot paste into a shell.
  assert.equal(
    overridePath('C:\\repo\\.lubbdubb\\prompts', 'issue-pickup'),
    'C:\\repo\\.lubbdubb\\prompts\\issue-pickup.md',
  );
  assert.equal(
    overridePath('/srv/repo/.lubbdubb/prompts', 'issue-pickup'),
    '/srv/repo/.lubbdubb/prompts/issue-pickup.md',
  );
  // A trailing separator is not doubled, either way round.
  assert.equal(overridePath('/srv/prompts/', 'pr-ci-fix'), '/srv/prompts/pr-ci-fix.md');
  assert.equal(overridePath('C:\\prompts\\', 'pr-ci-fix'), 'C:\\prompts\\pr-ci-fix.md');
  // No dir configured: the panel still says what to create, generically.
  assert.equal(overridePath(null, 'pr-ci-fix'), '<promptTemplatesDir>/pr-ci-fix.md');
});

test('GET /api/prompts serves the book the dispatcher renders from, overrides and all', async () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'pr-ci-fix.md'), 'CI is red on #{number}. Fix it on {branch}.');
    const config = loadConfig({
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      labelPrefix: '',
      agentMode: 'raw',
      heartbeatIntervalMs: 999_999,
      startPaused: true,
      promptTemplatesDir: dir,
    });
    const system = buildSystem(config, {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
    });
    const { app } = await buildApp(system);
    const res = await app.inject({ method: 'GET', url: '/api/prompts' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      dir: string;
      templates: { id: string; template: string; overridden: boolean; placeholders: string[]; doc: string }[];
    };
    // The directory is what makes a read-only panel actionable: it names the file
    // an operator would create.
    assert.equal(body.dir, config.promptTemplatesDir);
    const ci = body.templates.find((t) => t.id === 'pr-ci-fix');
    assert.ok(ci);
    assert.equal(ci.overridden, true);
    assert.equal(ci.template, 'CI is red on #{number}. Fix it on {branch}.');
    // The served text is the *effective* one, so the panel and the agent read the
    // same words — asserted against the render rather than trusted.
    assert.equal(
      system.prompts.render('pr-ci-fix', { number: 4, title: 'T', branch: 'b' }),
      renderTemplate(ci.template, { number: 4, title: 'T', branch: 'b' }),
    );
    assert.equal(body.templates.find((t) => t.id === 'pr-review-comment')?.overridden, false);
    await app.close();
    system.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ctx(world: Partial<WorldSnapshot>, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], ...world },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

test('a custom template flows through the dispatcher into the dispatched prompt', async () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'issue-pickup.md'), 'Handle #{number} on {branch}.');
    const d = new RuleDispatcher({}, {}, loadPromptTemplates(dir));
    const { actions } = await d.decide(
      ctx(
        { issues: [{ id: 'i1', number: 12, title: 'T', body: 'B', state: 'open', labels: [], linkedPrNumber: null }] },
        // Planned as one pull request, so the rule under test is the pickup
        // rather than the planner in front of it.
        { plans: [singlePlan(12)] },
      ),
    );
    assert.equal(actions[0]?.type, 'dispatch_code_agent');
    assert.equal((actions[0] as { prompt: string }).prompt, 'Handle #12 on issue/12.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The three templates that *are* an escalation's whole prompt render to one line.
 *
 * A prompt is what the operator reads first, and the card treats its first
 * paragraph as the headline. These three carry nothing else — no consequence
 * paragraph, no quoted agent text — so a line break in one is not structure being
 * given back, it is a lede that grew into a body with no label on it.
 *
 * The multi-paragraph templates are deliberately absent: `plan-approval` and
 * `issue-shortfall` write what accepting and rejecting *do* as their own
 * paragraphs, which the card renders as the body under the headline. That is the
 * split working, not a violation of it.
 */
test('an escalation-only template is a single-line lede', () => {
  const t = defaultPromptTemplates();
  const rendered = {
    'issue-pickup-escalation': t.render('issue-pickup-escalation', { number: 12, title: 'T', attempts: 3 }),
    'plan-part-escalation': t.render('plan-part-escalation', { number: 12, part: 'signer', attempts: 3 }),
    'pr-concern-escalation': t.render('pr-concern-escalation', { number: 42, title: 'T', attempts: 3 }),
  };
  for (const [id, text] of Object.entries(rendered)) {
    assert.doesNotMatch(text, /[\r\n]/, `${id} must render as one line`);
    assert.ok(text.length > 0, `${id} rendered empty`);
  }
});

test('the shortfall proposal no longer templates the assessor s own words', () => {
  // The placeholder is gone on purpose: what the assessor wrote is carried beside
  // the prompt as the escalation's `detail` and rendered as the card's labelled
  // body. Templated, an operator override could bury it mid-paragraph again — and
  // `loadPromptTemplates` only rejects placeholders it does not know, so an
  // override written against the old shape would keep interpolating it.
  const t = defaultPromptTemplates();
  const text = t.render('issue-shortfall', { number: 12, title: 'T', consequence: 'Accepting replans it.' });
  assert.doesNotMatch(text, /\{summary\}/);
  assert.match(text, /Accepting replans it\./);
  assert.equal(sampleTemplateFile('issue-shortfall').includes('{summary}'), false);
});
