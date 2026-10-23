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
import { buildSystem } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { overridePath } from '../web/src/components/PromptsTab.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { WorldSnapshot } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { onePartPlanRows, spentAppraisalAttempts } from './support/plans.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lubbdubb-prompts-'));
}

test('renderTemplate fills tokens, stringifies numbers, leaves unknown tokens untouched', () => {
  assert.equal(renderTemplate('#{number} {title}', { number: 7, title: 'X' }), '#7 X');
  assert.equal(renderTemplate('{a} {b}', { a: 'x' }), 'x {b}');
});

test('stripTemplateDoc removes only a leading comment and trims', () => {
  assert.equal(stripTemplateDoc('<!-- docs here -->\n\nHello {x}'), 'Hello {x}');
  assert.equal(stripTemplateDoc('Hello <!-- keep --> world'), 'Hello <!-- keep --> world');
});

test('defaults render the built-in prompt', () => {
  const t = defaultPromptTemplates();
  assert.equal(
    t.render('issue-plan-escalation', { number: 3, title: 'Bug', attempts: 3 }),
    'Planning issue #3 ("Bug") keeps failing: 3 planner attempt(s) produced no plan. Nothing is implemented for an ' +
      'issue without a plan, so it waits on you. Look at why the planner could not decompose it: usually the ' +
      'ticket needs rewriting, or the work is already done.',
  );
});

test('sampleTemplateFile carries a doc header that strips back to the default', () => {
  const file = sampleTemplateFile('plan-part');
  assert.match(file, /^<!--/);
  const body = stripTemplateDoc(file);
  assert.equal(defaultPromptTemplates().render('plan-part', {}), renderTemplate(body, {}));
});

test('loadPromptTemplates: absent dir yields defaults', () => {
  const t = loadPromptTemplates(join(tmpDir(), 'does-not-exist'));
  assert.match(t.render('plan-part', { number: 7, title: 'T', part: 'P', branch: 'issue/7/p' }), /#7/);
});

test('loadPromptTemplates: an override file (with doc header) replaces the default', () => {
  const dir = tmpDir();
  try {
    writeFileSync(
      join(dir, 'plan-part.md'),
      '<!-- our house flow -->\n\nPlease fix #{number}: {title}. Branch {branch}.',
    );
    const t = loadPromptTemplates(dir);
    assert.equal(
      t.render('plan-part', { number: 9, title: 'Z', part: 'P', branch: 'issue/9/p' }),
      'Please fix #9: Z. Branch issue/9/p.',
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
    assert.ok(t.doc.trim().length > 0, `${t.id} has no doc`);
    assert.ok(t.template.trim().length > 0, `${t.id} has no template`);
    assert.equal(t.overridden, false, `${t.id} is not overridden by default`);
    for (const p of t.placeholders) {
      assert.doesNotThrow(() => renderTemplate(`{${p}}`, { [p]: 'x' }));
    }
  }
  const part = book.find((t) => t.id === 'plan-part');
  assert.ok(part);
  assert.deepEqual(
    [...part.placeholders],
    ['number', 'title', 'part', 'scope', 'branch', 'base', 'plan', 'done', 'remaining'],
  );
  assert.equal(part.template, renderTemplate(stripTemplateDoc(sampleTemplateFile('plan-part')), {}));
});

test('the issue-pickup prompts are retired, and an override of one still loads', () => {
  const retired = defaultPromptTemplates()
    .describe()
    .filter((t) => t.retired)
    .map((t) => t.id);
  assert.ok(retired.includes('issue-pickup'));
  assert.ok(retired.includes('issue-pickup-escalation'));
  assert.equal(
    defaultPromptTemplates()
      .describe()
      .find((t) => t.id === 'issue-plan-escalation')?.retired,
    false,
  );

  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'issue-pickup.md'), 'Handle #{number} on {branch}.');
    writeFileSync(join(dir, 'issue-pickup-escalation.md'), 'Issue #{number} is stuck.');
    const book = loadPromptTemplates(dir).describe();
    assert.deepEqual(
      book
        .filter((t) => t.overridden)
        .map((t) => t.id)
        .sort(),
      ['issue-pickup', 'issue-pickup-escalation'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describe: overridden is true only for ids the loader actually replaced', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'pr-ci-fix.md'), '<!-- ours -->\n\nFix CI on PR #{number}.');
    const book = loadPromptTemplates(dir).describe();
    const overridden = book.filter((t) => t.overridden).map((t) => t.id);
    assert.deepEqual(overridden, ['pr-ci-fix']);
    assert.equal(book.find((t) => t.id === 'pr-ci-fix')?.template, 'Fix CI on PR #{number}.');
    assert.match(book.find((t) => t.id === 'plan-part')?.template ?? '', /issue/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the panel names the override file in the server\u2019s own path dialect', () => {
  assert.equal(overridePath('C:\\repo\\.lubbdubb\\prompts', 'plan-part'), 'C:\\repo\\.lubbdubb\\prompts\\plan-part.md');
  assert.equal(overridePath('/srv/repo/.lubbdubb/prompts', 'plan-part'), '/srv/repo/.lubbdubb/prompts/plan-part.md');
  assert.equal(overridePath('/srv/prompts/', 'pr-ci-fix'), '/srv/prompts/pr-ci-fix.md');
  assert.equal(overridePath('C:\\prompts\\', 'pr-ci-fix'), 'C:\\prompts\\pr-ci-fix.md');
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
    assert.equal(body.dir, config.promptTemplatesDir);
    const ci = body.templates.find((t) => t.id === 'pr-ci-fix');
    assert.ok(ci);
    assert.equal(ci.overridden, true);
    assert.equal(ci.template, 'CI is red on #{number}. Fix it on {branch}.');
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
    writeFileSync(join(dir, 'plan-part.md'), 'Handle #{number} on {branch}.');
    const d = new RuleDispatcher({ templates: loadPromptTemplates(dir) });
    const { actions } = await d.decide(
      ctx(
        { issues: [{ id: 'i1', number: 12, title: 'T', body: 'B', state: 'open', labels: [], linkedPrNumber: null }] },
        { ...onePartPlanRows(12), recentDecisions: spentAppraisalAttempts(12) },
      ),
    );
    assert.equal(actions[0]?.type, 'dispatch_code_agent');
    assert.match(
      (actions[0] as { prompt: string }).prompt,
      /^Handle #12 on issue\/12\/whole\.(\n\n|$)/,
      'the override is the prompt; the harness appends its notes after it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an escalation-only template is a single-line lede', () => {
  const t = defaultPromptTemplates();
  const rendered = {
    'issue-plan-escalation': t.render('issue-plan-escalation', { number: 12, title: 'T', attempts: 3 }),
    'plan-part-escalation': t.render('plan-part-escalation', { number: 12, part: 'signer', attempts: 3 }),
    'pr-concern-escalation': t.render('pr-concern-escalation', { number: 42, title: 'T', attempts: 3 }),
  };
  for (const [id, text] of Object.entries(rendered)) {
    assert.doesNotMatch(text, /[\r\n]/, `${id} must render as one line`);
    assert.ok(text.length > 0, `${id} rendered empty`);
  }
});

test('the shortfall proposal no longer templates the assessor s own words', () => {
  const t = defaultPromptTemplates();
  const text = t.render('issue-shortfall', { number: 12, title: 'T', consequence: 'Accepting replans it.' });
  assert.doesNotMatch(text, /\{summary\}/);
  assert.match(text, /Accepting replans it\./);
  assert.equal(sampleTemplateFile('issue-shortfall').includes('{summary}'), false);
});
