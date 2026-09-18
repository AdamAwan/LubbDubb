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
import { descriptionRefusal, describeMarks, PR_DESCRIPTION } from '../src/pr/prDescription.js';
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
      marks: { 'asked-for': 'matched', undone: 'contradicted' },
    });

    assert.equal(marked!.id, read.id);
    assert.equal(marked!.marks.undone, 'contradicted');
    assert.equal(marked!.marks.missing, null, 'a question the check did not reach stays null, never a miss');
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
    assert.equal(system.store.prDescriptions.recordCheck({ id: 'desc_gone', marks: { reach: 'matched' } }), null);
  } finally {
    system.store.close();
  }
});

test('contradicted is counted apart from missed, because they are not the same defect', () => {
  const system = systemWith(true);
  try {
    const version = system.store.prDescriptions.appendDescription({
      originRef: 'issue:390:part:schemas',
      text: 'The old paths re-export, so nothing importing them has to change.',
      author: 'operator',
    });
    const marked = system.store.prDescriptions.recordCheck({
      id: version.id,
      marks: { 'asked-for': 'matched', undone: 'contradicted', missing: 'missed', reach: 'matched' },
    });
    assert.deepEqual(describeMarks(marked!), { matched: 2, missed: 1, contradicted: 1, marked: 4 });
  } finally {
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
function recordingSink(): ActionSink & { opened: { title: string; body: string }[] } {
  const opened: { title: string; body: string }[] = [];
  return new Proxy({} as ActionSink & { opened: { title: string; body: string }[] }, {
    get(_t, prop: string) {
      if (prop === 'opened') return opened;
      if (prop === 'createPullRequest')
        return async (input: { title: string; body: string }): Promise<SendResult> => {
          opened.push({ title: input.title, body: input.body });
          return { ok: true, ref: String(opened.length) };
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

test('with the flag on the body is the operator\u2019s, and a part nobody described ships none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desc-'));
  const sink = recordingSink();
  const system = buildSystem(
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
  try {
    system.connector.inject({ kind: 'new_issue', number: 182, title: 'Ticket sync rewrite', body: '' });
    await system.harness.runCycle('manual');
    seedParts(system);

    system.store.prDescriptions.appendDescription({
      originRef: 'issue:182:part:cursor',
      text: 'A restart replays the whole feed, which is the bug people see.',
      author: 'operator',
    });

    const described = await callOpenPr(system, 'issue:182:part:cursor', { summary: 'read the cursor back' });
    assert.equal(described.isError, false, described.text);
    assert.match(
      sink.opened[0]!.body,
      /^A restart replays the whole feed, which is the bug people see\./,
      'the operator\u2019s words, above the harness block',
    );

    // The other half of the posture: nothing here holds a pull request up.
    const bare = await callOpenPr(system, 'issue:182:part:reader', { summary: 'retire the in-memory map' });
    assert.equal(bare.isError, false, 'a part nobody described still opens');
    assert.doesNotMatch(sink.opened[1]!.body, /A restart replays/, 'and carries nobody else\u2019s account instead');

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
