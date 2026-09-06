import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugFilingType, filingType } from '../src/ticketTypes.js';
import { defaultConfig } from '../src/config.js';
import type { Config } from '../src/config.js';

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
