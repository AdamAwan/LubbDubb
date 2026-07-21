import type { Connector, InjectableEvent } from './connector.js';
import type { ActionSink, PrReplyInput, SendResult } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { Story, WorldSnapshot } from '../types.js';
import { CompositeConnector } from '../integrations/compositeConnector.js';
import { FakeWorldStore } from '../integrations/fake/fakeWorld.js';
import { FakeGitHubIntegration } from '../integrations/fake/fakeGitHub.js';
import { FakeBacklogIntegration } from '../integrations/fake/fakeBacklog.js';
import { FakeCalendarIntegration } from '../integrations/fake/fakeCalendar.js';

/**
 * A convenience bundle: the three fake integrations (source control, backlog,
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
  private readonly backlog: FakeBacklogIntegration;
  private readonly calendar: FakeCalendarIntegration;

  constructor(store: Store, now: () => string = () => new Date().toISOString()) {
    const world = new FakeWorldStore(store);
    this.github = new FakeGitHubIntegration(world, store);
    this.backlog = new FakeBacklogIntegration(world);
    this.calendar = new FakeCalendarIntegration(world);
    this.composite = new CompositeConnector([this.github, this.backlog, this.calendar], store, now);
  }

  getState(): Promise<WorldSnapshot> {
    return this.composite.getState();
  }

  postPrReply(input: PrReplyInput): Promise<SendResult> {
    return this.composite.postPrReply(input);
  }

  /** Apply an event to the fake world (routes to the owning module) and log it. */
  inject(event: InjectableEvent): void {
    this.composite.inject(event);
  }

  markCommentHandled(prNumber: number, commentId: string): void {
    this.github.markCommentHandled(prNumber, commentId);
  }

  markStoryState(storyId: string, state: Story['state']): void {
    this.backlog.markStoryState(storyId, state);
  }

  markPrepDone(eventId: string): void {
    this.calendar.markPrepDone(eventId);
  }
}
