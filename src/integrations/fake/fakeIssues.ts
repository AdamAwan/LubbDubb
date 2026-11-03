import { nanoid } from 'nanoid';
import { issueOriginRef } from '../../issueOrigins.js';
import type { InjectableEvent } from '../connector.js';
import type {
  IssueCloseInput,
  IssueCommentInput,
  IssueImageInput,
  IssueImageResult,
  IssueCreateInput,
  IssueKeyHit,
  IssueLabelInput,
  SendResult,
  WorkItemLinkInput,
  WorkItemStateInput,
} from '../../sink/actionSink.js';
import type {
  WorldCapability,
  Injectable,
  Integration,
  IssueCommentCapable,
  IssueCommentReadable,
  IssueImageCapable,
  IssueCreateCapable,
  IssueCloseCapable,
  IssueKeySearchCapable,
  IssueLabelCapable,
  IssueReopenCapable,
  TicketHistoryCapable,
  WorkItemLinkCapable,
  WorkItemStateCapable,
  WorldSlice,
} from '../integration.js';
import type { TrackerComment, TrackerItem } from '../../types.js';
import type { FakeWorldStore } from './fakeWorld.js';
import { bodyCarriesKey, issueBodyWithRefs } from '../../tickets/searchKey.js';

// → docs/spec/15-integrations.md

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set([
  'new_issue',
  'issue_state',
  'issue_linked_pr',
  'issue_comment',
]);

/** Who the fake says posted the harness's own comments — the operator's login, as on a single-operator deployment. */
const FAKE_VIEWER = 'operator';

export class FakeIssuesIntegration
  implements
    Integration,
    Injectable,
    WorkItemStateCapable,
    WorkItemLinkCapable,
    IssueLabelCapable,
    IssueCloseCapable,
    IssueCreateCapable,
    IssueCommentCapable,
    IssueCommentReadable,
    IssueImageCapable,
    IssueKeySearchCapable,
    IssueReopenCapable,
    TicketHistoryCapable
{
  readonly id = 'issues:fake';
  readonly capability: WorldCapability = 'issues';

  private readonly comments = new Map<string, { number: number } & TrackerComment>();
  private nextCommentId = 1;
  private lastCommentAt = 0;

  /** @public read by tests asserting a screen actually reached a ticket, and with what bytes */
  readonly attachments = new Map<string, { number: number; fileName: string; bytes: Buffer }>();
  private nextAttachmentId = 1;

  private readonly seenAt = new Map<number, string>();
  private readonly closedAt = new Map<number, string>();

  /** @public set by a test to make the next key searches fail, as a tracker that cannot answer does */
  keySearchFailure: string | null = null;

  /** @public read by tests asserting how many searches a press or a pass made */
  keySearches = 0;

  constructor(
    private readonly world: FakeWorldStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async snapshot(): Promise<WorldSlice> {
    return { issues: this.world.read().issues.map((i) => ({ ...i, labelsAddedByViewer: i.labels })) };
  }

  async listTicketHistory(_since: string): Promise<TrackerItem[]> {
    const ts = this.now();
    return this.world.read().issues.map((issue) => {
      const createdAt = this.seenAt.get(issue.number) ?? ts;
      this.seenAt.set(issue.number, createdAt);
      return {
        number: issue.number,
        title: issue.title,
        labels: issue.labels,
        state: issue.state,
        workItemState: issue.workItemState ?? null,
        url: null,
        createdAt,
        changedAt: ts,
      };
    });
  }

  handles(kind: InjectableEvent['kind']): boolean {
    return KINDS.has(kind);
  }

  inject(event: InjectableEvent): void {
    if (event.kind === 'issue_comment') {
      this.postComment(event.number, event.body, event.author, null);
      return;
    }
    this.world.mutate((world) => {
      switch (event.kind) {
        case 'new_issue':
          if (!world.issues.some((i) => i.number === event.number)) {
            world.issues.push({
              id: `issue_${nanoid(6)}`,
              number: event.number,
              title: event.title,
              body: event.body ?? '',
              labels: event.labels ?? [],
              state: 'open',
              linkedPrNumber: null,
            });
          }
          break;
        case 'issue_state': {
          const issue = world.issues.find((i) => i.number === event.number);
          if (issue) issue.state = event.state;
          if (event.state === 'closed') this.closedAt.set(event.number, this.now());
          break;
        }
        case 'issue_linked_pr': {
          const issue = world.issues.find((i) => i.number === event.number);
          if (issue) issue.linkedPrNumber = event.prNumber;
          break;
        }
      }
    });
  }

  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === input.number);
      if (!issue) return;
      const labels = new Set(issue.labels);
      if (input.present) labels.add(input.label);
      else labels.delete(input.label);
      issue.labels = [...labels];
    });
    return { ok: true };
  }

  async closeIssue(input: IssueCloseInput): Promise<SendResult> {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === input.number);
      if (issue) issue.state = 'closed';
    });
    this.closedAt.set(input.number, this.now());
    return { ok: true, ref: issueOriginRef('root', input.number) };
  }

  async findIssuesByKeys(keys: readonly string[]): Promise<Map<string, IssueKeyHit[]>> {
    this.keySearches += 1;
    if (this.keySearchFailure !== null) throw new Error(this.keySearchFailure);
    const issues = this.world.read().issues;
    return new Map(
      keys.map((key) => [
        key,
        issues
          .filter((i) => bodyCarriesKey(i.body, key))
          .map((i) => ({
            ref: issueOriginRef('root', i.number),
            state: i.state,
            closedAt: i.state === 'closed' ? (this.closedAt.get(i.number) ?? null) : null,
          })),
      ]),
    );
  }

  async reopenIssue(number: number): Promise<SendResult> {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === number);
      if (issue) issue.state = 'open';
    });
    this.closedAt.delete(number);
    return { ok: true, ref: issueOriginRef('root', number) };
  }

  async linkWorkItem(input: WorkItemLinkInput): Promise<SendResult> {
    this.markIssueLinked(input.number, input.prNumber);
    return { ok: true, ref: `${input.number}->${input.prNumber}` };
  }

  async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === input.number);
      if (issue) issue.workItemState = input.state;
    });
    return { ok: true };
  }

  /**
   * The scripted half of `IssueImageCapable`. It holds the bytes rather than dropping them, because a
   * fake that answered a URL for an image it never took would let a test assert a screen reached a
   * ticket that could not have carried it.
   */
  async attachIssueImage(input: IssueImageInput): Promise<IssueImageResult> {
    const id = `att_${this.nextAttachmentId++}`;
    this.attachments.set(id, { number: input.number, fileName: input.fileName, bytes: input.bytes });
    return { ok: true, url: `https://fake.attachments.test/${id}/${encodeURIComponent(input.fileName)}` };
  }

  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    return { ok: true, ref: this.postComment(input.number, input.body, FAKE_VIEWER, input.commentRef) };
  }

  async listIssueComments(number: number, since: string | null): Promise<TrackerComment[]> {
    return [...this.comments.values()]
      .filter((c) => c.number === number && (since === null || Date.parse(c.createdAt) > Date.parse(since)))
      .map(({ id, author, body, createdAt }) => ({ id, author, body, createdAt }));
  }

  private postComment(number: number, body: string, author: string, ref: string | null): string {
    const existing = ref === null ? undefined : this.comments.get(ref);
    if (existing !== undefined) {
      existing.body = body;
      return existing.id;
    }
    const id = ref ?? `comment_${this.nextCommentId++}`;
    this.lastCommentAt = Math.max(this.lastCommentAt + 1, Date.parse(this.now()));
    this.comments.set(id, { number, id, author, body, createdAt: new Date(this.lastCommentAt).toISOString() });
    return id;
  }

  async createIssue(input: IssueCreateInput): Promise<SendResult> {
    const number = this.nextIssueNumber();
    this.world.mutate((world) => {
      world.issues.push({
        id: `issue_${nanoid(6)}`,
        number,
        title: input.title,
        body: issueBodyWithRefs(input),
        labels: [...input.labels],
        state: 'open',
        linkedPrNumber: null,
      });
    });
    return { ok: true, ref: issueOriginRef('root', number) };
  }

  private nextIssueNumber(): number {
    return this.world.read().issues.reduce((max, i) => Math.max(max, i.number), 0) + 1;
  }

  markIssueLinked(issueNumber: number, prNumber: number): void {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === issueNumber);
      if (issue) issue.linkedPrNumber = prNumber;
    });
  }
}
