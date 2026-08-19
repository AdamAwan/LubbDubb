import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugFilingType, filingType } from '../src/ticketTypes.js';
import { defaultConfig } from '../src/config.js';
import type { Config } from '../src/config.js';

/**
 * What type of work item the harness files.
 *
 * It used to be a `--type` flag rendered into the ticket coordinates for a filing
 * agent to choose within. Since #394 the harness makes the call itself, so the
 * question is no longer "does the prompt describe the list well enough" but "which
 * one does it pick" — and Azure refuses an untyped create outright, so there is no
 * answer that is allowed to be empty.
 */

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
  // The regression the types were introduced for: `--type Task` was hardcoded, so
  // every finding, blueprint and work-item filing landed at the altitude a story
  // is broken down at rather than the one a backlog is groomed at.
  assert.equal(filingType(azure({ issueFilingTypes: ['User Story', 'Tech Debt', 'Bug'] })), 'User Story');
  assert.equal(filingType(azure({ issueFilingTypes: ['Product Backlog Item', 'Bug'] })), 'Product Backlog Item');
});

test('an unset or empty list falls back to the default, never to no type at all', () => {
  // `[]` means "off" on `issueContainerTypes`; there is no off here, because a work
  // item is created *as* something and Azure refuses a create with no type.
  for (const config of [azure(), azure({ issueFilingTypes: [] }), azure({ issueFilingTypes: ['  ', ''] })]) {
    assert.equal(filingType(config), 'User Story');
  }
  assert.deepEqual(defaultConfig().issueFilingTypes, ['User Story', 'Bug']);
});

test('a raised bug files at its own key, not at a bug-looking entry in the list', () => {
  // What a process template calls its bug type is exactly the thing that varies —
  // the Basic process calls it "Issue" — so matching on the word would file a story
  // as a bug on the one project it is wrong for, with nothing red.
  assert.equal(bugFilingType(azure()), 'Bug');
  assert.equal(bugFilingType(azure({ issueBugType: 'Issue' })), 'Issue');
  // The list has no say in it, in either direction.
  assert.equal(bugFilingType(azure({ issueFilingTypes: ['Product Backlog Item'] })), 'Bug');
  assert.equal(filingType(azure({ issueBugType: 'Issue' })), 'User Story');
  // Blank is unset: an empty type is refused by Azure and takes the ticket with it.
  assert.equal(bugFilingType(azure({ issueBugType: '   ' })), 'Bug');
});

test('GitHub has no type to get wrong, and neither has an unconfigured provider', () => {
  assert.equal(filingType(github()), null);
  assert.equal(bugFilingType(github()), null);
  assert.equal(filingType({ integrations: { issues: 'fake' } } as unknown as Config), null);
  // `azure` selected with no `azureDevOps` block is the same nothing the routes
  // refuse and the cockpit hides its buttons on.
  assert.equal(bugFilingType({ integrations: { issues: 'azure' } } as unknown as Config), null);
});
