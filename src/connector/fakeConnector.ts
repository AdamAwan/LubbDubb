import type { Connector, InjectableEvent } from './connector.js';
import type {
  ActionSink,
  IssueLabelInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  SendResult,
  WorkItemStateInput,
} from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { CompositeConnector } from '../integrations/compositeConnector.js';
import { FakeWorldStore } from '../integrations/fake/fakeWorld.js';
import { FakeGitHubIntegration } from '../integrations/fake/fakeGitHub.js';
import { FakeIssuesIntegration } from '../integrations/fake/fakeIssues.js';
import { FakeCalendarIntegration } from '../integrations/fake/fakeCalendar.js';

/**
 * A convenience bundle: the fake integrations (source control, issues, backlog,
 * calendar) sharing one persisted world, composed behind {@link Connector} +
 * {@link ActionSink}. Equivalent to selecting the `fake` provider for every
 * capability — this is what makes the harness behave identically to before the
 * integrations were modularised, and gives tests a one-call fake with the
 * inject/reflect helpers.
 *
 * Production wiring builds the composite from config via `buildIntegrations`
 * (see `system.ts`); this facade is the same modules assembled directly.
 */
export class FakeConnector implements Connector, ActionSink {
  private readonly composite: CompositeConnector;
  private readonly github: FakeGitHubIntegration;
  private readonly issues: FakeIssuesIntegration;
  private readonly calendar: FakeCalendarIntegration;

  constructor(store: Store, now: () => string = () => new Date().toISOString()) {
    const world = new FakeWorldStore(store);
    this.github = new FakeGitHubIntegration(world, store);
    this.issues = new FakeIssuesIntegration(world);
    this.calendar = new FakeCalendarIntegration(world);
    this.composite = new CompositeConnector([this.github, this.issues, this.calendar], store, now);
  }

  getState(): Promise<WorldSnapshot> {
    return this.composite.getState();
  }

  postPrReply(input: PrReplyInput): Promise<SendResult> {
    return this.composite.postPrReply(input);
  }

  mergePr(input: PrMergeInput): Promise<SendResult> {
    return this.composite.mergePr(input);
  }

  setPrLabel(input: PrLabelInput): Promise<SendResult> {
    return this.composite.setPrLabel(input);
  }

  setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    return this.composite.setIssueLabel(input);
  }

  setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    return this.composite.setWorkItemState(input);
  }

  /** Apply an event to the fake world (routes to the owning module) and log it. */
  inject(event: InjectableEvent): void {
    this.composite.inject(event);
  }

  markCommentHandled(prNumber: number, commentId: string): void {
    this.github.markCommentHandled(prNumber, commentId);
  }

  markIssueLinked(issueNumber: number, prNumber: number): void {
    this.issues.markIssueLinked(issueNumber, prNumber);
  }

  markPrepDone(eventId: string): void {
    this.calendar.markPrepDone(eventId);
  }
}
