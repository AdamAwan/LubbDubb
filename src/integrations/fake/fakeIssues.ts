import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../../connector/connector.js';
import type { IssueCommentInput, IssueLabelInput, SendResult, WorkItemStateInput } from '../../sink/actionSink.js';
import type {
  Capability,
  Injectable,
  Integration,
  IssueCommentCapable,
  IssueLabelCapable,
  WorkItemStateCapable,
  WorldSlice,
} from '../integration.js';
import type { FakeWorldStore } from './fakeWorld.js';

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set(['new_issue', 'issue_state', 'issue_linked_pr']);

/**
 * The fake `issues` provider: it owns the issues slice of the world — the tracker
 * items the harness picks up and resolves into pull requests. A real GitHub Issues
 * adapter drops in under `issues` in its place, reading from the Issues API instead
 * of an injected fake world.
 */
export class FakeIssuesIntegration
  implements Integration, Injectable, WorkItemStateCapable, IssueLabelCapable, IssueCommentCapable
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

  constructor(private readonly world: FakeWorldStore) {}

  async snapshot(): Promise<WorldSlice> {
    return { issues: this.world.read().issues };
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
