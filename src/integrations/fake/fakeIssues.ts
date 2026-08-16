import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../../connector/connector.js';
import type { IssueCommentInput, IssueLabelInput, SendResult, WorkItemStateInput } from '../../sink/actionSink.js';
import type {
  Capability,
  Injectable,
  Integration,
  IssueCommentCapable,
  IssueLabelCapable,
  TicketHistoryCapable,
  WorkItemStateCapable,
  WorldSlice,
} from '../integration.js';
import type { TrackerItem } from '../../types.js';
import type { FakeWorldStore } from './fakeWorld.js';

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set(['new_issue', 'issue_state', 'issue_linked_pr']);

/**
 * The fake `issues` provider: it owns the issues slice of the world — the tracker
 * items the harness picks up and resolves into pull requests. A real GitHub Issues
 * adapter drops in under `issues` in its place, reading from the Issues API instead
 * of an injected fake world.
 */
export class FakeIssuesIntegration
  implements Integration, Injectable, WorkItemStateCapable, IssueLabelCapable, IssueCommentCapable, TicketHistoryCapable
{
  readonly id = 'issues:fake';
  readonly capability: Capability = 'issues';

  /**
   * Comments the harness has written, keyed by the ref it handed back — the fake's
   * stand-in for a provider comment store, so the "edit in place" contract (one
   * living plan comment, not a stream) is exercised end to end without a network.
   */
  private readonly comments = new Map<string, { number: number; body: string }>();
  private nextCommentId = 1;

  /**
   * When each fake issue was first seen, so the mirror has the two instants a real
   * tracker supplies. In memory rather than in the fake world document: the
   * document is the *world*, and stamping tracker metadata into it would have the
   * fake modelling something no provider puts there.
   */
  private readonly seenAt = new Map<number, string>();

  constructor(
    private readonly world: FakeWorldStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Every label reads as one the viewer added.
   *
   * The ownership gate (`userId`) narrows pickup to watch tags *you* applied, and
   * it reads `labelsAddedByViewer` rather than `labels`. The real providers resolve
   * that from tag history; a fake world has exactly one actor, so mirroring the
   * labels is the honest answer rather than a convenience — there is nobody else in
   * here to have added them.
   *
   * Populated unconditionally, not behind a flag the fake would have to be told
   * about: leaving it unset makes the gate resolve every fake issue's labels to the
   * empty list, and *nothing is ever picked up* — silently, since an issue that is
   * simply not eligible looks exactly like one nothing has got to yet.
   */
  async snapshot(): Promise<WorldSlice> {
    return { issues: this.world.read().issues.map((i) => ({ ...i, labelsAddedByViewer: i.labels })) };
  }

  /**
   * The fake's ticket history: its whole issue list, in whatever state each is in.
   *
   * `since` is deliberately **ignored**. A fake that filtered on it would be
   * asserting the provider's own query rather than the mirror's behaviour, and the
   * upsert behind this is idempotent — so serving everything every sweep exercises
   * exactly the path a real provider's incremental read lands in, and does it on
   * the first pulse of every test that has issues.
   *
   * This is what gives the Tickets tab a populated list on the `fake` provider,
   * which is how the tab is developed and demonstrated at all.
   */
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

  /** The outbound side of the watch/ignore toggle: add/remove a label on the fake issue. Idempotent. */
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

  /** Reflect an "in review" back-off into the fake world, so the state gate sees it next cycle. */
  async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === input.number);
      if (issue) issue.workItemState = input.state;
    });
    return { ok: true };
  }

  /** Create or edit a comment in the fake's own comment store, mirroring the real providers. */
  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    const ref = input.commentRef ?? `comment_${this.nextCommentId++}`;
    this.comments.set(ref, { number: input.number, body: input.body });
    return { ok: true, ref };
  }

  /** Reflect harness progress: an agent opened a PR that resolves this issue. */
  markIssueLinked(issueNumber: number, prNumber: number): void {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === issueNumber);
      if (issue) issue.linkedPrNumber = prNumber;
    });
  }
}
