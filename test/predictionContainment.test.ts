import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { ActionSink, SendResult } from '../src/sink/actionSink.js';
import { PREDICTION_SLOTS } from '../src/store/predictions.js';
import { inheritableEnv } from '../src/agents/spawnEnv.js';

// → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store

/**
 * The prediction is a measurement of the fleet. It is worthless the moment anything
 * the fleet reads can name it, and worse than worthless if it reaches the tracker:
 * the operator's guess at how the work should be split would be sitting on the ticket.
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
  // Everything that composes prose an agent is handed, or prose that reaches the
  // tracker. `src/executor` is the sharpest: it renders the dispatch prompt and
  // persists it.
  'src/executor',
  'src/plans',
  'src/escalation',
  'src/knowledge',
  'src/summaries',
];

/**
 * Top-level modules are scanned too: `goalInstructions.ts` is the one thing an
 * operator writes that IS delivered to agents by design, which makes it the most
 * inviting place to "just put the prediction as well".
 */
const CONTAINED_FILES = [
  'src/goalInstructions.ts',
  'src/issueWatch.ts',
  'src/tickets/briefTicket.ts',
  // The one module that composes *persisted* prose off the prediction record's
  // shadow. `attention_read` serves an open human task's title and detail to the
  // operator's own Claude Code, so a close-out row that ever carried prediction text
  // would put a prediction in front of a model. It carries the goal and nothing else,
  // and this is what holds it there.
  'src/delivery/closeOut.ts',
];

const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /(?:\.\.?\/)+store\/predictions\.js/, what: 'imports the prediction store' },
  { pattern: /\bopenPredictions\b/, what: 'names openPredictions()' },
  { pattern: /\bstore\.predictions\b/, what: 'reaches for store.predictions' },
  // The way the store is actually reached today. Without this the scan would pass a
  // module that simply held a `System` and asked it.
  { pattern: /\.predictions\b/, what: 'reaches a predictions member' },
  { pattern: /\bgoal_predictions\b/, what: 'names the goal_predictions table' },
  // Stage 3's vocabulary. The types are re-exported through `wire.js`, which fleet
  // modules legitimately import — so a module could name `GoalPrediction` and read
  // `.planMarks` off a value without ever naming the store.
  { pattern: /\bGoalPrediction\b/, what: 'names the GoalPrediction type' },
  { pattern: /\bPredictionMark\b/, what: 'names the PredictionMark type' },
  { pattern: /\bplanMarks\b/, what: 'reads a prediction’s marks' },
  { pattern: /\bplan_mark_/, what: 'names a prediction mark column' },
  { pattern: /\brecordPlanMarks\b/, what: 'writes a prediction mark' },
  // Moment two's twins. The asymmetry was the gap: a scan that forbids moment one's
  // vocabulary and not moment two's forbids half a record.
  { pattern: /\boutcomeMarks\b/, what: "reads a prediction's outcome marks" },
  { pattern: /\boutcome_mark_/, what: 'names an outcome mark column' },
  { pattern: /\brecordOutcomeMarks\b/, what: 'writes an outcome mark' },
  { pattern: /\bPredictionOutcomeMarks\b/, what: 'names the PredictionOutcomeMarks type' },
  // Stage 6, and the readers that return whole rows.
  { pattern: /\blistPredictions\b/, what: 'lists predictions, which carry their slot text' },
  { pattern: /\blistReveals\b/, what: 'lists reveal stamps' },
  { pattern: /\bgetPrediction\b/, what: 'reads a prediction' },
  { pattern: /\bgetReveal\b/, what: 'reads a reveal stamp' },
  { pattern: /\bpredictionFacts\b/, what: 'names the aggregate’s intake' },
  { pattern: /\bPredictionAggregate\b/, what: 'names the aggregate' },
  { pattern: /\bGoalReveal\b/, what: 'names the GoalReveal type' },
  // `.predictions` is defeated by `const { predictions } = system`, after which the
  // store is reached under a bare name and the row type is inferred rather than
  // written. The bare word is the pattern that survives that.
  { pattern: /\bpredictions\b/, what: 'names predictions at all' },
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
  for (const file of CONTAINED_FILES) {
    assert.ok(existsSync(file), `${file} moved; the scan names a file that is not there`);
    scanned.push(file);
  }
  assert.ok(scanned.length >= 50, 'the containment scan read the fleet, or it proves nothing');

  for (const file of scanned) {
    const source = readFileSync(file, 'utf8');
    for (const { pattern, what } of FORBIDDEN) {
      assert.ok(
        !pattern.test(source),
        `${file} ${what}. A prediction is a measurement of the fleet, so nothing the fleet reads may name ` +
          `it — fix ${file}, not this assertion. The store is opened once, in src/system/system.ts, and handed to ` +
          'the prediction routes alone. → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store',
      );
    }
  }
});

/**
 * The escape that is not an import.
 *
 * An agent is launched with the harness's environment so it can reach `gh` and its
 * own MCP socket. `LUBBDUBB_TOKEN` is the cockpit bearer, and every operator-only
 * route answers to it — so an agent that inherited it could simply `curl` the
 * prediction back, over the network, with nothing in any import graph to show for
 * it. Neither the type system nor the scan above can see that; this can.
 */
test('an agent does not inherit the credential that would let it read a prediction back', () => {
  const inherited = inheritableEnv({
    ...process.env,
    LUBBDUBB_TOKEN: 'ZZQX-BEARER-SENTINEL',
    LUBBDUBB_INGRESS_SECRET: 'ZZQX-INGRESS-SENTINEL',
    PATH: process.env.PATH,
  });

  assert.equal(inherited.LUBBDUBB_TOKEN, undefined, 'the cockpit bearer reached an agent');
  assert.equal(inherited.LUBBDUBB_INGRESS_SECRET, undefined, 'an ingress secret reached an agent');
  assert.equal(inherited.PATH, process.env.PATH, 'the rest of the environment still goes through');

  // Non-vacuous: the sentinel is findable in what we handed in, so the assertion
  // above is about the stripping and not about the key never having been set.
  assert.equal({ ...process.env, LUBBDUBB_TOKEN: 'ZZQX-BEARER-SENTINEL' }.LUBBDUBB_TOKEN, 'ZZQX-BEARER-SENTINEL');

  const spawnSites = ['src/agents/streamJsonSession.ts', 'src/pty/backend.ts'];
  for (const file of spawnSites) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !/\.\.\.process\.env\b/.test(source),
      `${file} spreads process.env into an agent's environment, which hands it the cockpit bearer. ` +
        'Use inheritableEnv(). Fix the file, not this assertion.',
    );
  }
});

/**
 * `src/server/` is where predictions legitimately live, so it cannot be scanned
 * wholesale. But a route module is the one place in the codebase where a rendered
 * agent prompt and `system.predictions` are both in scope at once, and that
 * combination is one line from a leak that no other assertion here would catch.
 */
test('no module that renders an agent prompt also reaches the prediction store', () => {
  const server = tsFiles('src/server');
  assert.ok(server.length > 10, 'the server was read, or this assertion proves nothing');

  const renders: string[] = [];
  for (const file of server) {
    const source = readFileSync(file, 'utf8');
    const buildsAPrompt = /\bprompts\.render\b/.test(source);
    if (!buildsAPrompt) continue;
    renders.push(file);
    assert.ok(
      !/\.predictions\b|\bPredictionStore\b|\bopenPredictions\b/.test(source),
      `${file} both renders an agent prompt and reaches the prediction store. Those two must not meet ` +
        `in one module — split the prompt out, or move the prediction read. Fix ${file}, not this ` +
        'assertion. → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store',
    );
  }
  assert.ok(renders.length > 0, 'no server module renders a prompt; the pattern moved and this proves nothing');
});

const SENTINELS = {
  locus: 'ZZQX-LOCUS-SENTINEL',
  cause: 'ZZQX-CAUSE-SENTINEL',
  split: 'ZZQX-SPLIT-SENTINEL',
  avoid: 'ZZQX-AVOID-SENTINEL',
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
    setPullBody: record('setPullBody'),
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
        `the prediction left the harness through ActionSink.${call.method} — the operator's guess at how ` +
          'the work should be split would be on the tracker, where the fleet reads it back. Fix the caller, not this assertion.',
      );
    }
  } finally {
    system.store.close();
  }
});
