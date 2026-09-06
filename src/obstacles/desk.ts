import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { ObstacleKind, ObstaclePurpose, ObstacleStanding } from '../types.js';
import { parseKeyCandidates } from './intake.js';
import { gateKeys, type KeyCandidate } from './keys.js';
import { buildObstacleWorld, reportedChecks } from './world.js';

/**
 * The model desk: the harness's secretary on the obstacle board, not its judge. Its
 * four permitted jobs — key extraction, merge suggestions, deciding a row's
 * purpose, and writing ticket prose — are the ones whose mistakes are visible.
 * Merging two reports is unreachable from here: a key it extracts that another row
 * already holds moves nothing and is recorded as a suggestion instead. Nothing it
 * writes moves a row's state, takes an owner, or resolves anything.
 * → `docs/spec/27-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not`
 */

/** What one row is handed to a reader. Prose and ids — no store, no world object. */
export interface ObstacleReadingRequest {
  obstacleId: string;
  /** The claim as the board holds it, the reporter's own frame already stripped. */
  what: string;
  /** What the intake made of it: something a fix ends, or something written down. */
  kind: ObstacleKind;
  /** Every voice behind the row, in its author's own words. */
  sightings: { words: string; whyNotMine: string | null; goalRef: string | null }[];
  /**
   * The other rows on the board, id and claim. Offered **only** so a merge can be
   * suggested by id: nothing the reader says about one of these merges anything.
   */
  others: { id: string; what: string }[];
  /** The check names the provider is reporting, so a key is spelled the provider's way. */
  checks: string[];
}

/**
 * How a deployment reads one row. Absent, extraction stays the mechanical reading
 * in `src/obstacles/keys.ts` and the ticket the mechanical composition in
 * `src/obstacles/ownership.ts`. Its answer is read defensively by
 * {@link parseObstacleReading}, since a validator that threw on it would be a pulse a model could fail.
 */
export type ObstacleReader = (request: ObstacleReadingRequest) => Promise<unknown>;

/** One reading, after everything unusable has been dropped out of it. */
interface ParsedReading {
  /** Key candidates in the same spelling an agent names them in, ungated. */
  keys: KeyCandidate[];
  /** Ids of rows it says are this one. A suggestion, and only ever confirmed by id. */
  near: string[];
  purpose: ObstaclePurpose | null;
  title: string | null;
  body: string | null;
}

/**
 * Read one answer, dropping what is not usable and keeping the rest. Nothing here
 * throws — this runs on the pulse. `near` is filtered to ids actually on the
 * board, the only validation a merge suggestion can have.
 */
export function parseObstacleReading(raw: unknown, onBoard: ReadonlySet<string>): ParsedReading {
  const fields = (raw ?? {}) as Record<string, unknown>;
  const purpose = fields.purpose;
  const ticket = (fields.ticket ?? {}) as Record<string, unknown>;
  return {
    // The same parser an agent's `keys` argument goes through: a model's output
    // passes every gate an agent's report passes.
    keys: parseKeyCandidates(fields.keys),
    near: Array.isArray(fields.near)
      ? [...new Set(fields.near.filter((id): id is string => typeof id === 'string' && onBoard.has(id)))]
      : [],
    purpose: purpose === 'ticket' || purpose === 'docs' ? purpose : null,
    title: text(ticket.title, TITLE_CHARS),
    body: text(ticket.body, BODY_CHARS),
  };
}

/** A tracker title stays a line, and a body stays a page somebody reads. */
const TITLE_CHARS = 80;
const BODY_CHARS = 8_000;

/** A non-empty string, trimmed and bounded — or null, which leaves what was there. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/** How many rows one pass reads. A reading is a round trip, and a pulse is seconds. */
const READS_PER_PASS = 1;

export class ObstacleModelDesk {
  /** One pass at a time: a second pass under the first reads the same inbox and pays twice. */
  private running = false;

  constructor(
    private readonly deps: {
      store: Store;
      /** Absent = no model is ever called, and the mechanical readings stand. */
      reader?: ObstacleReader;
      /** What a `path` key is validated against. Null where the harness has no checkout. */
      repoRoot?: string | null;
      errors?: ErrorRecorder;
    },
  ) {}

  /**
   * One pass over the inbox, and only where it is non-empty — a board that has not
   * moved costs no model call. The pulse does not await this, and it never rejects:
   * everything inside is caught and recorded.
   */
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
      // Never into the cycle: a pass that could fail a pulse is a pass an operator turns off.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Reading the obstacle board failed: ${(err as Error).message}`,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Read one row, and write down what a model is allowed to have decided. The
   * stamp is written last carrying the row's `lastSeenAt` as it stood when the
   * request was built, so words that arrived mid-call are back in the inbox next
   * pulse rather than silently skipped. Only the agents' words are read — the
   * harness's own voice is gated but never extracted. → `docs/spec/27-obstacles.md#the-harness-is-a-voice`
   */
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

  /**
   * Put the keys through the same three gates an agent's report goes through, and
   * attach what survives. Grounding is asked of what the harness knows about this
   * row — its own binding check keys and the files of the goals that reported it;
   * a key outside both is unplaced, so it suggests rather than binds. A key
   * another row already holds moves nothing — the store hands it back and it is
   * recorded as a merge suggestion.
   */
  private attachKeys(row: ObstacleStanding, candidates: readonly KeyCandidate[]): void {
    if (candidates.length === 0) return;
    const world = buildObstacleWorld({
      reported: reportedChecks(this.deps.store.getWorldBaseline()),
      dispatchChecks: row.keys.filter((key) => key.kind === 'check' && key.binds).map((key) => key.value),
      branchPaths: row.goalRefs.flatMap((goalRef) => this.deps.store.listGoalFiles(goalRef).map((file) => file.path)),
      repoRoot: this.deps.repoRoot ?? null,
    });
    // The row's own binding check keys ride in beside the candidates: grounding
    // reads the report in front of it, so leaving them out would ground a file the
    // row is entirely about on nothing. Already the row's, so the store skips them.
    const own = row.keys
      .filter((key) => key.kind === 'check' && key.binds)
      .map((key) => ({ kind: key.kind, value: key.value }));
    const { taken } = this.deps.store.addObstacleKeys(row.obstacle.id, gateKeys([...own, ...candidates], world));
    for (const other of taken) this.deps.store.suggestObstacleMerge(row.obstacle.id, other, 'key');
  }

  /**
   * Which of the two doors the row is at: a ticket somebody fixes, or a change to
   * the documentation. It reuses the `kind` column the intake writes rather than a
   * second field; the store guards the write on the row being one nothing has taken
   * yet, so a reading can never pull a ticket out from under a dispatched agent.
   */
  private setPurpose(row: ObstacleStanding, purpose: ObstaclePurpose | null): void {
    if (purpose === null) return;
    const kind: ObstacleKind = purpose === 'docs' ? 'note' : 'obstacle';
    if (kind !== row.obstacle.kind) this.deps.store.setObstacleKind(row.obstacle.id, kind);
  }
}
