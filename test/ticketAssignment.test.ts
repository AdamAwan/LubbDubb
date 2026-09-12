import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketAssignee } from '../src/ticketAssignment.js';
import type { Config } from '../src/config/config.js';

function github(userId?: string): Config {
  return {
    integrations: { issues: 'github', sourceControl: 'fake' },
    github: { owner: 'AdamAwan', repo: 'LubbDubb' },
    ...(userId === undefined ? {} : { userId }),
  } as unknown as Config;
}

function azure(userId?: string): Config {
  return {
    integrations: { issues: 'azure', sourceControl: 'azure' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
    ...(userId === undefined ? {} : { userId }),
  } as unknown as Config;
}

test('one identity answers both providers', () => {
  assert.equal(ticketAssignee(azure('adam@contoso.com')), 'adam@contoso.com');
  assert.equal(ticketAssignee(github('adamawan')), 'adamawan');

  assert.equal(ticketAssignee(azure('adamawan')), 'adamawan');
});

test('with nobody configured a ticket still files, unassigned', () => {
  assert.equal(ticketAssignee(github()), null);
  assert.equal(ticketAssignee(azure()), null);

  assert.equal(ticketAssignee(github('  ')), null);

  assert.equal(ticketAssignee({ integrations: { issues: 'fake' } } as unknown as Config), null);
  assert.equal(ticketAssignee({ integrations: { issues: 'github' } } as unknown as Config), null);
});
