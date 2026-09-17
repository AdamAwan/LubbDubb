import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { ActionSink, SendResult } from '../src/sink/actionSink.js';
import { PREDICTION_SLOTS } from '../src/store/predictions.js';

// → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store

/**
 * The prediction is a measurement of the fleet. It is worthless the moment anything
 * the fleet reads can name it, and worse than worthless if it reaches the tracker:
 * the operator's guess at what will be hard would be sitting on the ticket.
 */

const CONTAINED_DIRS = [
  'src/dispatcher',
  'src/agents',
  'src/mcp',
  'src/retro',
  'src/briefing',
  'src/scratch',
  'src/sink',
  // The outbound tracker path: `ticketFiler` builds every IssueCreateInput.
  'src/tickets',
];

const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /(?:\.\.?\/)+store\/predictions\.js/, what: 'imports the prediction store' },
  { pattern: /\bopenPredictions\b/, what: 'names openPredictions()' },
  { pattern: /\bstore\.predictions\b/, what: 'reaches for store.predictions' },
  { pattern: /\bPredictionStore\b/, what: 'names PredictionStore' },
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

test('nothing the fleet is handed can name the prediction store', () => {
  const scanned: string[] = [];
  for (const dir of CONTAINED_DIRS) {
    const files = tsFiles(dir);
    assert.ok(files.length > 0, `${dir} holds no modules; the scan moved or this assertion proves nothing`);
    scanned.push(...files);
  }
  assert.ok(scanned.length >= 50, 'the containment scan read the fleet, or it proves nothing');

  for (const file of scanned) {
    const source = readFileSync(file, 'utf8');
    for (const { pattern, what } of FORBIDDEN) {
      assert.ok(
        !pattern.test(source),
        `${file} ${what}. A prediction is a measurement of the fleet, so nothing the fleet reads may name ` +
          `it — fix ${file}, not this assertion. The store is opened once, in src/system.ts, and handed to ` +
          'the prediction routes alone. → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store',
      );
    }
  }
});

const SENTINELS = {
  locus: 'ZZQX-LOCUS-SENTINEL',
  cause: 'ZZQX-CAUSE-SENTINEL',
  hard: 'ZZQX-HARD-SENTINEL',
  surprise: 'ZZQX-SURPRISE-SENTINEL',
} as const;

function sentinelIn(value: unknown): boolean {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    text = String(value);
  }
  return Object.values(SENTINELS).some((s) => text.includes(s));
}

interface SinkCall {
  method: string;
  input: unknown;
}

function recordingSink(): { sink: ActionSink; calls: SinkCall[] } {
  const calls: SinkCall[] = [];
  const record =
    (method: string) =>
    async (input: unknown): Promise<SendResult> => {
      calls.push({ method, input });
      return { ok: true, ref: 'ref_1', commentRef: 'comment_1', threadRef: 'thread_1' };
    };
  const sink: ActionSink = {
    canResolvePrThread: () => true,
    canClosePr: () => true,
    canCloseIssue: () => true,
    canSetWorkItemState: () => true,
    canPlaceWorkItem: () => true,
    postPrReply: record('postPrReply'),
    resolvePrThread: record('resolvePrThread'),
    mergePr: record('mergePr'),
    closePr: record('closePr'),
    setPrLabel: record('setPrLabel'),
    setIssueLabel: record('setIssueLabel'),
    closeIssue: record('closeIssue'),
    setWorkItemState: record('setWorkItemState'),
    setWorkItemParent: record('setWorkItemParent'),
    setWorkItemAreaPath: record('setWorkItemAreaPath'),
    upsertIssueComment: record('upsertIssueComment'),
    createIssue: record('createIssue'),
    linkWorkItem: record('linkWorkItem'),
    createPullRequest: record('createPullRequest'),
    setPullTitle: record('setPullTitle'),
    setPullBase: record('setPullBase'),
    updatePrBranch: record('updatePrBranch'),
    requeueCiCheck: record('requeueCiCheck'),
    deleteBranch: record('deleteBranch'),
  };
  return { sink, calls };
}

function build(sink: ActionSink, backend: FakePtyBackend): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pred-'));
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
      prediction: { enabled: true },
      goalCriteria: { enabled: true },
    }),
    {
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver(),
      backend,
      sink,
      errorMirror: () => {},
    },
  );
}

test('a prediction reaches no prompt, no tool response, no transcript and — above all — no outbound call', async () => {
  const backend = new FakePtyBackend();
  const { sink, calls } = recordingSink();
  const system = build(sink, backend);
  try {
    const written = system.predictions.recordPrediction({
      originRef: 'issue:1',
      author: 'operator',
      slots: { ...SENTINELS },
    });
    assert.ok(written, 'the prediction was recorded');
    assert.deepEqual([...PREDICTION_SLOTS].sort(), Object.keys(SENTINELS).sort(), 'every slot carries a sentinel');

    // The search is not vacuous: it finds the sentinels where they legitimately are.
    assert.ok(sentinelIn(system.predictions.getPrediction('issue:1')), 'the store holds them, and the search sees it');

    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    await system.harness.runCycle('manual');

    const sweep = (): void => {
      const tasks = system.store.tasks.listTasks().map((t) => system.store.tasks.getTask(t.id));
      assert.ok(
        tasks.some((t) => t?.originRef?.startsWith('issue:1') === true),
        'an agent was actually dispatched on the goal',
      );
      for (const task of tasks) {
        assert.ok(!sentinelIn(task?.prompt), `the prediction reached the prompt of task ${task?.id}`);
        assert.ok(!sentinelIn(task?.title), `the prediction reached the title of task ${task?.id}`);
      }
      for (const spawned of backend.spawned) {
        assert.ok(!sentinelIn(spawned.args), 'the prediction reached an agent launch argument');
        assert.ok(!sentinelIn(spawned.opts), 'the prediction reached an agent launch environment');
        assert.ok(!sentinelIn(spawned.proc.writes), 'the prediction was typed at an agent');
      }
      const seen = system.store.agents.listAgents();
      assert.ok(seen.length > 0, 'an agent exists, or the transcript arm proves nothing');
      for (const agent of seen) {
        assert.ok(
          !sentinelIn(system.store.transcripts.getTranscript(agent.id)),
          `the prediction reached agent ${agent.id}'s transcript`,
        );
      }
    };
    sweep();

    const agents = system.store.agents.listAgents();

    let toolResponses = 0;
    for (const agent of agents) {
      const session = system.mcp.session(agent.id);
      if (!session) continue;
      for (const [name, args] of [
        ['world_read', { kind: 'issue', ref: 'issue:1' }],
        ['scratch_read', {}],
      ] as const) {
        const result = await session.call(name, args as Record<string, unknown>);
        toolResponses += 1;
        assert.ok(!sentinelIn(result), `the prediction came back out of ${name}`);
      }
    }
    assert.ok(toolResponses > 0, 'tools were actually called, or the tool arm proves nothing');

    // Drive the fleet all the way out to the tracker: an appraisal verdict is posted
    // on the issue, which is the path a prediction would escape by.
    for (const agent of agents) {
      const session = system.mcp.session(agent.id);
      if (!session) continue;
      await session.call('appraise_issue', {
        status: 'unclear',
        summary: 'the ticket does not say what done means',
        missing: ['What should the button do?'],
      });
    }
    await system.harness.runCycle('manual');
    sweep();

    assert.ok(
      calls.map((c) => c.method).includes('upsertIssueComment'),
      'the fleet actually wrote to the tracker, or the sink arm proves nothing',
    );
    for (const call of calls) {
      assert.ok(
        !sentinelIn(call),
        `the prediction left the harness through ActionSink.${call.method} — the operator's guess at what ` +
          'would be hard would be on the tracker, where the fleet reads it back. Fix the caller, not this assertion.',
      );
    }
  } finally {
    system.store.close();
  }
});
