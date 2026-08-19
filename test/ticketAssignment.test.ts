import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketAssignee } from '../src/ticketAssignment.js';
import type { Config } from '../src/config.js';

/**
 * Who a filed ticket is assigned to.
 *
 * It used to reach the filing agent as a `--assignee` flag spliced into the
 * `gh`/`az` command in the ticket coordinates, plus a paragraph saying the flag
 * was not optional — three sentences whose whole job was surviving a model editing
 * the command down. Since #394 the harness files the item and passes this straight
 * to `createIssue`, so what is left to assert is the identity itself.
 */

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
  // `userId` replaced six keys that were this same fact spelled per provider and
  // per use — two `defaultAssignee`s, two `prAuthor`s, `workItemAssignedTo` and the
  // ownership switch — and could disagree with each other.
  assert.equal(ticketAssignee(azure('adam@contoso.com')), 'adam@contoso.com');
  assert.equal(ticketAssignee(github('adamawan')), 'adamawan');

  // The same string reads as a UPN on Azure and a login on GitHub because one
  // project is worked at a time, and each project carries its own config file.
  assert.equal(ticketAssignee(azure('adamawan')), 'adamawan');
});

test('with nobody configured a ticket still files, unassigned', () => {
  assert.equal(ticketAssignee(github()), null);
  assert.equal(ticketAssignee(azure()), null);

  // A blank string is the same as unset: an empty assignee is not an identity, and
  // a tracker asked to assign to one refuses the create and takes the ticket with it.
  assert.equal(ticketAssignee(github('  ')), null);

  // No tracker at all, on the same predicate the routes refuse and the cockpit
  // hides its buttons on.
  assert.equal(ticketAssignee({ integrations: { issues: 'fake' } } as unknown as Config), null);
  assert.equal(ticketAssignee({ integrations: { issues: 'github' } } as unknown as Config), null);
});
