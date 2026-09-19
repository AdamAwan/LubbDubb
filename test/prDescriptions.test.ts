import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { descriptionRefusal, descriptionStanding, PR_DESCRIPTION } from '../src/pr/prDescription.js';
import type { ActionSink, SendResult } from '../src/sink/actionSink.js';

// → docs/spec/07-pull-requests.md#the-operator-writes-the-description

function systemWith(manualDescriptions: boolean): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desc-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      userId: 'operator',
      manualDescriptions,
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    {
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      worktrees: new FakeWorktreeManager(),
      errorMirror: () => {},
    },
  );
}

test('the chain is append-only, so what shipped stays readable after a rewrite', () => {
  const system = systemWith(true);
  try {
    const ref = 'issue:390:part:validate';
    const first = system.store.prDescriptions.appendDescription({
      originRef: ref,
      text: 'Four routes each parse the payload their own way.',
      author: 'operator',
    });
    const second = system.store.prDescriptions.appendDescription({
      originRef: ref,
      text: 'Enqueue becomes the one place a payload is checked.',
      author: 'operator',
    });

    assert.equal(first.version, 1);
    assert.equal(first.supersedes, null);
    assert.equal(second.version, 2);
    assert.equal(second.supersedes, first.id, 'a version points at the one it supersedes');

    const chain = system.store.prDescriptions.listDescriptionVersions(ref);
    assert.equal(chain.length, 2, 'the earlier text is still there to read');
    assert.equal(chain[0]!.text, 'Four routes each parse the payload their own way.');
    assert.equal(system.store.prDescriptions.currentDescription(ref)!.id, second.id);
  } finally {
    system.store.close();
  }
});

test('a check lands on the version it read, never on whatever is newest', () => {
  const system = systemWith(true);
  try {
    const ref = 'issue:390:part:validate';
    const read = system.store.prDescriptions.appendDescription({
      originRef: ref,
      text: 'A missing row falls back to the old behaviour.',
      author: 'operator',
    });
    // The operator edits while their own Claude Code is still reading. A report that
    // landed on "the current one" would mark text the session never saw.
    const edited = system.store.prDescriptions.appendDescription({
      originRef: ref,
      text: 'A missing row throws, and the flag that would soften it defaults off.',
      author: 'operator',
    });

    const marked = system.store.prDescriptions.recordCheck({
      id: read.id,
      findings: [{ kind: 'contradicted', note: 'src/sync/resume.ts:91 throws on a missing row.', question: null }],
    });

    assert.equal(marked!.id, read.id);
    assert.equal(marked!.findings.length, 1);
    assert.equal(marked!.findings[0]!.question, null, 'a finding names a question only where it is one');
    assert.equal(
      system.store.prDescriptions.currentDescription(ref)!.checkedAt,
      null,
      'the version the operator has since written is unmarked',
    );
    assert.equal(system.store.prDescriptions.currentDescription(ref)!.id, edited.id);
  } finally {
    system.store.close();
  }
});

test('a report naming a version the store does not hold is answered null, not guessed at', () => {
  const system = systemWith(true);
  try {
    assert.equal(system.store.prDescriptions.recordCheck({ id: 'desc_gone', findings: [] }), null);
  } finally {
    system.store.close();
  }
});

test('a check is findings, not four answers, and a clean one is not an unchecked one', () => {
  const system = systemWith(true);
  try {
    const store = system.store.prDescriptions;

    const untouched = store.appendDescription({ originRef: 'issue:390:part:a', text: 'A.', author: 'operator' });
    assert.equal(descriptionStanding(untouched), 'unchecked');

    // A check that found nothing is a result, and has to stay tellable from no check.
    const clean = store.appendDescription({ originRef: 'issue:390:part:b', text: 'B.', author: 'operator' });
    assert.equal(descriptionStanding(store.recordCheck({ id: clean.id, findings: [] })!), 'clean');

    // Findings that name none of the four questions are the ordinary case, and the
    // record has to hold them — a check keyed by the questions could not.
    const gaps = store.appendDescription({ originRef: 'issue:390:part:c', text: 'C.', author: 'operator' });
    const gapped = store.recordCheck({
      id: gaps.id,
      findings: [
        { kind: 'gap', note: 'The rename in src/jobs/catalog.ts:8 is not mentioned.', question: null },
        { kind: 'gap', note: 'Nothing covers the older-build row.', question: 'missing' },
      ],
    })!;
    assert.equal(descriptionStanding(gapped), 'gaps');
    assert.deepEqual(
      gapped.findings.map((f) => f.question),
      [null, 'missing'],
      'the tag is optional and the order is the session’s',
    );

    // One contradiction outranks any number of gaps.
    const bad = store.appendDescription({ originRef: 'issue:390:part:d', text: 'D.', author: 'operator' });
    assert.equal(
      descriptionStanding(
        store.recordCheck({
          id: bad.id,
          findings: [
            { kind: 'gap', note: 'A gap.', question: null },
            { kind: 'contradicted', note: 'src/a.ts:1 does not do this.', question: null },
          ],
        })!,
      ),
      'contradicted',
    );
  } finally {
    system.store.close();
  }
});

test('a re-check replaces the reading rather than piling onto it', () => {
  const system = systemWith(true);
  try {
    const store = system.store.prDescriptions;
    const version = store.appendDescription({ originRef: 'issue:390:part:e', text: 'E.', author: 'operator' });
    store.recordCheck({ id: version.id, findings: [{ kind: 'gap', note: 'first pass', question: null }] });
    const second = store.recordCheck({ id: version.id, findings: [] })!;
    assert.deepEqual(second.findings, [], 'two sessions over one text are two readings, never one that found twice');
    assert.equal(descriptionStanding(second), 'clean');
  } finally {
    system.store.close();
  }
});

test('the goal-level read answers the newest of each part, which is what the board badges from', async () => {
  const system = systemWith(true);
  const { app } = await buildApp(system);
  try {
    system.store.prDescriptions.appendDescription({
      originRef: 'issue:390:part:schemas',
      text: 'The schemas move, and the old paths re-export.',
      author: 'operator',
    });
    system.store.prDescriptions.appendDescription({
      originRef: 'issue:390:part:validate',
      text: 'First draft.',
      author: 'operator',
    });
    system.store.prDescriptions.appendDescription({
      originRef: 'issue:390:part:validate',
      text: 'Enqueue becomes the one place a payload is checked.',
      author: 'operator',
    });
    // A different goal's part, to prove the prefix is a goal and not a LIKE that
    // catches #3900 on its way past.
    system.store.prDescriptions.appendDescription({
      originRef: 'issue:3901:part:validate',
      text: 'Another goal entirely.',
      author: 'operator',
    });

    const read = await app.inject({ method: 'GET', url: '/api/goals/390/descriptions' });
    assert.equal(read.statusCode, 200);
    const body = read.json() as { parts: Record<string, { text: string; version: number }> };
    assert.deepEqual(Object.keys(body.parts).sort(), ['schemas', 'validate']);
    assert.equal(body.parts.validate!.version, 2, 'the newest, never the chain');
    assert.equal(body.parts.validate!.text, 'Enqueue becomes the one place a payload is checked.');

    const none = await app.inject({ method: 'GET', url: '/api/goals/391/descriptions' });
    assert.deepEqual(none.json(), { parts: {} }, 'a goal nobody described answers empty, not absent');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('the goal-level read is not mounted where the flag is off, which is how the board learns', async () => {
  const system = systemWith(false);
  const { app } = await buildApp(system);
  try {
    const read = await app.inject({ method: 'GET', url: '/api/goals/390/descriptions' });
    assert.equal(read.statusCode, 404);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('the refusal bounds the field and asserts nothing about its shape', () => {
  // `prBodyRefusal` exists because asking an agent for a shape did not work. A person
  // writing about a change they read is not that party, and a refusal that bounced
  // their prose for a semicolon would teach them to write for the checker.
  assert.equal(
    descriptionRefusal(
      'A restart replays the whole feed; boot now reads the stored cursor. Nothing covers an older row.',
    ),
    null,
    'semicolons, long sentences and prose paragraphs are all the operator’s business',
  );
  assert.equal(descriptionRefusal('## Summary\n\nThis change persists the cursor.'), null, 'headings too');
  assert.match(descriptionRefusal('   ') ?? '', /nothing in it/);
  assert.match(descriptionRefusal('x'.repeat(PR_DESCRIPTION.maxChars + 1)) ?? '', /the limit is/);
});

test('the routes are not mounted where the flag is off, which is how the panel learns', async () => {
  for (const on of [true, false]) {
    const system = systemWith(on);
    const { app } = await buildApp(system);
    try {
      const written = await app.inject({
        method: 'POST',
        url: '/api/goals/390/parts/validate/description',
        payload: { text: 'Enqueue becomes the one place a payload is checked.' },
      });
      if (!on) {
        assert.equal(written.statusCode, 404, 'with the flag off there is no route to answer');
        continue;
      }
      assert.equal(written.statusCode, 200);

      const read = await app.inject({ method: 'GET', url: '/api/goals/390/parts/validate/description' });
      const body = read.json() as { current: { text: string; originRef: string; author: string | null } };
      assert.equal(body.current.originRef, 'issue:390:part:validate', 'keyed on the part, because a part is a PR');
      assert.equal(body.current.text, 'Enqueue becomes the one place a payload is checked.');
      assert.equal(body.current.author, 'operator');

      const empty = await app.inject({
        method: 'POST',
        url: '/api/goals/390/parts/validate/description',
        payload: { text: '   ' },
      });
      assert.equal(empty.statusCode, 400, 'an empty description is refused rather than stored');
    } finally {
      await app.close();
      system.store.close();
    }
  }
});

/**
 * A sink that records what body actually left for the provider, and quietly succeeds
 * at everything else `open_pr` does on its way out — the watch seed and the work-item
 * link. The fake provider keeps no body on its pull requests, so the world cannot
 * answer the one question this file is asking.
 */
type RecordingSink = ActionSink & {
  opened: { title: string; body: string }[];
  bodies: { prNumber: number; body: string }[];
};

function recordingSink(): RecordingSink {
  const opened: { title: string; body: string }[] = [];
  const bodies: { prNumber: number; body: string }[] = [];
  return new Proxy({} as RecordingSink, {
    get(_t, prop: string) {
      if (prop === 'opened') return opened;
      if (prop === 'bodies') return bodies;
      if (prop === 'createPullRequest')
        return async (input: { title: string; body: string }): Promise<SendResult> => {
          opened.push({ title: input.title, body: input.body });
          return { ok: true, ref: String(opened.length) };
        };
      if (prop === 'setPullBody')
        return async (input: { prNumber: number; body: string }): Promise<SendResult> => {
          bodies.push({ prNumber: input.prNumber, body: input.body });
          return { ok: true };
        };
      return async (): Promise<SendResult> => ({ ok: true });
    },
  });
}

async function callOpenPr(
  system: System,
  originRef: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/182',
    originRef,
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session.call('open_pr', args)) as {
    isError?: boolean;
    content: { text?: string }[];
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

function seedParts(system: System): void {
  const plan = system.store.plans.upsertPlan({
    originRef: 'issue:182',
    title: 'Ticket sync rewrite',
    status: 'active',
    reason: 'Cursor before reader.',
  });
  system.store.plans.upsertPlanParts(
    plan.id,
    ['cursor', 'reader'].map((slug, i) => ({
      slug,
      seq: i + 1,
      title: slug,
      scope: 'src/sync',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'code' as const,
    })),
  );
}

test('with the flag on nothing of the operator\u2019s ships at the open \u2014 there is nothing to describe yet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desc-'));
  const sink = recordingSink();
  const system = manualSystem(dir, sink);
  try {
    system.connector.inject({ kind: 'new_issue', number: 182, title: 'Ticket sync rewrite', body: '' });
    await system.harness.runCycle('manual');
    seedParts(system);

    // A description written before the pull request exists \u2014 which the cockpit does not
    // offer, and which must not ship even when the store holds one.
    system.store.prDescriptions.appendDescription({
      originRef: 'issue:182:part:cursor',
      text: 'A restart replays the whole feed, which is the bug people see.',
      author: 'operator',
    });

    const opened = await callOpenPr(system, 'issue:182:part:cursor', { summary: 'read the cursor back' });
    assert.equal(opened.isError, false, opened.text);
    assert.doesNotMatch(
      sink.opened[0]!.body,
      /A restart replays/,
      'the open carries the evidence and the reference alone',
    );

    // The other half of the posture: nothing here holds a pull request up.
    const bare = await callOpenPr(system, 'issue:182:part:reader', { summary: 'retire the in-memory map' });
    assert.equal(bare.isError, false, 'a part nobody described still opens');

    // And the agent cannot smuggle one in.
    const refused = await callOpenPr(system, 'issue:182:part:cursor', {
      summary: 'something else',
      body: '- I will describe my own change, thanks.',
    });
    assert.equal(refused.isError, true);
    assert.equal(sink.opened.length, 2, 'the refusal happened before anything left');
    assert.match(refused.text, /operator/i, 'the refusal says whose the body is, not merely that it was refused');
  } finally {
    system.store.close();
  }
});

test('a description written against the open pull request is put at the top of its body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desc-'));
  const sink = recordingSink();
  const system = manualSystem(dir, sink);
  try {
    system.connector.inject({ kind: 'new_issue', number: 182, title: 'Ticket sync rewrite', body: '' });
    await system.harness.runCycle('manual');
    seedParts(system);

    const opened = await callOpenPr(system, 'issue:182:part:cursor', { summary: 'read the cursor back' });
    assert.equal(opened.isError, false, opened.text);
    const tail = sink.opened[0]!.body;

    system.store.prDescriptions.appendDescription({
      originRef: 'issue:182:part:cursor',
      text: 'A restart replays the whole feed, which is the bug people see.',
      author: 'operator',
    });
    await system.harness.runCycle('manual');

    assert.equal(sink.bodies.length, 1, 'one push, onto the pull request the part opened');
    assert.equal(sink.bodies[0]!.prNumber, 1);
    assert.match(sink.bodies[0]!.body, /^A restart replays the whole feed, which is the bug people see\./);
    assert.ok(sink.bodies[0]!.body.endsWith(tail), 'in front of the tail the open wrote, never instead of it');

    // Pushed once and only once: a settled version is not re-sent on every pulse.
    await system.harness.runCycle('manual');
    assert.equal(sink.bodies.length, 1);

    // A rewrite is a new version, so it is a new push.
    system.store.prDescriptions.appendDescription({
      originRef: 'issue:182:part:cursor',
      text: 'The cursor is read back at startup, so a restart resumes where it stopped.',
      author: 'operator',
    });
    await system.harness.runCycle('manual');
    assert.equal(sink.bodies.length, 2);
    assert.match(sink.bodies[1]!.body, /^The cursor is read back at startup/);
  } finally {
    system.store.close();
  }
});

test('a part whose pull request never opened is never pushed, however much is written about it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desc-'));
  const sink = recordingSink();
  const system = manualSystem(dir, sink);
  try {
    system.connector.inject({ kind: 'new_issue', number: 182, title: 'Ticket sync rewrite', body: '' });
    await system.harness.runCycle('manual');
    seedParts(system);

    system.store.prDescriptions.appendDescription({
      originRef: 'issue:182:part:reader',
      text: 'Written against a plan, about a pull request that does not exist.',
      author: 'operator',
    });
    await system.harness.runCycle('manual');

    assert.equal(sink.bodies.length, 0, 'the join on the opened-body record is what refuses it');
  } finally {
    system.store.close();
  }
});

function manualSystem(dir: string, sink: ActionSink): System {
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      userId: 'operator',
      manualDescriptions: true,
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager(), sink, errorMirror: () => {} },
  );
}
