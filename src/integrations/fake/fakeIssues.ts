import { nanoid } from 'nanoid';
import { issueOriginRef } from '../../issueOrigins.js';
import type { InjectableEvent } from '../connector.js';
import type {
  IssueCloseInput,
  IssueCommentInput,
  IssueImageInput,
  IssueImageResult,
  IssueCreateInput,
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
  IssueImageCapable,
  IssueCreateCapable,
  IssueCloseCapable,
  IssueLabelCapable,
  TicketHistoryCapable,
  WorkItemLinkCapable,
  WorkItemStateCapable,
  WorldSlice,
} from '../integration.js';
import type { TrackerItem } from '../../types.js';
import type { FakeWorldStore } from './fakeWorld.js';

// → docs/spec/15-integrations.md

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set(['new_issue', 'issue_state', 'issue_linked_pr']);

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
    IssueImageCapable,
    TicketHistoryCapable
{
  readonly id = 'issues:fake';
  readonly capability: WorldCapability = 'issues';

  private readonly comments = new Map<string, { number: number; body: string }>();
  private nextCommentId = 1;

  /** @public read by tests asserting a screen actually reached a ticket, and with what bytes */
  readonly attachments = new Map<string, { number: number; fileName: string; bytes: Buffer }>();
  private nextAttachmentId = 1;

  private readonly seenAt = new Map<number, string>();

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
    return { ok: true, ref: issueOriginRef('root', input.number) };
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
    const ref = input.commentRef ?? `comment_${this.nextCommentId++}`;
    this.comments.set(ref, { number: input.number, body: input.body });
    return { ok: true, ref };
  }

  async createIssue(input: IssueCreateInput): Promise<SendResult> {
    const number = this.nextIssueNumber();
    this.world.mutate((world) => {
      world.issues.push({
        id: `issue_${nanoid(6)}`,
        number,
        title: input.title,
        body: input.relatedTo === null ? input.body : `${input.body}\n\nRelated to #${input.relatedTo}.`,
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
