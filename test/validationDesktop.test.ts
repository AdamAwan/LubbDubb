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
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { desktopDeps } from './support/desktop.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { DESKTOP_SKILL, installDesktopSkill } from '../src/validation/desktopSkill.js';
import { retroDossier } from '../src/retro/dossier.js';
import { goalRecord } from '../src/retro/record.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import { claimIsLive, claimStaleBefore, withLiveClaim } from '../src/validation/desktop.js';
import type { Issue, IssueDelivery, Plan, ValidationCheck, WorldSnapshot } from '../src/types.js';

const NOW = '2025-01-01T00:00:00.000Z';

const BS = String.fromCharCode(92);

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desk-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
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
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

async function desk(
  system: System,
  over: Partial<{
    claimMinutes: number;
    now: () => string;
    socketPath: string;
  }> = {},
  environments: EnvironmentConfig[] = [],
): Promise<{ server: McpDesktopServer; dir: string; socketPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-cred-'));
  const socketPath = over.socketPath ?? throwawaySocketPath();
  const server = new McpDesktopServer({
    ...desktopDeps(system),
    claimMinutes: over.claimMinutes ?? 60,
    environments,
    now: over.now ?? ((): string => new Date().toISOString()),
    socketPath,
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await server.listen(), 'the desktop channel starts on a throwaway path');
  return { server, dir, socketPath };
}

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
  const found = system.store.validation.listValidationChecks(goal).find((c) => c.id === id);
  assert.ok(found, `check ${id} exists`);
  return found;
}

test('a desktop session gets its own tools and none of the fleet’s', async () => {
  const system = build();
  const { server } = await desk(system);
  try {
    const session = server.session('c1');
    assert.ok(session);
    const names = await session.list();
    assert.deepEqual(names.sort(), [...DESKTOP_TOOL_NAMES].sort());

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
    assert.equal(stat.mode & 0o777, 0o600);
    const credential = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(credential.lubbdubb, 1);
    assert.equal(typeof credential.token, 'string');
    assert.equal(credential.socket, socketPath);

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
    ...desktopDeps(system),
    now: () => NOW,
    socketPath,
    credentialPath: join(dir, 'second.json'),
  });
  try {
    assert.equal(await second.listen(), false);
    assert.ok(server.session('c1'), 'the first is untouched');
  } finally {
    await second.close();
    await server.close();
    system.store.close();
  }
});

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
    assert.equal(all.json().resourceRoot, '/srv/validation/issue-12');

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

test('local_run starts the environment on a goal, and reports what it knows', async () => {
  const system = build({ localRun: { instruction: 'Run the dev server.', url: 'http://localhost:4200' } });
  planWith(system);
  const { server } = await desk(system);
  try {
    const idle = await call(server, 'c1', 'local_run', {});
    assert.ok(!idle.isError, idle.text);
    assert.equal(idle.json().running, false);

    const started = await call(server, 'c1', 'local_run', { issue: 12 });
    assert.ok(!started.isError, started.text);
    assert.equal(started.json().running, true);
    assert.equal(started.json().goal, 'issue:12');
    assert.equal(started.json().url, 'http://localhost:4200');
    assert.equal(started.json().turn, 'start');
    assert.equal(typeof started.json().commit, 'string');
    assert.equal(started.json().holdsSession, true);
    assert.equal(started.json().ports, null);
    assert.equal(started.json().freshness, null);
    assert.match(started.json().caveat as string, /does not exercise the application/);

    const live = system.store.localRuns.liveLocalRun();
    assert.equal(live?.originRef, 'issue:12');
    assert.ok(live !== null && live.dir !== '');
  } finally {
    await server.close();
    system.store.close();
  }
});

test('local_run relays a message to the running environment, and refuses the cases with nobody to tell', async () => {
  const system = build({ localRun: { instruction: 'Run the dev server.', url: '' } });
  planWith(system);
  const { server } = await desk(system);
  try {
    const both = await call(server, 'c1', 'local_run', { issue: 12, message: 'run the migrations' });
    assert.ok(both.isError);
    assert.match(both.text, /one of/);

    const idle = await call(server, 'c1', 'local_run', { message: 'run the migrations' });
    assert.ok(idle.isError);
    assert.match(idle.text, /Nothing is running/);

    await call(server, 'c1', 'local_run', { issue: 12 });
    const starting = await call(server, 'c1', 'local_run', { message: 'run the migrations' });
    assert.ok(starting.isError);
    assert.match(starting.text, /coming up/);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('starting a second goal locally stops the first — there is one environment', async () => {
  const system = build({ localRun: { instruction: 'Run the dev server.', url: '' } });
  planWith(system);
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'The other one' });
  const { server } = await desk(system);
  try {
    await call(server, 'c1', 'local_run', { issue: 12 });
    const first = system.store.localRuns.liveLocalRun();
    assert.equal(first?.originRef, 'issue:12');

    await call(server, 'c1', 'local_run', { issue: 13 });
    const second = system.store.localRuns.liveLocalRun();
    assert.equal(second?.originRef, 'issue:13');
    assert.notEqual(second?.id, first?.id);
    assert.equal(system.store.localRuns.currentLocalRun()?.originRef, 'issue:13');
    assert.equal(system.store.localRuns.liveLocalRun()?.id, second?.id);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('local_run refuses with the reason when nothing is configured to start', async () => {
  const system = build();
  planWith(system);
  const { server } = await desk(system);
  try {
    const refused = await call(server, 'c1', 'local_run', { issue: 12 });
    assert.ok(refused.isError);
    assert.match(refused.text, /localRun\.instruction/);
    assert.equal(system.store.localRuns.liveLocalRun(), null, 'a refusal starts nothing and records nothing');
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
    assert.match(first.json().procedure as string, /Export a report and open it\./);

    const second = await call(server, 'c2', 'validation_claim', { issue: 12, check: 'B' });
    assert.ok(second.isError);
    assert.match(second.text, /already claimed by studio/);
    assert.match(second.text, /only one check can be claimed at a time/);
    assert.equal(byId(system, planId, 'chip-on-mobile').claimedBy, null);

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
  system.store.validation.recordValidationResult(planId, 'csv-opens', {
    state: 'passed',
    note: 'ran it',
    by: 'operator',
  });
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

    server.session('c1')?.end();
    assert.equal(byId(system, planId, 'csv-opens').claimedBy, null);

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

test('a report goes against the claim, and there is no reporting without one', async () => {
  const system = build();
  const planId = planWith(system);
  const { server } = await desk(system);
  try {
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
    assert.equal(after.resultBy, 'desktop');
    assert.equal(after.claimedBy, null, 'the reading is in, so the run is over');

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
      result: 'blocked',
      note: 'the staging login expired and I have no way to renew it from here',
    });
    assert.ok(!handed.isError, handed.text);
    assert.equal(handed.json().reported, 'blocked');
    assert.equal(handed.json().state, 'unrun');

    const after = byId(system, planId, 'chip-on-mobile');
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
    system.store.validation.amendValidation(planId, {
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

test('a reworded claimed check refuses a result, clears the session, and keeps the band', async () => {
  const system = build();
  const planId = planWith(system, [CHECKS[0]!]);
  const { server } = await desk(system);
  try {
    await call(server, 'c1', 'validation_claim', { issue: 12, check: 'A' });
    const claimedAt = byId(system, planId, 'csv-opens').claimedAt;
    assert.ok(claimedAt);
    while (new Date().toISOString() <= claimedAt) await new Promise((resolve) => setTimeout(resolve, 1));
    system.store.validation.amendValidation(planId, {
      note: 'the export moved to the Downloads page',
      checks: [
        {
          ...CHECKS[0]!,
          do: 'Open Downloads and open the exported file.',
          uses: [],
          covers: [],
          fleetCandidate: false,
          candidateWhy: null,
        },
      ],
      withdraw: [],
      resources: [],
    });

    const reported = await call(server, 'c1', 'validation_report', { result: 'passed', note: 'it opened' });
    assert.ok(reported.isError);
    assert.match(reported.text, /reworded by an amendment/);
    assert.match(reported.text, /the export moved to the Downloads page/);
    assert.match(reported.text, /Re-read.*claim it again/);
    const again = await call(server, 'c1', 'validation_report', { result: 'passed', note: 'it opened' });
    assert.match(again.text, /have not claimed a check/, 'the stale desktop run is no longer held');
    const after = byId(system, planId, 'csv-opens');
    assert.equal(after.state, 'unrun');
    assert.notEqual(after.amendedAt, null, 'the band survives the refused stale reading');
  } finally {
    await server.close();
    system.store.close();
  }
});

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
    steps: [],
    capture: null,
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
    area: null,
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
  return new RuleDispatcher({
    defaultBranch: 'main',
    validation: { desktopClaimMinutes: 60 },
    validationRoot: '/srv/validation',
  });
}

function validateDispatches(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.includes(':validate:'));
}

test('the fleet does not run a check somebody is holding, and does run one whose claim died', async () => {
  const fresh = new Date(new Date(NOW).getTime() - 60_000).toISOString();
  const held = await runner().decide(ctx([handedOver({ claimedBy: 'desktop (studio)', claimedAt: fresh })]));
  assert.deepEqual(validateDispatches(held.actions), [], 'a live claim holds the fleet off');

  const stale = new Date(new Date(NOW).getTime() - 61 * 60_000).toISOString();
  const expired = await runner().decide(ctx([handedOver({ claimedBy: 'desktop (studio)', claimedAt: stale })]));
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
    system.store.validation.amendValidation(planId, {
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
    const after = byId(system, planId, 'csv-opens');
    assert.equal(after.claimedBy, null);
    assert.equal(after.actor, 'human');
    assert.notEqual(after.amendedAt, null);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('the skill installs, and says what it is for without restating the procedure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-skill-'));
  const path = join(dir, 'skills', 'lubbdubb', 'SKILL.md');
  assert.ok(installDesktopSkill(path));
  const written = readFileSync(path, 'utf8');
  assert.equal(written, DESKTOP_SKILL);
  assert.match(written, /^---\nname: lubbdubb\n/);
  for (const tool of DESKTOP_TOOL_NAMES) assert.match(written, new RegExp(tool));
  assert.match(written, /blocked/);
  assert.match(written, /Do not report `passed` from evidence you did not gather/);
  assert.match(written, /rewritten from scratch every time the harness starts/);
  assert.doesNotMatch(written, /desktopSkill\b/);
});

test('the skill names LubbDubb\u2019s own checkout when there is one, and is unchanged when there is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-skill-root-'));
  const path = join(dir, 'SKILL.md');
  assert.ok(installDesktopSkill(path, undefined, '/srv/lubbdubb'));
  const written = readFileSync(path, 'utf8');
  assert.ok(written.startsWith(DESKTOP_SKILL), 'the body is untouched');
  assert.match(written, /\/srv\/lubbdubb/);
  assert.match(written, /The record first, the source second/);
  assert.match(written, /Change nothing there/);

  const bare = join(dir, 'BARE.md');
  assert.ok(installDesktopSkill(bare, undefined, null));
  assert.equal(readFileSync(bare, 'utf8'), DESKTOP_SKILL);
});

test('the snapshot ships a live claim, and `withLiveClaim` drops an expired one', () => {
  const system = build();
  const goal = planWith(system);
  const now = new Date().toISOString();
  system.store.validation.claimValidationCheck(goal, 'csv-opens', 'desktop (studio)', claimStaleBefore(now, 60));

  const shipped = buildStateSnapshot(system).validationChecks.find((c) => c.id === 'csv-opens')!;
  assert.equal(shipped.claimedBy, 'desktop (studio)', 'a live claim reaches the cockpit');

  const later = new Date(new Date(shipped.claimedAt ?? now).getTime() + 61 * 60_000).toISOString();
  const expired = withLiveClaim(shipped, later, 60);
  assert.equal(expired.claimedBy, null, 'and an expired one is not drawn at all');
  assert.equal(expired.claimedAt, null, 'neither half, so nothing can read a claim back out of it');
  system.store.close();
});

test('/api/mcp describes the desktop channel it is read from', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const payload = (await (await app.inject({ method: 'GET', url: '/api/mcp' })).json()) as McpChannelPayload;

  assert.deepEqual(
    payload.tools.map((t) => t.name),
    [...DESKTOP_TOOL_NAMES],
  );
  for (const tool of payload.tools) assert.ok(tool.description.length > 0, `${tool.name} says what it is for`);

  assert.equal(payload.serverId, 'lubbdubb');
  assert.equal(payload.registration.args.at(-1), '--desktop');
  assert.match(payload.registration.args[0] ?? '', /bridge\.mjs$/);
  assert.equal(payload.credentialPath, system.desktop.credentialPath());

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

function goalWith(system: System): string {
  const goal = planWith(system);
  system.store.world.setWorldBaseline({
    takenAt: NOW,
    pullRequests: [],
    closedPullRequests: [],
    issues: [
      {
        number: 12,
        title: 'Ship it',
        body: 'The export comes out empty.',
        state: 'open',
        labels: [],
        linkedPrNumber: null,
      } as unknown as Issue,
    ],
  } as unknown as WorldSnapshot);
  return goal;
}

test('goal_read answers with the record, and with the four things the record does not carry', async () => {
  const system = build();
  const goal = goalWith(system);
  system.store.scratch.recordRetrospective({
    originRef: goal,
    summary: 'Two goes at the export.',
    document: '# What happened\n\nThe first attempt read the wrong column.',
    agentId: 'a1',
    taskId: 't1',
  });
  const { server } = await desk(system);
  try {
    const read = await call(server, 'c1', 'goal_read', { issue: 12 });
    assert.ok(!read.isError, read.text);
    const payload = read.json();

    assert.deepEqual((payload.issue as Record<string, unknown>).body, 'The export comes out empty.');

    assert.equal(payload.record, retroDossier(goalRecord(system.store, goal)));

    const validation = payload.validation as { letter: string; id: string }[];
    assert.deepEqual(
      validation.map((c) => c.id).sort(),
      CHECKS.map((c) => c.id).sort(),
      'the checks ride beside the record — the dossier never carried them',
    );
    assert.equal((payload.retrospective as { summary: string }).summary, 'Two goes at the export.');
    assert.ok(Array.isArray(payload.scratchpad));
    assert.ok(Array.isArray(payload.environments));

    assert.equal(payload.plan, undefined, 'the plan is in the record, not beside it');
    assert.equal(payload.parts, undefined, 'so are the parts');
    assert.match(payload.record as string, /Part `whole`/);

    assert.equal(payload.observedAt, NOW);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('goal_read refuses a number the harness holds nothing about', async () => {
  const system = build();
  goalWith(system);
  const { server } = await desk(system);
  try {
    const read = await call(server, 'c1', 'goal_read', { issue: 9999 });
    assert.ok(read.isError, 'an untracked number is refused, not answered with an empty record');
    assert.match(read.text, /9999/);
    assert.match(read.text, /not a\s*\n?\s*goal nothing has happened on/);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('goal_read passes an environment verdict through three-valued', async () => {
  const system = build();
  const goal = goalWith(system);
  const { server } = await desk(system, {}, [
    { name: 'hallway', at: 'echo sha-31' },
    { name: 'production', at: 'echo nothing' },
  ]);
  try {
    system.store.environments.recordGoalLanding({ prNumber: 31, goalRef: goal, sha: 'sha-31' });
    system.store.environments.recordEnvironmentReach({
      sha: 'sha-31',
      environment: 'hallway',
      status: 'reached',
      detail: null,
    });

    const rows = (await call(server, 'c1', 'goal_read', { issue: 12 })).json().environments as {
      environment: string;
      status: string;
      landed: number;
      total: number;
    }[];
    const hallway = rows.find((r) => r.environment === 'hallway');
    const production = rows.find((r) => r.environment === 'production');
    assert.ok(hallway && production, 'a row per configured environment, in the operator’s order');
    assert.equal(hallway.status, 'partial');
    assert.deepEqual([hallway.landed, hallway.total], [1, 2]);
    assert.equal(production.status, 'unknown', 'an unanswered probe is `unknown`, never folded to `absent`');
    assert.equal(production.landed, 0);
  } finally {
    await server.close();
    system.store.close();
  }
});

test('goal_read draws no environment rows when none are configured', async () => {
  const system = build();
  goalWith(system);
  const { server } = await desk(system);
  try {
    assert.deepEqual((await call(server, 'c1', 'goal_read', { issue: 12 })).json().environments, []);
  } finally {
    await server.close();
    system.store.close();
  }
});
