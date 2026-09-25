import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../connector.js';
import type {
  BranchDeleteInput,
  PrBaseInput,
  PrAssignInput,
  PrBodyInput,
  PrBaseUpdateInput,
  PrCloseInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrThreadResolveInput,
  PrTitleInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { PrThreadState, PullRequest } from '../../types.js';
import { threadComments } from '../../pr/prThreads.js';
import type {
  BranchDeleteCapable,
  WorldCapability,
  Injectable,
  Integration,
  PrBaseCapable,
  PrAssignCapable,
  PrBaseUpdateCapable,
  PrCloseCapable,
  PrCreateCapable,
  PrLabelCapable,
  PrMergeCapable,
  PrReplyCapable,
  PrThreadResolveCapable,
  PrTitleCapable,
  PrBodyCapable,
  WorldSlice,
} from '../integration.js';
import type { FakeWorld, FakeWorldStore } from './fakeWorld.js';

// → docs/spec/15-integrations.md

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set([
  'new_pr',
  'pr_pushed',
  'ci_failed',
  'ci_passed',
  'pr_comment',
  'pr_approved',
  'pr_mergeable',
  'pr_size',
  'pr_closed',
]);

export class FakeGitHubIntegration
  implements
    Integration,
    PrReplyCapable,
    PrThreadResolveCapable,
    PrMergeCapable,
    PrCloseCapable,
    PrLabelCapable,
    PrCreateCapable,
    PrTitleCapable,
    PrBodyCapable,
    PrBaseCapable,
    PrAssignCapable,
    PrBaseUpdateCapable,
    BranchDeleteCapable,
    Injectable
{
  private readonly bodies = new Map<number, string>();
  readonly id = 'sourceControl:fake';
  readonly capability: WorldCapability = 'sourceControl';

  constructor(
    private readonly world: FakeWorldStore,
    private readonly defaultBranch = 'main',
  ) {}

  async snapshot(): Promise<WorldSlice> {
    const world = this.world.read();
    return { pullRequests: world.pullRequests, closedPullRequests: world.closedPullRequests };
  }

  handles(kind: InjectableEvent['kind']): boolean {
    return KINDS.has(kind);
  }

  inject(event: InjectableEvent): void {
    this.world.mutate((world) => {
      switch (event.kind) {
        case 'ci_failed':
          mutatePr(world, event.prNumber, (pr) => (pr.ciStatus = 'failing'));
          break;
        case 'ci_passed':
          mutatePr(world, event.prNumber, (pr) => (pr.ciStatus = 'passing'));
          break;
        case 'pr_pushed':
          mutatePr(world, event.prNumber, (pr) => (pr.headSha = event.headSha));
          break;
        case 'pr_approved':
          mutatePr(world, event.prNumber, (pr) => (pr.approved = true));
          break;
        case 'pr_mergeable':
          mutatePr(world, event.prNumber, (pr) => {
            pr.mergeable = event.mergeable ?? true;
            if (event.mergeableState !== undefined) pr.mergeableState = event.mergeableState;
          });
          break;
        case 'pr_size':
          mutatePr(world, event.prNumber, (pr) => (pr.changedFiles = event.changedFiles));
          break;
        case 'pr_comment':
          mutatePr(world, event.prNumber, (pr) => {
            const threads = pr.reviewThreads ?? [];
            threads.push({ id: `c_${nanoid(6)}`, author: event.author, body: event.body, state: 'open', replies: [] });
            pr.reviewThreads = threads;
            pr.unresolvedComments = threadComments(threads);
          });
          break;
        case 'pr_closed':
          closeFromEvent(world, event);
          break;
        case 'new_pr':
          openFromEvent(world, event, this.defaultBranch);
          break;
      }
    });
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const replyId = input.commentId ? this.markCommentHandled(input.prNumber, input.commentId, input.body) : null;
    const ref = `fake-reply_${nanoid(6)}`;
    return { ok: true, ref, ...(replyId === null ? {} : { commentRef: replyId }) };
  }

  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    const { found } = this.setThreadState(input.prNumber, input.commentId, 'resolved');
    return { ok: found, ref: found ? `fake-resolve_${nanoid(6)}` : undefined };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    this.world.mutate((world) => mutatePr(world, input.prNumber, (pr) => (pr.merged = true)));
    const ref = `fake-merge_${nanoid(6)}`;
    return { ok: true, ref };
  }

  closePr(input: PrCloseInput): Promise<SendResult> {
    this.world.mutate((world) => {
      const idx = world.pullRequests.findIndex((p) => p.number === input.prNumber);
      if (idx === -1) return;
      const [pr] = world.pullRequests.splice(idx, 1);
      world.closedPullRequests.push({ ...pr!, merged: false, state: 'closed', closedAt: new Date().toISOString() });
    });
    return Promise.resolve({ ok: true, ref: `fake-close_${nanoid(6)}` });
  }

  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    this.world.mutate((world) => {
      mutatePr(world, input.prNumber, (pr) => {
        const labels = new Set(pr.labels ?? []);
        if (input.present) labels.add(input.label);
        else labels.delete(input.label);
        pr.labels = [...labels];
      });
    });
    const ref = `fake-label_${nanoid(6)}`;
    return { ok: true, ref };
  }

  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    let number = 0;
    this.world.mutate((world) => {
      number = world.pullRequests.reduce((max, p) => Math.max(max, p.number), 0) + 1;
      world.pullRequests.push({
        id: `pr_${nanoid(6)}`,
        number,
        title: input.title,
        branch: input.branch,
        baseBranch: input.base,
        ciStatus: 'pending',
        unresolvedComments: [],
        reviewThreads: [],
        approved: false,
        mergeableState: 'unknown',
        merged: false,
        labels: [],
      });
    });
    this.bodies.set(number, input.body);
    return { ok: true, ref: String(number) };
  }

  async setPullTitle(input: PrTitleInput): Promise<SendResult> {
    this.world.mutate((world) => {
      mutatePr(world, input.prNumber, (pr) => (pr.title = input.title));
    });
    return { ok: true, ref: `fake-title_${nanoid(6)}` };
  }

  async setPullBody(input: PrBodyInput): Promise<SendResult> {
    this.bodies.set(input.prNumber, input.body);
    return { ok: true, ref: `fake-body_${nanoid(6)}` };
  }

  /**
   * The body one pull request carries. Kept beside the world rather than on
   * `PullRequest`, because no reading the harness makes needs a pull request's body
   * and a domain field nothing reads is a field the next change has to keep true.
   *
   * @public the seam a test asserts a pushed description through
   */
  pullBody(prNumber: number): string | null {
    return this.bodies.get(prNumber) ?? null;
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    this.world.mutate((world) => {
      mutatePr(world, input.prNumber, (pr) => (pr.baseBranch = input.base));
    });
    return { ok: true, ref: `fake-base_${nanoid(6)}` };
  }

  async assignPr(input: PrAssignInput): Promise<SendResult> {
    this.world.mutate((world) => {
      mutatePr(world, input.prNumber, (pr) => {
        const on = pr.assignees ?? [];
        if (!on.some((p) => p.id === input.personId))
          pr.assignees = [...on, { id: input.personId, name: input.personId }];
      });
    });
    return { ok: true, ref: input.personId };
  }

  async updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    this.world.mutate((world) =>
      mutatePr(world, input.prNumber, (pr) => {
        pr.mergeableState = 'clean';
        pr.mergeable = true;
      }),
    );
    return { ok: true, ref: `fake-base-update_${nanoid(6)}` };
  }

  deleteBranch(input: BranchDeleteInput): Promise<SendResult> {
    return Promise.resolve({ ok: true, ref: input.branch });
  }

  markCommentHandled(prNumber: number, commentId: string, body?: string): string | null {
    return this.setThreadState(prNumber, commentId, 'answered', body).replyId;
  }

  private setThreadState(
    prNumber: number,
    commentId: string,
    state: PrThreadState,
    reply?: string,
  ): { found: boolean; replyId: string | null } {
    let found = false;
    let replyId: string | null = null;
    this.world.mutate((world) => {
      mutatePr(world, prNumber, (pr) => {
        const threads = pr.reviewThreads ?? [];
        const thread = threads.find((t) => t.id === commentId);
        if (!thread) return;
        found = true;
        thread.state = state;
        if (reply !== undefined) {
          replyId = `r_${nanoid(6)}`;
          thread.replies.push({ id: replyId, author: 'lubbdubb', body: reply, ours: true });
        }
        pr.reviewThreads = threads;
        pr.unresolvedComments = threadComments(threads);
      });
    });
    return { found, replyId };
  }
}

function mutatePr(world: FakeWorld, prNumber: number, fn: (pr: PullRequest) => void): void {
  const pr = world.pullRequests.find((p) => p.number === prNumber);
  if (pr) fn(pr);
}

function closeFromEvent(world: FakeWorld, event: Extract<InjectableEvent, { kind: 'pr_closed' }>): void {
  const idx = world.pullRequests.findIndex((p) => p.number === event.prNumber);
  if (idx === -1) return;
  const [pr] = world.pullRequests.splice(idx, 1);
  const merged = event.merged ?? pr!.merged ?? false;
  world.closedPullRequests.push({
    ...pr!,
    merged,
    state: merged ? 'merged' : 'closed',
    closedAt: new Date().toISOString(),
    ...(merged ? { mergeCommitSha: event.mergeCommitSha ?? mergeShaFor(event.prNumber) } : {}),
  });
}

function openFromEvent(
  world: FakeWorld,
  event: Extract<InjectableEvent, { kind: 'new_pr' }>,
  defaultBranch: string,
): void {
  if (world.pullRequests.some((p) => p.number === event.number)) return;
  world.pullRequests.push({
    id: `pr_${nanoid(6)}`,
    number: event.number,
    title: event.title,
    branch: event.branch,
    baseBranch: event.baseBranch ?? defaultBranch,
    ciStatus: 'pending',
    unresolvedComments: [],
    reviewThreads: [],
    approved: false,
    mergeableState: 'unknown',
    merged: false,
    labels: event.labels ?? [],
    ...(event.headSha === undefined ? {} : { headSha: event.headSha }),
    ...(event.author === undefined ? {} : { author: event.author }),
    ...(event.viewerAuthored === undefined ? {} : { viewerAuthored: event.viewerAuthored }),
    ...(event.viewerAssignment === undefined ? {} : { viewerAssignment: event.viewerAssignment }),
    ...(event.viewerApproved === undefined ? {} : { viewerApproved: event.viewerApproved }),
  });
}

export function mergeShaFor(prNumber: number): string {
  return `merge${String(prNumber).padStart(7, '0')}`;
}
