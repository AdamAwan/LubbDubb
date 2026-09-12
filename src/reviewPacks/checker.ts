import { EventEmitter } from 'node:events';
import type { AgentManager } from '../agents/agentManager.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { Store } from '../store/store.js';
import type { Agent, PullRequest, ReviewPack, ReviewPackRecord, Task } from '../types.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import { readRegion } from './author.js';
import { applyCheck } from './check.js';
import { parseDiffHunks, type DiffHunk } from './hunks.js';
import { checkLeaseHead, checkLeaseKey, checkOrigin, checkTargetPr, packLeaseHead, packTargetPr } from './origins.js';

// → docs/spec/31-review-packs.md

interface CheckerDeps {
  store: Store;
  agents: Pick<AgentManager, 'spawn' | 'on'>;
  worktrees: Worktrees;
  git: GitObserver;
  prompts: PromptTemplates;
  defaultBranch: string;
  runtime: Pick<RuntimeControl, 'paused'>;
  errors: ErrorRecorder;
}

interface CheckerEvents {
  checked: [{ record: ReviewPackRecord }];
}

export class ReviewPackChecker extends EventEmitter {
  private readonly composing = new Set<number>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: CheckerDeps) {
    super();
    deps.agents.on('done', ({ taskId }) => this.follow(taskId));
  }

  override emit<K extends keyof CheckerEvents>(event: K, ...args: CheckerEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof CheckerEvents>(event: K, listener: (...args: CheckerEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  checking(prNumber: number): boolean {
    return this.composing.has(prNumber) || this.deps.store.tasks.findActiveTaskByOrigin(checkOrigin(prNumber)) !== null;
  }

  submit(
    agent: Agent,
    task: Task,
    args: Record<string, unknown>,
  ): { ok: true; record: ReviewPackRecord } | { ok: false; error: string } {
    const prNumber = checkTargetPr(task.originRef);
    const headSha = checkLeaseHead(task.branch);
    if (prNumber === null || headSha === null) {
      return {
        ok: false,
        error:
          'review_pack_check is for an agent dispatched to check a review pack, and this run was dispatched for ' +
          `${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      };
    }
    const current = this.packAt(prNumber, headSha);
    if (!current) {
      return {
        ok: false,
        error: `there is no pack for #${prNumber} at ${headSha} any more; nothing was recorded. Tell the operator.`,
      };
    }
    const applied = applyCheck({ pack: current, readRegion: (range) => readRegion(agent.cwd, range) }, args);
    if (!applied.ok) return applied;
    const record = this.deps.store.reviewPacks.recordReviewPack(applied.pack);
    this.emit('checked', { record });
    return { ok: true, record };
  }

  private packAt(prNumber: number, headSha: string): ReviewPack | null {
    return this.deps.store.reviewPacks.listReviewPacks(prNumber).find((r) => r.pack.headSha === headSha)?.pack ?? null;
  }

  private follow(taskId: string): void {
    const task = this.deps.store.tasks.getTask(taskId);
    const prNumber = packTargetPr(task?.originRef ?? null);
    const headSha = packLeaseHead(task?.branch ?? null);
    if (prNumber === null || headSha === null) return;
    const pack = this.packAt(prNumber, headSha);
    if (!pack || pack.order.length > 0) return;
    if (this.checking(prNumber)) return;
    if (this.deps.runtime.paused) {
      this.deps.errors.record({
        source: 'agent',
        message: `The review pack for PR #${prNumber} was not checked: dispatch is paused. Ask for the pack again once it is resumed.`,
      });
      return;
    }
    this.composing.add(prNumber);
    const run = this.compose(prNumber, headSha, pack).finally(() => {
      this.composing.delete(prNumber);
      this.inflight.delete(run);
    });
    this.inflight.add(run);
  }

  private prOf(prNumber: number): PullRequest | null {
    const world = this.deps.store.world.getWorldBaseline();
    return (
      world?.pullRequests.find((p) => p.number === prNumber) ??
      world?.closedPullRequests?.find((p) => p.number === prNumber) ??
      null
    );
  }

  private async compose(prNumber: number, headSha: string, pack: ReviewPack): Promise<void> {
    const { store, errors } = this.deps;
    let task: Task | null = null;
    try {
      const pr = this.prOf(prNumber);
      const base = pr?.baseBranch ?? this.deps.defaultBranch;
      const diff = await this.deps.git.diff(base, headSha);
      if (diff === null) throw new Error(`the clone cannot diff ${headSha} against ${base}`);
      const key = checkLeaseKey(prNumber, headSha);
      task = store.tasks.createTask({
        kind: 'code',
        title: `Check the review pack for PR #${prNumber}`,
        prompt: this.prompt(prNumber, pr, base, headSha, pack, parseDiffHunks(diff)),
        branch: key,
        originRef: checkOrigin(prNumber),
        originTitle: pr?.title ?? pack.headline,
        dispatchReason: 'The review pack author finished; the checker follows it.',
      });
      const cwd = await this.deps.worktrees.ensureReadOnly(key, headSha);
      this.deps.agents.spawn(task, cwd);
    } catch (err) {
      if (task) {
        const current = store.tasks.getTask(task.id);
        if (current && (current.status === 'queued' || current.status === 'running'))
          store.tasks.updateTask(task.id, { status: 'interrupted' });
        void this.deps.worktrees.remove(task.branch!).catch(() => {});
      }
      errors.record({
        source: 'agent',
        message: `Could not start the review pack checker for PR #${prNumber}: ${(err as Error).message}`,
      });
    }
  }

  private prompt(
    prNumber: number,
    pr: PullRequest | null,
    base: string,
    headSha: string,
    pack: ReviewPack,
    hunks: DiffHunk[],
  ): string {
    const rendered = this.deps.prompts.render('review-pack-check', {
      number: prNumber,
      title: pr?.title ?? '',
      branch: pr?.branch ?? '',
      base,
      headSha,
    });
    return [rendered, diffNote(base, headSha, hunks), skeleton(pack), CHECK_NOTE].join('\n\n');
  }
}

function diffNote(base: string, headSha: string, hunks: DiffHunk[]): string {
  return [
    '## The diff',
    '',
    `The diff of ${headSha} against ${base} has ${hunks.length} hunk(s). Read it in your checkout ` +
      `(\`git diff ${base}...HEAD\`); your checkout is the tree at the head, and the anchors below name ` +
      'ranges in it.',
  ].join('\n');
}

function skeleton(pack: ReviewPack): string {
  const blocks = pack.ideas.map((idea) => {
    const lines = [`### ${idea.id}`, '', `Claim: ${idea.claim}`, '', 'The walk:'];
    idea.anchors.forEach((a, k) => {
      const tag = a.kind === 'hunk' ? 'changed' : 'not in the diff';
      lines.push(`${k + 1}. ${a.range.path}:${a.range.start}-${a.range.end} (${tag})`);
    });
    lines.push(
      '',
      idea.claims.length > 0 ? 'The claims:' : 'No claims under this idea; label it and place it in the order.',
    );
    idea.claims.forEach((c, k) => lines.push(`- claim ${k + 1}: ${c.text}`));
    return lines.join('\n');
  });
  return [
    '## The ideas',
    '',
    `${pack.ideas.length} idea(s). Each is one claim the author makes about what the change does, followed by ` +
      'the steps of its walk — the places in the tree the author says the idea runs through — and the claims it ' +
      'rests on, numbered. `plumbing`, where it appears, is the idea that says its hunks carry nothing to review; ' +
      'check that as you would any other claim.',
    '',
    ...blocks,
  ].join('\n\n');
}

const CHECK_NOTE = [
  '## Handing the verdicts back',
  '',
  'Record them with the `review_pack_check` tool — **that call is the check**, and a run that ends without it ' +
    'has checked nothing. It takes, per idea by id: an `attention` label, its `cue`, and per claim by number a ' +
    '`verdict` with its `evidence`, plus a `finding` on each false claim (a headline, the consequence worked ' +
    'out, the step of the walk it is about, and where the contradicting code is not on the walk, a `counter` ' +
    'range the harness reads off the tree); and the `order` to read the ideas in, every id once. It refuses by ' +
    'field name; fix what it names and call again in the same turn. Every claim and every idea must be answered ' +
    'in one call. You cannot reword a claim, move an anchor or mark anything but a false step, and the tool ' +
    'takes nothing that would let you: what the author wrote stays as written, beside your verdict on it.',
].join('\n');
