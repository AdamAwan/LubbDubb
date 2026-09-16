import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';
import { buildDesktopTools } from '../src/mcp/desktopTools.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { ticketFilingTarget } from '../src/tickets/target.js';
import { DESKTOP_SKILL } from '../src/validation/desktopSkill.js';

const GITHUB = {
  integrations: { issues: 'github', sourceControl: 'github', pullRequests: 'github' },
  github: { owner: 'acme', repo: 'widgets' },
} as never;

function config(overrides: Record<string, unknown> = {}): ReturnType<typeof loadConfig> {
  return loadConfig({ dbPath: ':memory:', ...overrides });
}

test('the target names the tracker the harness reads issues from, not the checkout', () => {
  const target = ticketFilingTarget(config({ ...(GITHUB as object), labelPrefix: 'ldb' }));
  assert.equal(target.tracker, 'the GitHub repository acme/widgets');
  assert.equal(target.canFile, true);
  assert.equal(target.watchLabel, 'ldb-watch');
  assert.deepEqual(target.blockers, []);
});

test('no tracker is a blocker, so nothing is drafted for a deployment that cannot file', () => {
  const target = ticketFilingTarget(config({ labelPrefix: 'ldb' }));
  assert.equal(target.tracker, null);
  assert.equal(target.canFile, false);
  assert.equal(target.blockers.length, 1);
});

test('an own-label gate is a caution, because a hand-added tag reads as unwatched', () => {
  const target = ticketFilingTarget(
    config({ ...(GITHUB as object), labelPrefix: 'ldb', userId: 'adam', ownWorkOnly: true }),
  );
  assert.equal(target.labelAuthorship, 'own');
  assert.equal(target.assignee, 'adam');
  assert.ok(
    target.cautions.some((c) => c.includes('adam') && c.includes('job_create')),
    'the caution names who has to have added it and what files it under them',
  );
});

test('a label prefix of nothing cautions rather than promising a tag it will not write', () => {
  const target = ticketFilingTarget(config({ ...(GITHUB as object), labelPrefix: '' }));
  assert.equal(target.watchLabel, null);
  assert.ok(target.cautions.some((c) => c.includes('labelPrefix')));
});

test('pickup states are a caution — a filed item outside them waits for a person', () => {
  const target = ticketFilingTarget(
    config({ ...(GITHUB as object), labelPrefix: 'ldb', issuePickupStates: ['New', 'Active'] }),
  );
  assert.deepEqual(target.pickupStates, ['New', 'Active']);
  assert.ok(target.cautions.some((c) => c.includes('"New"')));
});

test('ticket_target is on the desktop channel, is not one the fleet can call, and records nothing', async () => {
  assert.ok(DESKTOP_TOOL_NAMES.includes('ticket_target'));
  assert.ok(!(MCP_TOOL_NAMES as readonly string[]).includes('ticket_target'));

  const deps = {
    briefConfig: () => config({ ...(GITHUB as object), labelPrefix: 'ldb' }),
  } as unknown as Parameters<typeof buildDesktopTools>[0];
  const tool = buildDesktopTools(deps, { label: 'adam', held: null }).find((t) => t.name === 'ticket_target');
  assert.ok(tool);
  const result = await tool.handler({});
  assert.notEqual(result.isError, true);
  const answer = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  assert.equal(answer.tracker, 'the GitHub repository acme/widgets');
  assert.equal(answer.watchLabel, 'ldb-watch');
  assert.match(String(answer.next), /job_create/);
});

test('the skill sends the filing job at ticket_target first and at job_create to file', () => {
  assert.match(DESKTOP_SKILL, /## File a ticket/);
  assert.match(DESKTOP_SKILL, /What a ticket has to say/);
  const filing = DESKTOP_SKILL.slice(DESKTOP_SKILL.indexOf('## File a ticket'), DESKTOP_SKILL.indexOf('## Clarify'));
  assert.ok(filing.indexOf('ticket_target') < filing.indexOf('job_create'), 'the read comes before the write');
  assert.match(filing, /gh issue create/, 'and it names the command it must not reach for');
});
