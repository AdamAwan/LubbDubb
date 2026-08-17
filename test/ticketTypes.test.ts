import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackerCoordinates } from '../src/mcp/findings.js';
import { bugTrackerCoordinates } from '../src/bugFiling.js';
import { ticketTypeGuidance } from '../src/ticketTypes.js';
import { defaultConfig } from '../src/config.js';
import type { Config } from '../src/config.js';

/**
 * What type of work item the three non-bug filing arms create.
 *
 * All of them — a deferred finding, a blueprint, unrecorded work — render the
 * same `trackerCoordinates` into their `{tracker}` placeholder, so the assertions
 * are made against that string rather than against a token of their own. That is
 * the point of putting the type there: an override that predates this change
 * still carries it.
 */

function azure(issueFilingTypes?: string[]): Config {
  return {
    integrations: { issues: 'azure', sourceControl: 'azure' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
    ...(issueFilingTypes === undefined ? {} : { issueFilingTypes }),
  } as unknown as Config;
}

function github(): Config {
  return {
    integrations: { issues: 'github', sourceControl: 'fake' },
    github: { owner: 'AdamAwan', repo: 'LubbDubb' },
  } as unknown as Config;
}

test('a filed Azure item is never a Task', () => {
  // The regression itself: `--type Task` was hardcoded, so every finding,
  // blueprint and work-item filing landed at the altitude a story is broken down
  // at rather than the one a backlog is groomed at.
  const coords = trackerCoordinates(azure(['User Story', 'Tech Debt', 'Bug']))!;
  assert.doesNotMatch(coords, /--type Task/);
  assert.match(coords, /--type "<type>"/);
  assert.match(coords, /"User Story", "Tech Debt", "Bug"/);

  // Naming the type it used to pick, because "choose the right one" does not
  // read to an agent as excluding the one it has always chosen.
  assert.match(coords, /do not file a Task/);
});

test('the list is closed, and an imperfect fit resolves inside it', () => {
  const coords = trackerCoordinates(azure(['User Story', 'Bug']))!;
  assert.match(coords, /closed set/);
  assert.match(coords, /file nothing outside it/);
  // An invented type is refused by Azure and takes the ticket with it, so the
  // instruction is to round to the nearest configured one and say so.
  assert.match(coords, /use the closest one and say so in the body/);
});

test('one configured type is spliced in literally, with no choice to make', () => {
  const coords = trackerCoordinates(azure(['Product Backlog Item']))!;
  assert.match(coords, /--type "Product Backlog Item"/);
  assert.doesNotMatch(coords, /<type>/);
  assert.match(coords, /only work item type this harness creates/);
});

test('an unset or empty list falls back to the default pair, never to no type at all', () => {
  // `[]` means "off" on `issueContainerTypes`; there is no off here, because a
  // work item is created *as* something and `az` refuses a create with no --type.
  for (const config of [azure(), azure([]), azure(['  ', ''])]) {
    const coords = trackerCoordinates(config)!;
    assert.match(coords, /--type "<type>"/);
    assert.match(coords, /"User Story", "Bug"/);
  }
  assert.deepEqual(defaultConfig().issueFilingTypes, ['User Story', 'Bug']);
});

test('GitHub coordinates are untouched — an issue has no type to get wrong', () => {
  const coords = trackerCoordinates(github())!;
  assert.doesNotMatch(coords, /--type|work item type/);
  assert.match(coords, /gh issue create -R AdamAwan\/LubbDubb/);
  assert.equal(ticketTypeGuidance(github()), null);

  // Nor the providers with no tracker at all, on the same predicate the routes
  // refuse and the cockpit hides its buttons on.
  assert.equal(ticketTypeGuidance({ integrations: { issues: 'fake' } } as unknown as Config), null);
  assert.equal(ticketTypeGuidance({ integrations: { issues: 'azure' } } as unknown as Config), null);
});

test('a raised bug still files as a Bug, on its own coordinates', () => {
  // The fourth filing arm does not consult the list: what an operator raising a
  // bug is filing is not in question, and its coordinates carry a relation
  // command the others have no equivalent of.
  assert.match(bugTrackerCoordinates(azure(['User Story', 'Bug']), 12)!, /--type Bug/);
});
