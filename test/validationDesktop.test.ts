import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildApp } from '../src/server/app.js';
import type { McpChannelPayload } from '../src/wire.js';
import { shellArgv } from '../web/src/components/McpTab.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { DESKTOP_SKILL, installDesktopSkill } from '../src/validation/desktopSkill.js';
import { claimIsLive, claimStaleBefore, withLiveClaim } from '../src/validation/desktop.js';
import type { Issue, IssueDelivery, Plan, ValidationCheck } from '../src/types.js';

/**
 * The desktop channel: the operator's own Claude Code running a validation check
 * on a machine that can reach what the fleet cannot.
 *
 * Four properties carry the whole design, and each is asserted in both
 * directions because each has a plausible twin that would be wrong:
 *
 * 1. **The tool set is its own list.** Not a filtered view of the fleet's — this
 *    credential is long-lived and lives in a home directory, so the assertion is
 *    that no fleet tool is reachable at all.
 * 2. **One claim at a time, harness-wide.** The operator's own constraint: one
 *    working copy, so two things reaching for it is the failure. A second claim
 *    is refused by name; the same session re-claiming what it holds is not.
 * 3. **A claim blocks the fleet, and a dead claim does not.** A rule that
 *    dispatched under a live claim would put two readings on one check; one that
 *    honoured an expired claim would block a check from the fleet forever.
 * 4. **A reading is attributed to `desktop`.** Neither `operator` nor `agent` —
 *    nobody dispatched it and nobody carried the steps out by hand, and the whole
 *    feature exists so that a reader can tell those apart.
 */

const NOW = '2025-01-01T00:00:00.000Z';

/** The Windows path separator, spelled once — a literal backslash in a test string is a reading hazard. */
const BS = String.fromCharCode(92);

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desk-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      ...overrides,
    }),
    {
      // Without this the suite cuts a real branch in whatever checkout it is
      // running in — see CLAUDE.md. Nothing here is about git behaviour.
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

/** A live desktop server on throwaway paths — never the operator's real home directory. */
async function desk(
  system: System,
  over: Partial<{ claimMinutes: number; now: () => string; socketPath: string }> = {},
): Promise<{ server: McpDesktopServer; dir: string; socketPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-cred-'));
  const socketPath = over.socketPath ?? throwawaySocketPath();
  const server = new McpDesktopServer({
    store: system.store,
    claimMinutes: over.claimMinutes ?? 60,
    validationRoot: '/srv/validation',
    now: over.now ?? ((): string => new Date().toISOString()),
    socketPath,
    credentialPath: join(dir, 'desktop.json'),
    requirePlanApproval: true,
    proposals: () => system.proposals,
    runCycle: () => system.harness.runCycle('manual').then(() => undefined),
  });
  assert.ok(await server.listen(), 'the desktop channel starts on a throwaway path');
  return { server, dir, socketPath };
}

/**
 * A socket path nothing else on this machine owns.
 *
 * A named pipe on Windows, where a filesystem path is not bindable at all — the
 * channel short-circuits on `\\` and everything else refuses with EACCES.
 * Unique either way, so a test can never take the socket of a harness the
 * operator is actually running: `exclusive` is on, and that would be a refusal
 * rather than a theft, but it would also be a test that failed for a reason
 * outside itself.
 */
function throwawaySocketPath(): string {
  const unique = randomUUID();
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\lubbdubb-test-${unique}`
    : join(mkdtempSync(join(tmpdir(), 'lubbdubb-sock-')), `${unique}.sock`);
}

const CHECKS = [
  {
    id: 'csv-opens',
    title: 'The export opens in Excel',
    do: 'Export a report and open it.',
    expect: 'It opens with the columns intact.',
  },
  {
    id: 'chip-on-mobile',
    title: 'The chip is reachable at 380px',
    do: 'Open the goal at 380px and tap the chip.',
    expect: 'It is hittable.',
  },
];

function planWith(system: System, checks: Record<string, unknown>[] = CHECKS): string {
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    validation: { checks },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: 'issue:12', title: 'Ship it' });
  // The **goal**, which is what the checks are keyed on — the plan id is not a
  // handle anything about validation takes any more.
  return 'issue:12';
}

async function call(
  server: McpDesktopServer,
  connectionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; json: () => Record<string, unknown> }> {
  const session = server.session(connectionId);
  assert.ok(session, 'a listening desktop channel hands out sessions');
  const result = (await session.call(name, args)) as ToolResultText;
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

function byId(system: System, goal: string, id: string): ValidationCheck {
  const found = system.store.listValidationChecks(goal).find((c) => c.id === id);
  assert.ok(found, `check ${id} exists`);
  return found;
}

// -- the tool surface --------------------------------------------------------

test('a desktop session gets its own tools and none of the fleet’s', async () => {
  const system = build();
  const { server } = await desk(system);
  try {
    const session = server.session('c1');
    assert.ok(session);
    const names = await session.list();
    assert.deepEqual(names.sort(), [...DESKTOP_TOOL_NAMES].sort());

    // The assertion that matters: this credential is long-lived and sits in a
    // home directory, so the question is not "is the list short" but "can it
    // reach the harness at all". Every fleet-only tool, by name.
    for (const fleetOnly of MCP_TOOL_NAMES.filter((n) => !DESKTOP_TOOL_NAMES.some((d) => d === n))) {
      assert.ok(!names.includes(fleetOnly), `${fleetOnly} is not reachable from a desktop session`);
      const refused = await call(server, 'c1', fleetOnly, {});
      assert.ok(refused.isError, `${fleetOnly} is refused, not silently accepted`);
    }
  } finally {
    await server.close();
    system.store.close();
  }
});

test('the credential is 0600, carries no configured secret, and dies with the channel', async () => {
  const system = build();
  const { server, dir, socketPath } = await desk(system);
  const path = join(dir, 'desktop.json');
  try {
    const stat = statSync(path);
    // The token is a bearer credential for write access to the store. The file is
    // the whole reason it never has to appear in the registration an operator pastes.
    assert.equal(stat.mode & 0o777, 0o600);
    const credential = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(credential.lubbdubb, 1);
    assert.equal(typeof credential.token, 'string');
    // Read back from the helper rather than rebuilt here: the path is chosen per
    // platform (a named pipe on Windows), and a second guess at it would assert
    // the test's arithmetic instead of what the channel actually wrote.
    assert.equal(credential.socket, socketPath);

    // Minted, never configured — the registration is a fixed command line with
    // the bridge on it and nothing else.
    const registration = server.registration();
    assert.ok(registration.args.some((a) => a.endsWith('bridge.mjs')));
    assert.ok(registration.args.includes('--desktop'));
    assert.ok(!registration.args.some((a) => a === credential.token));
  } finally {
    await server.close();
    system.store.close();
  }
  assert.throws(() => statSync(path), 'the credential goes when the channel does');
});

test('two harnesses do not fight over the stable socket', async () => {
  const system = build();
  const { server, dir, socketPath } = await desk(system);
  const second = new McpDesktopServer({
    store: system.store,
    claimMinutes: 60,
    validationRoot: '/srv/validation',
    now: () => NOW,
    socketPath,
    credentialPath: join(dir, 'second.json'),
    proposals: () => system.proposals,
    runCycle: () => system.harness.runCycle('manual').then(() => undefined),
  });
  try {
    // The fleet socket carries a pid and unlinks whatever it finds. This one is
    // stable so the MCP registration can be added once — which means a live
    // socket on it is another harness's, and taking it would silently steal every
    // future desktop session from a running process.
    assert.equal(await second.listen(), false);
    assert.ok(server.session('c1'), 'the first is untouched');
  } finally {
    await second.close();
    await server.close();
    system.store.close();
  }
});

// -- reading a plan ----------------------------------------------------------

test('validation_read hands back the whole plan, or one check’s full procedure', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
    const all = await call(server, 'c1', 'validation_read', { issue: 12 });
    assert.ok(!all.isError, all.text);
    const checks = all.json().checks as { letter: string; id: string }[];
    assert.deepEqual(
      checks.map((c) => c.letter),
      ['A', 'B'],
    );
    // Where the fixtures live. A session told to run a check and not told where
    // its fixture is has to guess, and guessing is how a check gets reported as
    // run when it was not.
    assert.equal(all.json().resourceRoot, '/srv/validation/issue-12');

    // The letter is what a person reads off the plan sheet and types after the
    // colon in `284:C`; the id is what the row is keyed on. Both resolve.
    const byLetter = await call(server, 'c1', 'validation_read', { issue: 12, check: 'a' });
    const byIdent = await call(server, 'c1', 'validation_read', { issue: 12, check: 'csv-opens' });
    assert.equal((byLetter.json().check as { id: string }).id, 'csv-opens');
    assert.equal((byIdent.json().check as { id: string }).id, 'csv-opens');
    assert.match(byLetter.json().procedure as string, /Export a report and open it\./);
    assert.match(byLetter.json().procedure as string, /It opens with the columns intact\./);

    const missing = await call(server, 'c1', 'validation_read', { issue: 12, check: 'Z' });
    assert.ok(missing.isError);
    assert.match(missing.text, /no live check "Z"/);
    assert.equal(byId(system, planId, 'csv-opens').state, 'unrun', 'reading records nothing');
  } finally {
    await server.close();
    system.store.close();
  }
});

test('one check is claimed at a time, and the refusal names what holds it', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
    const first = await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A', as: 'studio' });
    assert.ok(!first.isError, first.text);
    assert.equal(first.json().claimed, 'A. csv-opens');
    assert.equal(byId(system, planId, 'csv-opens').claimedBy, 'studio');
    // The procedure comes back with the claim, so a session never has to make a
    // second call to learn what it just took on.
    assert.match(first.json().procedure as string, /Export a report and open it\./);

    // The operator's own constraint, in their words: one branch at a time, and
    // two things reaching for it is the failure. A per-check lock would have
    // allowed this.
    const second = await call(server, 'c2', 'validation_claim', { issue: 12, check: 'B' });
    assert.ok(second.isError);
    assert.match(second.text, /already claimed by studio/);
    assert.match(second.text, /only one check can be claimed at a time/);
    assert.equal(byId(system, planId, 'chip-on-mobile').claimedBy, null);

    // Re-taking what you already hold is not a conflict — a bridge that
    // reconnected mid-run would otherwise be locked out by its own claim.
    const again = await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A', as: 'studio' });
    assert.ok(!again.isError, again.text);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('a settled check is not claimable — a reading is somebody’s answer', async () => {
  const system = build();
  const planId = planWith(system);
  system.store.recordValidationResult(planId, 'csv-opens', { state: 'passed', note: 'ran it', by: 'operator' });
  const { server } = await desk(system);
  try {
    const refused = await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A' });
    assert.ok(refused.isError);
    assert.match(refused.text, /already reads "passed"/);
    assert.match(refused.text, /reset it in the cockpit first/);
    assert.equal(byId(system, planId, 'csv-opens').resultBy, 'operator', 'the operator’s reading is untouched');
  } finally {
    await server.close();
    system.store.close();
  }
});

test('a claim is released when the session ends, and expires if the harness never sees that', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
    await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A' });
    assert.notEqual(byId(system, planId, 'csv-opens').claimedBy, null);

    // Closing the terminal is how a desktop run normally ends. `end()` is what
    // the socket's close handler calls, so this is the production path.
    server.session('c1')?.end();
    assert.equal(byId(system, planId, 'csv-opens').claimedBy, null);

    // The case no close can cover: a harness killed between the claim and the
    // release. Without an expiry the check is blocked from the fleet forever and
    // there is no way back short of editing the database.
    await call(server, 'c2', 'validation_claim', { issue: 12, check: 'A' });
    const held = byId(system, planId, 'csv-opens');
    const later = new Date(new Date(held.claimedAt ?? NOW).getTime() + 61 * 60_000).toISOString();
    assert.ok(claimIsLive(held, held.claimedAt ?? NOW, 60), 'live the moment it is taken');
    assert.ok(!claimIsLive(held, later, 60), 'and dead an hour later');
  } finally {
    await server.close();
    system.store.close();
  }
});

// -- reporting ---------------------------------------------------------------

test('a report goes against the claim, and there is no reporting without one', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
    // The fence, in the shape the fleet's takes from its origin: which check a
    // report is about is settled before the report rather than by it.
    const unclaimed = await call(server, 'c1', 'validation_report', { result: 'passed', note: 'looks right' });
    assert.ok(unclaimed.isError);
    assert.match(unclaimed.text, /have not claimed a check/);
    assert.match(unclaimed.text, /validation_claim/, 'refused by name, pointed at the tool it wants');

    await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A' });
    const blank = await call(server, 'c1', 'validation_report', { result: 'passed' });
    assert.ok(blank.isError);
    assert.match(blank.text, /note is required/);

    const reported = await call(server, 'c1', 'validation_report', {
      result: 'passed',
      note: 'Exported Q3, opened in Excel 2019, all eleven columns intact.',
    });
    assert.ok(!reported.isError, reported.text);
    const after = byId(system, planId, 'csv-opens');
    assert.equal(after.state, 'passed');
    // Neither `operator` nor `agent`. Nobody dispatched this and nobody carried
    // the steps out by hand, and a reader deciding whether to re-run a check
    // before closing a goal is deciding on exactly that difference.
    assert.equal(after.resultBy, 'desktop');
    assert.equal(after.claimedBy, null, 'the reading is in, so the run is over');

    // One reading per claim: the claim is spent, so a second report has nothing
    // to be about rather than silently overwriting the first.
    const twice = await call(server, 'c1', 'validation_report', { result: 'failed', note: 'changed my mind' });
    assert.ok(twice.isError);
    assert.equal(byId(system, planId, 'csv-opens').state, 'passed');
  } finally {
    await server.close();
    system.store.close();
  }
});

test('a hand-back records no reading and gives the check back with its reason', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
    await call(server, 'c1', 'validation_claim', { issue: 12, check: 'B' });
    const handed = await call(server, 'c1', 'validation_report', {
      result: 'handback',
      note: 'the staging login expired and I have no way to renew it from here',
    });
    assert.ok(!handed.isError, handed.text);
    assert.equal(handed.json().reported, 'handback');
    // Said out loud rather than left to be inferred from a bare "ok": a session
    // told only that the call succeeded would believe it had settled the check.
    assert.equal(handed.json().state, 'unrun');

    const after = byId(system, planId, 'chip-on-mobile');
    // The whole reason there are three answers. This session learned nothing
    // about the goal, and `failed` would have flagged it for something that is
    // not about the code.
    assert.equal(after.state, 'unrun');
    assert.equal(after.resultBy, null);
    assert.equal(after.claimedBy, null);
    assert.match(after.handbackNote ?? '', /A desktop session could not run this check/);
    assert.match(after.handbackNote ?? '', /staging login expired/);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('an amendment that withdraws a claimed check ends the run rather than half-recording it', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
    await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A' });
    system.store.amendValidation(planId, {
      note: 'the export screen was removed',
      checks: [],
      withdraw: [{ id: 'csv-opens', reason: 'there is no export screen any more' }],
      resources: [],
    });
    const reported = await call(server, 'c1', 'validation_report', { result: 'passed', note: 'it opened' });
    assert.ok(reported.isError);
    assert.match(reported.text, /no longer part of its plan/);
    assert.equal(byId(system, planId, 'csv-opens').state, 'unrun', 'nothing was written to a withdrawn check');
  } finally {
    await server.close();
    system.store.close();
  }
});

// -- the fleet gate ----------------------------------------------------------

function issue(): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
}

function delivered(): IssueDelivery {
  return {
    originRef: 'issue:12',
    summary: 'every part merged',
    detail: null,
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: NOW,
    updatedAt: NOW,
  };
}

function plan(): Plan {
  return {
    id: 'plan-12',
    originRef: 'issue:12',
    title: 'Ship it',
    status: 'active',
    reason: 'One fix.',
    diagnosis: null,
    approach: null,
    alternatives: null,
    openQuestions: null,
    risks: null,
    outOfScope: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function handedOver(over: Partial<ValidationCheck> = {}): ValidationCheck {
  return {
    originRef: 'issue:12',
    id: 'csv-opens',
    letter: 'A',
    seq: 1,
    title: 'The export opens in Excel',
    do: 'Export a report and open it.',
    expect: 'It opens with the columns intact.',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'fleet',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function ctx(checks: ValidationCheck[]): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    plans: [plan()],
    deliveries: [delivered()],
    validationChecks: checks,
  };
}

function runner(): RuleDispatcher {
  return new RuleDispatcher({}, {}, undefined, 'main', {}, {}, { desktopClaimMinutes: 60 }, '/srv/validation');
}

function validateDispatches(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.includes(':validate:'));
}

test('the fleet does not run a check somebody is holding, and does run one whose claim died', async () => {
  // Relative to the world's own timestamp, which is the clock the dispatcher
  // reads — a claim stamped from the wall clock would read as live forever.
  const fresh = new Date(new Date(NOW).getTime() - 60_000).toISOString();
  const held = await runner().decide(ctx([handedOver({ claimedBy: 'desktop (studio)', claimedAt: fresh })]));
  // Two things in one environment against one procedure, the second reading
  // overwriting the first, and neither knowing the other existed.
  assert.deepEqual(validateDispatches(held.actions), [], 'a live claim holds the fleet off');

  const stale = new Date(new Date(NOW).getTime() - 61 * 60_000).toISOString();
  const expired = await runner().decide(ctx([handedOver({ claimedBy: 'desktop (studio)', claimedAt: stale })]));
  // Read through the same helper the tools use. A rule with its own opinion about
  // expiry would either block a check forever or dispatch under a live session.
  assert.deepEqual(
    validateDispatches(expired.actions),
    ['issue:12:validate:csv-opens'],
    'a claim whose session died blocks nothing',
  );
});

test('a rewording releases the claim with the hand-over and the reading', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
    await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A' });
    system.store.amendValidation(planId, {
      note: 'the export is a download now, not a file on disk',
      checks: [
        {
          id: 'csv-opens',
          title: 'The export downloads and opens in Excel',
          do: 'Click Export and open the downloaded file.',
          expect: 'It opens with the columns intact.',
          uses: [],
          covers: [],
          fleetCandidate: false,
          candidateWhy: null,
        },
      ],
      withdraw: [],
      resources: [],
    });
    // One predicate, not two: somebody is running this against wording that no
    // longer exists, and the amendment band is now in front of the operator.
    const after = byId(system, planId, 'csv-opens');
    assert.equal(after.claimedBy, null);
    assert.equal(after.actor, 'human');
    assert.notEqual(after.amendedAt, null);
  } finally {
    await server.close();
    system.store.close();
  }
});

// -- the skill ---------------------------------------------------------------

test('the skill installs, and says what it is for without restating the procedure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-skill-'));
  const path = join(dir, 'skills', 'lubbdubb', 'SKILL.md');
  assert.ok(installDesktopSkill(path));
  const written = readFileSync(path, 'utf8');
  assert.equal(written, DESKTOP_SKILL);
  // The front matter is what makes it `/lubbdubb`, and the three tools are what
  // it tells the session to call. Everything about *how* to run a given check
  // comes back from those calls — a skill that restated any of it would be a
  // second copy of the procedure, drifting.
  assert.match(written, /^---\nname: lubbdubb\n/);
  for (const tool of DESKTOP_TOOL_NAMES) assert.match(written, new RegExp(tool));
  // The three answers, and the one that is easiest to leave out.
  assert.match(written, /handback/);
  assert.match(written, /Do not report `passed` from evidence you did not gather/);
  // The managed-by comment is the one thing in the body about the file itself, so
  // it is the one thing that goes stale silently: it used to name a switch that
  // kept a local copy, and there is no such switch — the channel is unconditional
  // and every start overwrites this file. An operator reading it must be told that
  // rather than pointed at a setting the loader refuses.
  assert.match(written, /rewritten from scratch every time the harness starts/);
  assert.doesNotMatch(written, /desktopSkill\b/);
});

/**
 * What the cockpit is shipped, and why it is a projection rather than the row.
 *
 * `claimIsLive` is the single definition of "claimed", so a claim past its expiry
 * has to stop being drawn at the same instant it stops blocking `validate-check`.
 * Otherwise the fleet list shows somebody running a check the rule has already
 * decided nobody is running — two answers to one question, which is the whole
 * thing one definition exists to prevent.
 */
test('the snapshot ships a live claim, and `withLiveClaim` drops an expired one', () => {
  const system = build();
  const goal = planWith(system);
  const now = new Date().toISOString();
  system.store.claimValidationCheck(goal, 'csv-opens', 'desktop (studio)', claimStaleBefore(now, 60));

  const shipped = buildStateSnapshot(system).validationChecks.find((c) => c.id === 'csv-opens')!;
  assert.equal(shipped.claimedBy, 'desktop (studio)', 'a live claim reaches the cockpit');

  // The other arm, at the function the snapshot maps every check through: the row
  // still carries the label an hour later, and what the cockpit is handed does not.
  const later = new Date(new Date(shipped.claimedAt ?? now).getTime() + 61 * 60_000).toISOString();
  const expired = withLiveClaim(shipped, later, 60);
  assert.equal(expired.claimedBy, null, 'and an expired one is not drawn at all');
  assert.equal(expired.claimedAt, null, 'neither half, so nothing can read a claim back out of it');
  system.store.close();
});

/**
 * What the cockpit's MCP tab hands an operator.
 *
 * The tab is the only place the one manual step in this whole channel is written
 * down where somebody looks for it, and every way of getting it wrong is silent:
 * a registration naming the fleet bridge connects and refuses every call, a
 * hand-written tool list describes a channel that has since changed, and an
 * unquoted Windows path registers a server called `C:\Program`. So the payload is
 * asserted against the channel it describes rather than against a fixture.
 */
test('/api/mcp describes the desktop channel it is read from', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const payload = (await (await app.inject({ method: 'GET', url: '/api/mcp' })).json()) as McpChannelPayload;

  // Exactly the desktop three, in the order `tools/list` gives them, each with the
  // description an operator reads. A fleet tool here would mean the tab was
  // describing `buildTools` — the one thing this channel is narrowed against.
  assert.deepEqual(
    payload.tools.map((t) => t.name),
    [...DESKTOP_TOOL_NAMES],
  );
  for (const tool of payload.tools) assert.ok(tool.description.length > 0, `${tool.name} says what it is for`);

  // The `--desktop` flag is what makes the bridge read the credential file rather
  // than a launch config, so a registration without it is a command that connects
  // to nothing.
  assert.equal(payload.serverId, 'lubbdubb');
  assert.equal(payload.registration.args.at(-1), '--desktop');
  assert.match(payload.registration.args[0] ?? '', /bridge\.mjs$/);
  assert.equal(payload.credentialPath, system.desktop.credentialPath());

  // Nothing called `listen()` on this system's channel, and the tab says so
  // instead of handing over a command that would reach nothing.
  assert.equal(payload.running, false);

  await app.close();
  system.store.close();
});

test('the channel reports itself running only while it is listening', async () => {
  const system = build();
  assert.equal(system.desktop.running(), false, 'a constructed channel is inert until it binds');
  const { server } = await desk(system);
  assert.equal(server.running(), true);
  await server.close();
  assert.equal(server.running(), false, 'a closed channel stops advertising a credential it has removed');
  system.store.close();
});

/**
 * Windows is the case this exists for and it is not hypothetical: `process.execPath`
 * is routinely `C:\Program Files\nodejs\node.exe`, and unquoted that line registers
 * a server called `C:\Program` — which succeeds, and fails later as a channel that
 * will not connect.
 */
test('the registration command quotes a path with spaces', () => {
  const windows = shellArgv([
    'C:' + BS + 'Program Files' + BS + 'nodejs' + BS + 'node.exe',
    'C:' + BS + 'lubbdubb' + BS + 'bridge.mjs',
    '--desktop',
  ]);
  assert.ok(windows.startsWith('"C:' + BS + 'Program Files'), 'the interpreter path is quoted whole');
  assert.ok(windows.endsWith('bridge.mjs --desktop'), 'nothing without a space is quoted');
  assert.equal(
    shellArgv(['/usr/bin/node', '/srv/lubbdubb/bridge.mjs', '--desktop']),
    '/usr/bin/node /srv/lubbdubb/bridge.mjs --desktop',
  );
});
