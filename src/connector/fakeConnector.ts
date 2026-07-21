import { nanoid } from 'nanoid';
import type { Connector, InjectableEvent } from './connector.js';
import type { Store } from '../store/store.js';
import type { CalendarEvent, PullRequest, Story, WorldSnapshot } from '../types.js';

const STATE_KEY = 'fake_world';

interface FakeWorld {
  pullRequests: PullRequest[];
  stories: Story[];
  calendar: CalendarEvent[];
}

const EMPTY_WORLD: FakeWorld = { pullRequests: [], stories: [], calendar: [] };

/**
 * A connector whose world is an editable, persisted document. Tests and the
 * cockpit "inject event" button push {@link InjectableEvent}s at it to make the
 * world move; everything survives a restart because it lives in the store.
 *
 * `now` is injectable so tests are deterministic.
 */
export class FakeConnector implements Connector {
  constructor(
    private readonly store: Store,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async getState(): Promise<WorldSnapshot> {
    const world = this.read();
    return { takenAt: this.now(), ...world };
  }

  /** Apply an event to the world, persist it, and log it. Returns the new world. */
  inject(event: InjectableEvent): FakeWorld {
    const world = structuredCloneWorld(this.read());
    switch (event.kind) {
      case 'ci_failed':
        this.mutatePr(world, event.prNumber, (pr) => (pr.ciStatus = 'failing'));
        break;
      case 'ci_passed':
        this.mutatePr(world, event.prNumber, (pr) => (pr.ciStatus = 'passing'));
        break;
      case 'pr_comment':
        this.mutatePr(world, event.prNumber, (pr) =>
          pr.unresolvedComments.push({ id: `c_${nanoid(6)}`, author: event.author, body: event.body, handled: false }),
        );
        break;
      case 'new_pr':
        if (!world.pullRequests.some((p) => p.number === event.number)) {
          world.pullRequests.push({
            id: `pr_${nanoid(6)}`,
            number: event.number,
            title: event.title,
            branch: event.branch,
            ciStatus: 'pending',
            unresolvedComments: [],
          });
        }
        break;
      case 'new_story':
        world.stories.push({
          id: `story_${nanoid(6)}`,
          title: event.title,
          description: event.description ?? null,
          acceptanceCriteria: event.acceptanceCriteria ?? null,
          wafPillars: event.wafPillars ?? [],
          state: 'ready',
          priority: event.priority ?? 1,
        });
        break;
      case 'story_state': {
        const story = world.stories.find((s) => s.id === event.storyId);
        if (story) story.state = event.state;
        break;
      }
      case 'meeting':
        world.calendar.push({
          id: `cal_${nanoid(6)}`,
          title: event.title,
          startsAt: event.startsAt,
          prepDocs: event.prepDocs ?? [],
          prepDone: false,
        });
        break;
    }
    this.write(world);
    this.store.recordConnectorEvent(event.kind, event);
    return world;
  }

  /**
   * Reflect harness progress back into the fake world so the loop can settle
   * (e.g. once an agent handled a comment, mark it handled; when a story is
   * picked up, move it to in_progress). Keeps the deterministic dispatcher from
   * re-triggering on the same signal forever.
   */
  markCommentHandled(prNumber: number, commentId: string): void {
    const world = this.read();
    this.mutatePr(world, prNumber, (pr) => {
      const c = pr.unresolvedComments.find((x) => x.id === commentId);
      if (c) c.handled = true;
    });
    this.write(world);
  }

  markStoryState(storyId: string, state: Story['state']): void {
    const world = this.read();
    const story = world.stories.find((s) => s.id === storyId);
    if (story) story.state = state;
    this.write(world);
  }

  markPrepDone(eventId: string): void {
    const world = this.read();
    const ev = world.calendar.find((e) => e.id === eventId);
    if (ev) ev.prepDone = true;
    this.write(world);
  }

  private mutatePr(world: FakeWorld, prNumber: number, fn: (pr: PullRequest) => void): void {
    const pr = world.pullRequests.find((p) => p.number === prNumber);
    if (pr) fn(pr);
  }

  private read(): FakeWorld {
    const raw = this.store.getConnectorState(STATE_KEY);
    if (!raw) return structuredCloneWorld(EMPTY_WORLD);
    return JSON.parse(raw) as FakeWorld;
  }

  private write(world: FakeWorld): void {
    this.store.setConnectorState(STATE_KEY, JSON.stringify(world));
  }
}

function structuredCloneWorld(w: FakeWorld): FakeWorld {
  return JSON.parse(JSON.stringify(w)) as FakeWorld;
}
