import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../../connector/connector.js';
import type { Capability, Injectable, Integration, WorldSlice } from '../integration.js';
import type { FakeWorldStore } from './fakeWorld.js';

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set(['meeting']);

/**
 * The fake `calendar` provider: it owns the calendar slice of the world. A real
 * Google Calendar / Outlook adapter drops in under `calendar` in its place.
 */
export class FakeCalendarIntegration implements Integration, Injectable {
  readonly id = 'calendar:fake';
  readonly capability: Capability = 'calendar';

  constructor(private readonly world: FakeWorldStore) {}

  async snapshot(): Promise<WorldSlice> {
    return { calendar: this.world.read().calendar };
  }

  handles(kind: InjectableEvent['kind']): boolean {
    return KINDS.has(kind);
  }

  inject(event: InjectableEvent): void {
    if (event.kind !== 'meeting') return;
    this.world.mutate((world) => {
      world.calendar.push({
        id: `cal_${nanoid(6)}`,
        title: event.title,
        startsAt: event.startsAt,
        prepDocs: event.prepDocs ?? [],
        prepDone: false,
      });
    });
  }

  /** Reflect harness progress back (meeting prep completed). */
  markPrepDone(eventId: string): void {
    this.world.mutate((world) => {
      const ev = world.calendar.find((e) => e.id === eventId);
      if (ev) ev.prepDone = true;
    });
  }
}
