import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../../connector/connector.js';
import type { SendResult, WorkItemStateInput } from '../../sink/actionSink.js';
import type { Capability, Injectable, Integration, WorkItemStateCapable, WorldSlice } from '../integration.js';
import type { FakeWorldStore } from './fakeWorld.js';

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set(['new_issue', 'issue_state', 'issue_linked_pr']);

/**
 * The fake `issues` provider: it owns the issues slice of the world — the tracker
 * items the harness picks up and resolves into pull requests. A real GitHub Issues
 * adapter drops in under `issues` in its place, reading from the Issues API instead
 * of an injected fake world.
 */
export class FakeIssuesIntegration implements Integration, Injectable, WorkItemStateCapable {
  readonly id = 'issues:fake';
  readonly capability: Capability = 'issues';

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

  /** Reflect an "in review" back-off into the fake world, so the state gate sees it next cycle. */
  async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === input.number);
      if (issue) issue.workItemState = input.state;
    });
    return { ok: true };
  }

  /** Reflect harness progress: an agent opened a PR that resolves this issue. */
  markIssueLinked(issueNumber: number, prNumber: number): void {
    this.world.mutate((world) => {
      const issue = world.issues.find((i) => i.number === issueNumber);
      if (issue) issue.linkedPrNumber = prNumber;
    });
  }
}
