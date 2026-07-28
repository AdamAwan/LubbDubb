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
import { overridePath } from '../web/src/components/PromptsPanel.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { WorldSnapshot } from '../src/types.js';

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
  assert.match(t.render('story-waf', { title: 'S' }), /Well-Architected/);
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
    writeFileSync(join(dir, 'story-waf.md'), 'Do {title} for {sprint}');
    assert.throws(() => loadPromptTemplates(dir), /unknown placeholder\(s\) \{sprint\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPromptTemplates: empty-after-header throws', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'story-waf.md'), '<!-- just docs, no body -->\n');
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
    writeFileSync(join(dir, 'story-waf.md'), '<!-- ours -->\n\nPick pillars for {title}.');
    const book = loadPromptTemplates(dir).describe();
    const overridden = book.filter((t) => t.overridden).map((t) => t.id);
    assert.deepEqual(overridden, ['story-waf']);
    // The *effective* text, so the panel shows what the dispatcher will send.
    assert.equal(book.find((t) => t.id === 'story-waf')?.template, 'Pick pillars for {title}.');
    // An untouched id still reports its built-in.
    assert.match(book.find((t) => t.id === 'story-groom')?.template ?? '', /Draft them/);
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
  assert.equal(overridePath('/srv/prompts/', 'story-waf'), '/srv/prompts/story-waf.md');
  assert.equal(overridePath('C:\\prompts\\', 'story-waf'), 'C:\\prompts\\story-waf.md');
  // No dir configured: the panel still says what to create, generically.
  assert.equal(overridePath(null, 'story-waf'), '<promptTemplatesDir>/story-waf.md');
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
    const system = buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });
    const { app } = await buildApp(system);
    const res = await app.inject({ method: 'GET', url: '/api/prompts' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      dir: string;
      dispatcher: string;
      templates: { id: string; template: string; overridden: boolean; placeholders: string[]; doc: string }[];
    };
    // The directory is what makes a read-only panel actionable: it names the file
    // an operator would create.
    assert.equal(body.dir, config.promptTemplatesDir);
    assert.equal(body.dispatcher, config.dispatcher);
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

function ctx(world: Partial<WorldSnapshot>): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], stories: [], ...world },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    steeringPriorities: [],
    agentHeadroom: 3,
  };
}

test('a custom template flows through the dispatcher into the dispatched prompt', async () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'issue-pickup.md'), 'Handle #{number} on {branch}.');
    const d = new RuleDispatcher({}, {}, loadPromptTemplates(dir));
    const { actions } = await d.decide(
      ctx({
        issues: [{ id: 'i1', number: 12, title: 'T', body: 'B', state: 'open', labels: [], linkedPrNumber: null }],
      }),
    );
    assert.equal(actions[0]?.type, 'dispatch_code_agent');
    assert.equal((actions[0] as { prompt: string }).prompt, 'Handle #12 on issue/12.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
