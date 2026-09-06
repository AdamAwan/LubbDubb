import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../../connector/connector.js';
import type {
  IssueCloseInput,
  IssueCommentInput,
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
    TicketHistoryCapable
{
  readonly id = 'issues:fake';
  readonly capability: WorldCapability = 'issues';

  private readonly comments = new Map<string, { number: number; body: string }>();
  private nextCommentId = 1;

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
    return { ok: true, ref: `issue:${input.number}` };
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
    return { ok: true, ref: `issue:${number}` };
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
