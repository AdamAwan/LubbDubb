import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config/config.js';
import { buildDesktopTools } from '../src/mcp/desktopTools.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { DESKTOP_SKILL } from '../src/validation/desktopSkill.js';
import { featurePrompt } from '../web/src/cockpit/desktopLink.js';
import { repoText } from './support/paths.js';
import type { Issue, IssueRelative } from '../src/types.js';

const NOW = '2026-09-28T12:00:00.000Z';

const FEATURE: IssueRelative = {
  number: 500,
  title: 'Export',
  issueType: 'Feature',
  workItemState: 'Active',
  state: 'open',
  body: 'Let people get their data out.',
};

function item(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: 'do the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'User Story',
    parent: FEATURE,
    ...over,
  };
}

function deck(): {
  call: (args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;
  store: Store;
} {
  const store = new Store(':memory:');
  store.world.setWorldBaseline({
    takenAt: NOW,
    pullRequests: [],
    issues: [item(500, { title: 'Export', issueType: 'Feature', parent: null }), item(11), item(12)],
  });
  const deps = {
    store,
    briefConfig: () => loadConfig({ dbPath: ':memory:' }),
  } as unknown as Parameters<typeof buildDesktopTools>[0];
  const tool = buildDesktopTools(deps, { label: 'adam', held: null }).find((t) => t.name === 'feature_read');
  assert.ok(tool, 'feature_read is on the desktop channel');
  return {
    store,
    call: async (args) => {
      const result = await tool.handler(args);
      return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
    },
  };
}

test('feature_read is a desktop tool and not one the fleet can call', () => {
  assert.ok(DESKTOP_TOOL_NAMES.includes('feature_read'));
  assert.ok(!MCP_TOOL_NAMES.includes('feature_read' as never));
});

test('a story number resolves to its Feature, and every story comes back', async () => {
  const d = deck();
  const read = await d.call({ issue: 12 });
  assert.equal(read.isError, false, read.text);
  const json = JSON.parse(read.text) as {
    feature: { number: number; title: string };
    summary: unknown;
    stories: { number: number }[];
  };
  assert.equal(json.feature.number, 500);
  assert.equal(json.feature.title, 'Export');
  assert.deepEqual(
    json.stories.map((s) => s.number),
    [11, 12],
  );
  assert.equal(json.summary, null, 'no summary is passed through as none, never composed');
});

test("the summariser's account is passed through as written", async () => {
  const d = deck();
  d.store.tickets.recordFeatureSummary({
    originRef: 'issue:500',
    headline: 'back end done',
    standing: 'The API is in; the UI is not.',
    usable: null,
    blocked: null,
    remaining: 'the UI',
    standingKey: 'k',
    agentId: 'a',
    taskId: 't',
  });
  const json = JSON.parse((await d.call({ issue: 500 })).text) as { summary: { standing: string } };
  assert.equal(json.summary.standing, 'The API is in; the UI is not.');
});

test('a number with no stories under it is refused', async () => {
  const read = await deck().call({ issue: 4242 });
  assert.equal(read.isError, true);
});

test('the skill and the cockpit name the same command', () => {
  assert.equal(featurePrompt(500), '/lubbdubb feature 500 ');
  assert.match(DESKTOP_SKILL, /## Talk about a feature/);
  assert.match(DESKTOP_SKILL, /feature_read/);
  assert.match(repoText('web/src/components/FeatureBoard.tsx'), /prompt=\{featurePrompt\(number\)\}/);
});
