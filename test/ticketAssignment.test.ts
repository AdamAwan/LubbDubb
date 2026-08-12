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

function github(overrides: Record<string, unknown> = {}): Config {
  return {
    integrations: { issues: 'github', sourceControl: 'fake' },
    github: { owner: 'AdamAwan', repo: 'LubbDubb', ...overrides },
  } as unknown as Config;
}

function azure(overrides: Record<string, unknown> = {}): Config {
  return {
    integrations: { issues: 'azure', sourceControl: 'azure' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api', ...overrides },
  } as unknown as Config;
}

test('a configured assignee reaches both coordinate builders, in each provider’s own flag', () => {
  const gh = github({ defaultAssignee: 'adamawan' });
  assert.match(trackerCoordinates(gh)!, /gh issue create -R AdamAwan\/LubbDubb .*--assignee adamawan/);
  assert.match(bugTrackerCoordinates(gh, 12)!, /gh issue create .*--assignee adamawan/);

  // A UPN can carry characters a shell would eat, so Azure's value is quoted
  // where GitHub's login is not.
  const az = azure({ defaultAssignee: 'adam@contoso.com' });
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
  const text = bugTrackerCoordinates(azure({ defaultAssignee: 'adam@contoso.com' }), 12)!;
  assert.match(text, /--assigned-to "adam@contoso\.com"[\s\S]*relation add[\s\S]*--target-id 12/);
  assert.doesNotMatch(text, /relation add[^\n]*--assigned-to/, 'the relation command takes no assignee');

  const gh = bugTrackerCoordinates(github({ defaultAssignee: 'adamawan' }), 12)!;
  assert.match(gh, /#12/, 'the cross-reference that links the two is untouched');
});

test('an Azure deployment assigns to the identity it already filters on', () => {
  // Where the filter is set the harness surfaces only items assigned to that UPN,
  // so an item filed to anyone else is invisible to the harness that filed it.
  const filtered = azure({ filters: { workItemAssignedTo: 'bot@contoso.com' } });
  assert.equal(ticketAssignment(filtered)!.flag, ' --assigned-to "bot@contoso.com"');

  // An explicit assignee wins: the filter says what to *read*, and a deployment
  // that reads one queue and files into another is a real arrangement.
  const both = azure({ defaultAssignee: 'adam@contoso.com', filters: { workItemAssignedTo: 'bot@contoso.com' } });
  assert.equal(ticketAssignment(both)!.flag, ' --assigned-to "adam@contoso.com"');

  // GitHub has no equivalent to fall back to — `filters.prAuthor` is the account
  // the harness acts as, not the operator.
  assert.equal(ticketAssignment(github({ filters: { prAuthor: 'lubbdubb-bot' } })), null);
});

test('with nobody configured the coordinates read exactly as they did before', () => {
  const gh = github();
  assert.equal(ticketAssignment(gh), null);
  assert.doesNotMatch(trackerCoordinates(gh)!, /--assignee|Assign it to/);
  assert.doesNotMatch(bugTrackerCoordinates(gh, 12)!, /--assignee|Assign it to/);
  assert.doesNotMatch(trackerCoordinates(azure())!, /--assigned-to|Assign it to/);

  // A blank string is the same as unset: an empty flag value would fail the
  // create command outright, taking the ticket with it.
  assert.equal(ticketAssignment(github({ defaultAssignee: '  ' })), null);

  // No tracker at all, on the same predicate the routes refuse and the cockpit
  // hides its buttons on.
  assert.equal(ticketAssignment({ integrations: { issues: 'fake' } } as unknown as Config), null);
  assert.equal(ticketAssignment({ integrations: { issues: 'github' } } as unknown as Config), null);
});
