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
    'GitHub issue #3 ("Bug") needs resolving.\n\nIt breaks\n\nImplement the fix on branch issue/3 and open a pull request that closes this issue.',
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

function ctx(world: Partial<WorldSnapshot>): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], stories: [], calendar: [], ...world },
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
