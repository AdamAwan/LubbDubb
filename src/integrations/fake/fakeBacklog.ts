import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../../connector/connector.js';
import type { SendResult, StoryLabelInput } from '../../sink/actionSink.js';
import type { Story } from '../../types.js';
import type { Capability, Injectable, Integration, StoryLabelCapable, WorldSlice } from '../integration.js';
import type { FakeWorldStore } from './fakeWorld.js';

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set(['new_story', 'story_state']);

/**
 * The fake `backlog` provider: it owns the stories slice of the world. A real
 * Azure Boards / Jira adapter drops in under `backlog` in its place.
 */
export class FakeBacklogIntegration implements Integration, Injectable, StoryLabelCapable {
  readonly id = 'backlog:fake';
  readonly capability: Capability = 'backlog';

  constructor(private readonly world: FakeWorldStore) {}

  async snapshot(): Promise<WorldSlice> {
    return { stories: this.world.read().stories };
  }

  handles(kind: InjectableEvent['kind']): boolean {
    return KINDS.has(kind);
  }

  inject(event: InjectableEvent): void {
    this.world.mutate((world) => {
      switch (event.kind) {
        case 'new_story':
          world.stories.push({
            id: `story_${nanoid(6)}`,
            title: event.title,
            description: event.description ?? null,
            acceptanceCriteria: event.acceptanceCriteria ?? null,
            wafPillars: event.wafPillars ?? [],
            state: 'ready',
            priority: event.priority ?? 1,
            labels: event.labels ?? [],
          });
          break;
        case 'story_state': {
          const story = world.stories.find((s) => s.id === event.storyId);
          if (story) story.state = event.state;
          break;
        }
      }
    });
  }

  /** The outbound side of the watch/ignore toggle: add/remove a label on the fake story. Idempotent. */
  async setStoryLabel(input: StoryLabelInput): Promise<SendResult> {
    this.world.mutate((world) => {
      const story = world.stories.find((s) => s.id === input.id);
      if (!story) return;
      const labels = new Set(story.labels ?? []);
      if (input.present) labels.add(input.label);
      else labels.delete(input.label);
      story.labels = [...labels];
    });
    return { ok: true };
  }

  /** Reflect harness progress back (e.g. a picked-up story moves to in_progress). */
  markStoryState(storyId: string, state: Story['state']): void {
    this.world.mutate((world) => {
      const story = world.stories.find((s) => s.id === storyId);
      if (story) story.state = state;
    });
  }
}
