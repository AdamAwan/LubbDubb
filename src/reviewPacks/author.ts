import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { AgentManager } from '../agents/agentManager.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import { issueForPr } from '../prIssue.js';
import type { RuntimeControl } from '../runtimeControl.js';
import { goalOriginFor, padOriginFor } from '../scratch/pad.js';
import type { Store } from '../store/store.js';
import type { Agent, PlanAtom, PullRequest, ReviewPackRecord, ReviewRange, ScratchEntry, Task } from '../types.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import { atomList, atomsForPr } from './atoms.js';
import { parseDiffHunks, type DiffHunk } from './hunks.js';
import { checkOrigin, packLeaseHead, packLeaseKey, packOrigin, packTargetPr } from './origins.js';
import { assemblePack, type Commission } from './submission.js';

// → docs/spec/31-review-packs.md

interface AuthorDeps {
  store: Store;
  agents: Pick<AgentManager, 'spawn'>;
  worktrees: Worktrees;
  git: GitObserver;
  prompts: PromptTemplates;
  defaultBranch: string;
  runtime: Pick<RuntimeControl, 'paused'>;
  fetch?: () => Promise<void>;
  errors: ErrorRecorder;
}

interface AuthorEvents {
  written: [{ record: ReviewPackRecord }];
}

type PackRequestOutcome =
  | { ok: true; prNumber: number; headSha: string; originRef: string }
  | { ok: false; status: 404 | 409; error: string };

export class ReviewPackAuthor extends EventEmitter {
  private readonly composing = new Set<number>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: AuthorDeps) {
    super();
  }

  override emit<K extends keyof AuthorEvents>(event: K, ...args: AuthorEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof AuthorEvents>(event: K, listener: (...args: AuthorEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  request(prNumber: number): PackRequestOutcome {
    const pr = this.openPr(prNumber);
    if (!pr) return { ok: false, status: 404, error: `no open pull request #${prNumber}` };
    if (!pr.headSha) {
      return {
        ok: false,
        status: 409,
        error: `the provider reports no head for #${prNumber}, so there is nothing to write a pack against`,
      };
    }
    const originRef = packOrigin(prNumber);
    if (this.composing.has(prNumber) || this.deps.store.tasks.findActiveTaskByOrigin(originRef)) {
      return { ok: false, status: 409, error: `a pack for #${prNumber} is already being written` };
    }
    if (this.deps.store.tasks.findActiveTaskByOrigin(checkOrigin(prNumber))) {
      return { ok: false, status: 409, error: `the pack for #${prNumber} is being checked` };
    }
    if (this.deps.runtime.paused) {
      return { ok: false, status: 409, error: 'dispatch is paused; resume it to ask for a pack' };
    }
    this.composing.add(prNumber);
    const run = this.compose(pr, pr.headSha).finally(() => {
      this.composing.delete(prNumber);
      this.inflight.delete(run);
    });
    this.inflight.add(run);
    return { ok: true, prNumber, headSha: pr.headSha, originRef };
  }

  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  writing(prNumber: number): boolean {
    return this.composing.has(prNumber) || this.deps.store.tasks.findActiveTaskByOrigin(packOrigin(prNumber)) !== null;
  }

  async submit(
    agent: Agent,
    task: Task,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; record: ReviewPackRecord } | { ok: false; error: string }> {
    const prNumber = packTargetPr(task.originRef);
    const headSha = packLeaseHead(task.branch);
    if (prNumber === null || headSha === null) {
      return {
        ok: false,
        error:
          'review_pack_submit is for an agent dispatched to write a review pack, and this run was dispatched for ' +
          `${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      };
    }
    const facts = await this.commission(prNumber, headSha, agent.cwd);
    if (!facts.ok) return facts;
    const assembled = assemblePack(facts.commission, args);
    if (!assembled.ok) return assembled;
    const record = this.deps.store.reviewPacks.recordReviewPack(assembled.pack);
    this.emit('written', { record });
    return { ok: true, record };
  }

  async staleness(
    prNumber: number,
    packHead: string,
  ): Promise<{ head: string | null; stale: { headSha: string; commitsBehind: number | null } | null }> {
    const world = this.deps.store.world.getWorldBaseline();
    const pr =
      world?.pullRequests.find((p) => p.number === prNumber) ??
      world?.closedPullRequests?.find((p) => p.number === prNumber);
    const head = pr?.headSha ?? null;
    if (head === null || head === packHead) return { head, stale: null };
    const moved = await this.deps.git.divergence(head, packHead);
    return { head, stale: { headSha: head, commitsBehind: moved?.ahead ?? null } };
  }

  private openPr(prNumber: number): PullRequest | null {
    return this.deps.store.world.getWorldBaseline()?.pullRequests.find((p) => p.number === prNumber) ?? null;
  }

  private atoms(prNumber: number): PlanAtom[] {
    return atomsForPr(prNumber, this.deps.store.plans.listAllPlanParts(), this.deps.store.plans.listAllPlanAtoms());
  }

  private baseOf(prNumber: number): string {
    return this.openPr(prNumber)?.baseBranch ?? this.deps.defaultBranch;
  }

  private pads(pr: PullRequest): { goal: string | null; own: string; entries: ScratchEntry[] } {
    const { store } = this.deps;
    const world = store.world.getWorldBaseline();
    const issue = world ? issueForPr(pr, world.issues) : null;
    const goal = issue ? goalOriginFor(`issue:${issue.number}`) : null;
    const own = padOriginFor(packOrigin(pr.number))!;
    const entries = [...(goal ? store.scratch.listScratchEntries(goal) : []), ...store.scratch.listScratchEntries(own)];
    return { goal, own, entries };
  }

  private async commission(
    prNumber: number,
    headSha: string,
    cwd: string,
  ): Promise<{ ok: true; commission: Commission } | { ok: false; error: string }> {
    const diff = await this.deps.git.diff(this.baseOf(prNumber), headSha);
    if (diff === null) {
      return {
        ok: false,
        error: `the clone cannot diff #${prNumber} at ${headSha} any more; the pack was not recorded. Tell the operator.`,
      };
    }
    const pr = this.openPr(prNumber);
    const entries = pr
      ? this.pads(pr).entries
      : this.deps.store.scratch.listScratchEntries(padOriginFor(packOrigin(prNumber))!);
    return {
      ok: true,
      commission: {
        prNumber,
        headSha,
        hunks: parseDiffHunks(diff),
        atoms: this.atoms(prNumber).map((a) => a.slug),
        entries,
        readRegion: (range) => readRegion(cwd, range),
      },
    };
  }

  private async compose(pr: PullRequest, headSha: string): Promise<void> {
    const { store, errors } = this.deps;
    const originRef = packOrigin(pr.number);
    let task: Task | null = null;
    try {
      await this.deps.fetch?.();
      const diff = await this.deps.git.diff(pr.baseBranch ?? this.deps.defaultBranch, headSha);
      if (diff === null)
        throw new Error(`the clone cannot diff ${headSha} against ${pr.baseBranch ?? this.deps.defaultBranch}`);
      const hunks = parseDiffHunks(diff);
      const pads = this.pads(pr);
      const key = packLeaseKey(pr.number, headSha);
      task = store.tasks.createTask({
        kind: 'code',
        title: `Review pack for PR #${pr.number}`,
        prompt: this.prompt(pr, headSha, hunks, pads, this.atoms(pr.number)),
        branch: key,
        originRef,
        originTitle: pr.title,
        dispatchReason: 'A reviewer asked for a review pack from the cockpit.',
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
        message: `Could not start the review pack author for PR #${pr.number}: ${(err as Error).message}`,
      });
    }
  }

  private prompt(
    pr: PullRequest,
    headSha: string,
    hunks: DiffHunk[],
    pads: { goal: string | null; own: string; entries: ScratchEntry[] },
    atoms: readonly PlanAtom[],
  ): string {
    const base = pr.baseBranch ?? this.deps.defaultBranch;
    const rendered = this.deps.prompts.render('review-pack-author', {
      number: pr.number,
      title: pr.title,
      branch: pr.branch,
      base,
      headSha,
    });
    return [rendered, hunkList(hunks, base, headSha), witnessLog(pr, pads), atomList(atoms), SUBMISSION_NOTE]
      .filter((section) => section !== '')
      .join('\n\n');
  }
}

export function readRegion(cwd: string, range: ReviewRange): string[] | null {
  if (isAbsolute(range.path) || range.path.split(/[\\/]/).includes('..')) return null;
  const root = resolve(cwd);
  const file = resolve(root, range.path);
  if (!file.startsWith(root + sep)) return null;
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (range.end > lines.length) return null;
  return lines.slice(range.start - 1, range.end);
}

function hunkList(hunks: DiffHunk[], base: string, headSha: string): string {
  const rows = hunks.map(
    (h) => `- ${h.id}: ${h.range.path}:${h.range.start}-${h.range.end} (+${h.added} −${h.removed})`,
  );
  return [
    '## The hunks',
    '',
    `The diff of ${headSha} against ${base} has ${hunks.length} hunk(s), and these are their ids. Read the diff ` +
      'itself in your checkout (`git diff ' +
      `${base}...HEAD\`); the ranges below are where each hunk's lines stand at the head.`,
    '',
    ...(rows.length > 0 ? rows : ['(none — the diff is empty, and a pack for it owns nothing)']),
    '',
    '**Every hunk has exactly one owning idea.** A hunk anchor names a hunk by this id and nothing else; the ' +
      'harness fills in its range and code from the diff. Give a hunk that carries nothing to review — a rename, ' +
      'formatting, a lockfile — to the reserved idea `plumbing`, and say so in its claim. A pack that leaves a hunk ' +
      'unowned, or owns one twice, is refused with the hunk named. A `region` anchor may cover a hunk another idea ' +
      'owns: that is how shared code is walked past from two ideas while one of them owns it.',
  ].join('\n');
}

function witnessLog(pr: PullRequest, pads: { goal: string | null; own: string; entries: ScratchEntry[] }): string {
  const head = ['## The witness log', ''];
  if (pads.entries.length === 0) {
    return [
      ...head,
      `Nobody witnessed this pull request: neither ${pads.goal ?? 'a linked goal'} nor ${pads.own} has an entry` +
        `${pads.goal ? '' : `, and the harness links PR #${pr.number} to no goal`}. ` +
        'Every claim is therefore `inferred`, and the pack says so in its header — do not invent a witness. What ' +
        'survives is the idea grouping, the `region` anchors and the claims, which is more than this pull request ' +
        'had before.',
    ].join('\n');
  }
  const rows = pads.entries.map(entryBlock);
  return [
    ...head,
    `What the agents that worked this change wrote as they went — the pad of the goal (${pads.goal ?? 'none'}) ` +
      `and the pull request's own (${pads.own}), oldest first, verbatim. Each entry has an id; a claim traceable ` +
      'to one cites it as `witnessed`, and where an entry and the code disagree the code wins and the claim is ' +
      '`disputed`, citing the entry it contradicts. A rejected alternative is never a claim: it reaches the pack ' +
      'only as the provenance beside the claim it informed.',
    '',
    ...rows,
  ].join('\n');
}

function entryBlock(e: ScratchEntry): string {
  const lines = [`- ${e.id} · ${e.createdAt} · ${e.authorOriginRef}${e.topic ? ` · ${e.topic}` : ''}`];
  for (const l of e.note.split('\n')) lines.push(`  ${l}`);
  if (e.decision) {
    lines.push(`  fork — chose: ${e.decision.chose}`);
    lines.push(`  because: ${e.decision.because}`);
    for (const r of e.decision.rejected) lines.push(`  rejected: ${r.alternative} — ${r.because}`);
    if (e.decision.paths.length > 0) lines.push(`  paths: ${e.decision.paths.join(', ')}`);
  }
  return lines.join('\n');
}

const SUBMISSION_NOTE = [
  '## Handing the pack back',
  '',
  'Submit it with the `review_pack_submit` tool — **that call is the pack**. A run that ends without it has ' +
    'written nothing. The tool refuses by field name, so fix what it names and call again in the same turn. It ' +
    'copies the pull request and head, sets the schema, mints every idea id but `plumbing`, fills every hunk ' +
    "anchor's range and code from the diff and every region anchor's code from the tree, and reads `witnessed` " +
    'off the log — you supply the ideas, the claims, the gists, the notes and the ranges of the regions. Do not ' +
    "write verdicts, attention labels, cues or a reading order: those are the checker's, and a pack you " +
    'submit has none.',
].join('\n');
