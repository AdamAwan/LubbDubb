import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { ObstacleKind, ObstaclePurpose, ObstacleStanding } from '../types.js';
import { parseKeyCandidates } from './intake.js';
import { gateKeys, type KeyCandidate } from './keys.js';
import { buildObstacleWorld, reportedChecks } from './world.js';

// → docs/spec/27-obstacles.md

export interface ObstacleReadingRequest {
  obstacleId: string;
  what: string;
  kind: ObstacleKind;
  sightings: { words: string; whyNotMine: string | null; goalRef: string | null }[];
  others: { id: string; what: string }[];
  checks: string[];
}

export type ObstacleReader = (request: ObstacleReadingRequest) => Promise<unknown>;

interface ParsedReading {
  keys: KeyCandidate[];
  near: string[];
  purpose: ObstaclePurpose | null;
  title: string | null;
  body: string | null;
}

export function parseObstacleReading(raw: unknown, onBoard: ReadonlySet<string>): ParsedReading {
  const fields = (raw ?? {}) as Record<string, unknown>;
  const purpose = fields.purpose;
  const ticket = (fields.ticket ?? {}) as Record<string, unknown>;
  return {
    keys: parseKeyCandidates(fields.keys),
    near: Array.isArray(fields.near)
      ? [...new Set(fields.near.filter((id): id is string => typeof id === 'string' && onBoard.has(id)))]
      : [],
    purpose: purpose === 'ticket' || purpose === 'docs' ? purpose : null,
    title: text(ticket.title, TITLE_CHARS),
    body: text(ticket.body, BODY_CHARS),
  };
}

const TITLE_CHARS = 80;
const BODY_CHARS = 8_000;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

const READS_PER_PASS = 1;

export class ObstacleModelDesk {
  private running = false;

  constructor(
    private readonly deps: {
      store: Store;
      reader?: ObstacleReader;
      repoRoot?: string | null;
      errors?: ErrorRecorder;
    },
  ) {}

  async run(): Promise<void> {
    if (this.running) return;
    const reader = this.deps.reader;
    if (!reader) return;
    this.running = true;
    try {
      const inbox = this.deps.store.obstacleInbox();
      if (inbox.length === 0) return;
      const board = this.deps.store.obstacleBoard();
      for (const row of inbox.slice(0, READS_PER_PASS)) await this.read(row, board, reader);
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Reading the obstacle board failed: ${(err as Error).message}`,
      });
    } finally {
      this.running = false;
    }
  }

  private async read(row: ObstacleStanding, board: readonly ObstacleStanding[], reader: ObstacleReader): Promise<void> {
    const id = row.obstacle.id;
    const sightings = this.deps.store.listObstacleSightings(id).filter((s) => s.transition === null);
    const reading = parseObstacleReading(
      await reader({
        obstacleId: id,
        what: row.obstacle.what,
        kind: row.obstacle.kind,
        sightings: sightings.map((s) => ({ words: s.words, whyNotMine: s.whyNotMine, goalRef: s.goalRef })),
        others: board
          .filter((other) => other.obstacle.id !== id)
          .map((o) => ({ id: o.obstacle.id, what: o.obstacle.what })),
        checks: reportedChecks(this.deps.store.getWorldBaseline()),
      }),
      new Set(board.map((other) => other.obstacle.id)),
    );
    this.attachKeys(row, reading.keys);
    for (const near of reading.near) this.deps.store.suggestObstacleMerge(id, near, 'model');
    this.setPurpose(row, reading.purpose);
    this.deps.store.recordObstacleReading({
      obstacleId: id,
      readAt: row.obstacle.lastSeenAt,
      purpose: reading.purpose,
      title: reading.title,
      body: reading.body,
    });
  }

  private attachKeys(row: ObstacleStanding, candidates: readonly KeyCandidate[]): void {
    if (candidates.length === 0) return;
    const world = buildObstacleWorld({
      reported: reportedChecks(this.deps.store.getWorldBaseline()),
      dispatchChecks: row.keys.filter((key) => key.kind === 'check' && key.binds).map((key) => key.value),
      branchPaths: row.goalRefs.flatMap((goalRef) => this.deps.store.listGoalFiles(goalRef).map((file) => file.path)),
      repoRoot: this.deps.repoRoot ?? null,
    });
    const own = row.keys
      .filter((key) => key.kind === 'check' && key.binds)
      .map((key) => ({ kind: key.kind, value: key.value }));
    const { taken } = this.deps.store.addObstacleKeys(row.obstacle.id, gateKeys([...own, ...candidates], world));
    for (const other of taken) this.deps.store.suggestObstacleMerge(row.obstacle.id, other, 'key');
  }

  private setPurpose(row: ObstacleStanding, purpose: ObstaclePurpose | null): void {
    if (purpose === null) return;
    const kind: ObstacleKind = purpose === 'docs' ? 'note' : 'obstacle';
    if (kind !== row.obstacle.kind) this.deps.store.setObstacleKind(row.obstacle.id, kind);
  }
}
