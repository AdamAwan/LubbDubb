import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugFilingType, chooseFilingType, filingType, knownFilingTypes } from '../src/tickets/ticketTypes.js';
import { ticketFiler } from '../src/tickets/filing.js';
import type { ActionSink, IssueCreateInput } from '../src/sink/actionSink.js';
import { defaultConfig } from '../src/config/config.js';
import type { Config } from '../src/config/config.js';

function azure(extra: Partial<Config> = {}): Config {
  return {
    integrations: { issues: 'azure', sourceControl: 'azure' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
    ...extra,
  } as unknown as Config;
}

function github(): Config {
  return {
    integrations: { issues: 'github', sourceControl: 'fake' },
    github: { owner: 'AdamAwan', repo: 'LubbDubb' },
  } as unknown as Config;
}

test('a filed Azure item is never a Task', () => {
  assert.equal(filingType(azure({ issueFilingTypes: ['User Story', 'Tech Debt', 'Bug'] })), 'User Story');
  assert.equal(filingType(azure({ issueFilingTypes: ['Product Backlog Item', 'Bug'] })), 'Product Backlog Item');
});

test('an unset or empty list falls back to the default, never to no type at all', () => {
  for (const config of [azure(), azure({ issueFilingTypes: [] }), azure({ issueFilingTypes: ['  ', ''] })]) {
    assert.equal(filingType(config), 'User Story');
  }
  assert.deepEqual(defaultConfig().issueFilingTypes, ['User Story', 'Bug']);
});

test('a raised bug files at its own key, not at a bug-looking entry in the list', () => {
  assert.equal(bugFilingType(azure()), 'Bug');
  assert.equal(bugFilingType(azure({ issueBugType: 'Issue' })), 'Issue');
  assert.equal(bugFilingType(azure({ issueFilingTypes: ['Product Backlog Item'] })), 'Bug');
  assert.equal(filingType(azure({ issueBugType: 'Issue' })), 'User Story');
  assert.equal(bugFilingType(azure({ issueBugType: '   ' })), 'Bug');
});

test('GitHub has no type to get wrong, and neither has an unconfigured provider', () => {
  assert.equal(filingType(github()), null);
  assert.equal(bugFilingType(github()), null);
  assert.equal(filingType({ integrations: { issues: 'fake' } } as unknown as Config), null);
  assert.equal(bugFilingType({ integrations: { issues: 'azure' } } as unknown as Config), null);
});

test('a filing may name its own type on Azure, and falls back to the head of the list', () => {
  assert.deepEqual(chooseFilingType(azure(), 'Tech Debt'), { ok: true, type: 'Tech Debt' });
  assert.deepEqual(chooseFilingType(azure(), null), { ok: true, type: 'User Story' });
});

test('a type on a tracker without types is refused, not dropped', () => {
  const chosen = chooseFilingType(github(), 'Bug');
  assert.equal(chosen.ok, false);
  assert.deepEqual(chooseFilingType(github(), null), { ok: true, type: null });
});

test('the known types are the filing list, the bug type and the containers, once each', () => {
  const config = azure({ issueFilingTypes: ['User Story', 'Tech Debt'], issueContainerTypes: ['Feature', 'Epic'] });
  assert.deepEqual(knownFilingTypes(config), ['User Story', 'Tech Debt', 'Bug', 'Feature', 'Epic']);
  assert.deepEqual(knownFilingTypes(github()), []);
});

test('the filer sends the named type to the tracker', async () => {
  const sent: IssueCreateInput[] = [];
  const sink = {
    createIssue: async (input: IssueCreateInput) => {
      sent.push(input);
      return { ok: true, ref: 'issue:7' };
    },
  } as unknown as ActionSink;
  const file = ticketFiler(azure(), sink);
  await file({ title: 'T', body: 'B', type: 'Interruption' });
  await file({ title: 'T', body: 'B' });
  assert.deepEqual(
    sent.map((i) => i.type),
    ['Interruption', 'User Story'],
  );
});
