import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugTrackerCoordinates } from '../src/bugFiling.js';
import { trackerCoordinates } from '../src/mcp/findings.js';
import { ticketAssignment } from '../src/ticketAssignment.js';
import type { Config } from '../src/config.js';

/**
 * Who a filed ticket is assigned to.
 *
 * The property under test in every case below is the same one: the assignee
 * reaches the filing agent **through the tracker coordinates**, because those are
 * already rendered by all four filing templates while a new placeholder would be
 * dropped by every override that predates it. So the assertions are made against
 * the coordinate strings the routes hand to the prompt, not against a token.
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

test('a configured assignee reaches both coordinate builders, in each provider’s own flag', () => {
  const gh = github('adamawan');
  assert.match(trackerCoordinates(gh)!, /gh issue create -R AdamAwan\/LubbDubb .*--assignee adamawan/);
  assert.match(bugTrackerCoordinates(gh, 12)!, /gh issue create .*--assignee adamawan/);

  // A UPN can carry characters a shell would eat, so Azure's value is quoted
  // where GitHub's login is not.
  const az = azure('adam@contoso.com');
  assert.match(trackerCoordinates(az)!, /az boards work-item create .*--assigned-to "adam@contoso\.com"/);
  assert.match(bugTrackerCoordinates(az, 12)!, /--type Bug .*--assigned-to "adam@contoso\.com"/);

  // The flag alone is a thing an agent trims; the paragraph is what says it is
  // load-bearing, and it appears wherever the flag does.
  for (const text of [trackerCoordinates(gh)!, bugTrackerCoordinates(gh, 12)!, trackerCoordinates(az)!]) {
    assert.match(text, /not optional/);
    assert.match(text, /link an existing one instead[\s\S]*leave its assignee/);
  }
});

test('the bug relation still names the story once the assignee is spliced in', () => {
  // The two halves of the Azure bug coordinates are ordered — create, then relate
  // by the id the create returned — and the flag is spliced into the first of
  // them. Losing the second to a bad splice would leave an untraceable bug.
  const text = bugTrackerCoordinates(azure('adam@contoso.com'), 12)!;
  assert.match(text, /--assigned-to "adam@contoso\.com"[\s\S]*relation add[\s\S]*--target-id 12/);
  assert.doesNotMatch(text, /relation add[^\n]*--assigned-to/, 'the relation command takes no assignee');

  const gh = bugTrackerCoordinates(github('adamawan'), 12)!;
  assert.match(gh, /#12/, 'the cross-reference that links the two is untouched');
});

test('one identity answers both providers, in each one’s own flag spelling', () => {
  // `userId` replaced six keys that were this same fact spelled per provider and
  // per use — two `defaultAssignee`s, two `prAuthor`s, `workItemAssignedTo` and the
  // ownership switch — and could disagree with each other. What is left to differ
  // is the flag, which is the tracker's business and not the operator's.
  assert.equal(ticketAssignment(azure('adam@contoso.com'))!.flag, ' --assigned-to "adam@contoso.com"');
  assert.equal(ticketAssignment(github('adamawan'))!.flag, ' --assignee adamawan');

  // The same string reads as a UPN on Azure and a login on GitHub because one
  // project is worked at a time, and each project carries its own config file.
  assert.equal(ticketAssignment(azure('adamawan'))!.flag, ' --assigned-to "adamawan"');
});

test('with nobody configured the coordinates read exactly as they did before', () => {
  const gh = github();
  assert.equal(ticketAssignment(gh), null);
  assert.doesNotMatch(trackerCoordinates(gh)!, /--assignee|Assign it to/);
  assert.doesNotMatch(bugTrackerCoordinates(gh, 12)!, /--assignee|Assign it to/);
  assert.doesNotMatch(trackerCoordinates(azure())!, /--assigned-to|Assign it to/);

  // A blank string is the same as unset: an empty flag value would fail the
  // create command outright, taking the ticket with it.
  assert.equal(ticketAssignment(github('  ')), null);

  // No tracker at all, on the same predicate the routes refuse and the cockpit
  // hides its buttons on.
  assert.equal(ticketAssignment({ integrations: { issues: 'fake' } } as unknown as Config), null);
  assert.equal(ticketAssignment({ integrations: { issues: 'github' } } as unknown as Config), null);
});
