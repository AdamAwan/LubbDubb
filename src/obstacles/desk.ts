import type { ErrorRecorder } from '../errorLog.js';
import { dispatchFactScopes } from '../knowledge/block.js';
import { corroborationGoal } from '../knowledge/knowledge.js';
import type { Store } from '../store/store.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { ObstacleKind, ObstaclePurpose, ObstacleStanding, WorldSnapshot } from '../types.js';
import { releasedBlocks } from './blocked.js';
import { type DeliverableObstacle } from './delivery.js';
import {
  clockExpired,
  conditionMet,
  conditionsSettled,
  conditionsToWatch,
  decayed,
  noteWriteUpFields,
  notesToWriteUp,
  ownerLanded,
  writeUpReading,
} from './endings.js';
import { parseKeyCandidates } from './intake.js';
import { gateKeys, type KeyCandidate } from './keys.js';
import { obstacleNotices, type NoticeAgent } from './notices.js';
import {
  obstacleRepairOrigin,
  obstacleTicketFields,
  obstacleTicketGoal,
  ownershipDoor,
  redBaseChecks,
} from './ownership.js';
import { harnessSightings } from './voice.js';
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

type TicketBody = (vars: Record<string, string>) => string;
type DocsPrompt = (vars: Record<string, string>) => string;

interface NoticeFleet {
  isLive(agentId: string): boolean;
  notify(agentId: string, text: string): boolean;
}

interface ObstacleDeskDeps {
  store: Store;
  fleet: NoticeFleet;
  dormantMs: number;
  watchLabel: string;
  reader?: ObstacleReader;
  repoRoot?: string | null;
  filing?: TicketFiler;
  ticketBody?: TicketBody;
  docsPrompt?: DocsPrompt;
  now?: () => number;
  errors?: ErrorRecorder;
}

/**
 * What one pulse hands the desk. `readWorld` is the cycle's own answer to whether it went out and
 * looked, and it gates the two stages that need a world read rather than the whole desk — see
 * docs/spec/27-obstacles.md#one-desk-on-the-pulse.
 */
interface ObstaclePass {
  previousWorld: WorldSnapshot | null;
  world: WorldSnapshot;
  readWorld: boolean;
}

export class ObstacleDesk {
  private reading = false;
  private owning = false;
  private ending = false;

  constructor(private readonly deps: ObstacleDeskDeps) {}

  async run(pass: ObstaclePass): Promise<void> {
    if (pass.readWorld) this.voice(pass.previousWorld, pass.world);
    // Started, never awaited: the reading is a model round trip, and the pulse does not wait on one.
    void this.model();
    this.notices();
    await this.ownership(pass.world);
    if (pass.readWorld) this.endings(pass.world);
  }

  voice(prev: WorldSnapshot | null, next: WorldSnapshot): void {
    try {
      const sightings = harnessSightings(prev, next);
      if (sightings.length === 0) return;
      const reported = reportedChecks(next);
      const held = this.checkKeysHeld();
      for (const seen of sightings) {
        if (held.has(seen.checkName)) continue;
        const world = buildObstacleWorld({
          reported,
          dispatchChecks: [seen.checkName],
          branchPaths: [],
          repoRoot: null,
        });
        const keys = gateKeys([{ kind: 'check', value: seen.checkName }], world);
        if (!keys.some((key) => key.kind === 'check' && key.binds)) continue;
        this.deps.store.obstacles.recordObstacleSighting(
          { what: seen.what, kind: 'obstacle', keys, untilHours: null },
          {
            agentId: null,
            taskId: null,
            goalRef: null,
            sessionId: null,
            transition: seen.transition,
            words: seen.words,
            whyNotMine: null,
          },
        );
        held.add(seen.checkName);
      }
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Recording the harness's own obstacle sightings failed: ${(err as Error).message}`,
      });
    }
  }

  async model(): Promise<void> {
    if (this.reading) return;
    const reader = this.deps.reader;
    if (!reader) return;
    this.reading = true;
    try {
      const inbox = this.deps.store.obstacles.obstacleInbox();
      if (inbox.length === 0) return;
      const board = this.deps.store.obstacles.obstacleBoard();
      for (const row of inbox.slice(0, READS_PER_PASS)) await this.read(row, board, reader);
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Reading the obstacle board failed: ${(err as Error).message}`,
      });
    } finally {
      this.reading = false;
    }
  }

  notices(): void {
    try {
      const rows = this.noticeBoard();
      if (rows.length === 0) return;
      for (const notice of obstacleNotices(rows, this.liveAgents(rows))) {
        if (!this.deps.store.obstacles.claimObstacleNotice(notice.obstacleId, notice.agentId, notice.reason)) continue;
        this.deps.fleet.notify(notice.agentId, notice.text);
      }
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Sending obstacle notices failed: ${(err as Error).message}`,
      });
    }
  }

  async ownership(world: WorldSnapshot): Promise<void> {
    if (this.owning) return;
    this.owning = true;
    try {
      this.releaseGoals();
      const board = this.deps.store.obstacles.obstacleBoard();
      this.recoverStaleClaims(board);
      this.recordRepairs(board);
      await this.fileTickets(board, redBaseChecks(world.pullRequests));
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Taking ownership of obstacles failed: ${(err as Error).message}`,
      });
    } finally {
      this.owning = false;
    }
  }

  endings(world: WorldSnapshot): void {
    if (this.ending) return;
    this.ending = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const board = this.deps.store.obstacles.obstacleBoard();
      for (const condition of conditionsToWatch(board, world.pullRequests))
        this.deps.store.obstacles.watchObstacleCondition(condition);
      this.settleConditions(board, world);
      this.settleLandings(board);
      this.expire(board, now);
      this.decay(board, now);
      this.sweepWriteUps();
      this.writeUpNotes();
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Ending obstacles failed: ${(err as Error).message}`,
      });
    } finally {
      this.ending = false;
    }
  }

  private checkKeysHeld(): Set<string> {
    const out = new Set<string>();
    for (const obstacle of this.deps.store.obstacles.listObstacles())
      for (const key of this.deps.store.obstacles.listObstacleKeys(obstacle.id))
        if (key.kind === 'check') out.add(key.value);
    return out;
  }

  private async read(row: ObstacleStanding, board: readonly ObstacleStanding[], reader: ObstacleReader): Promise<void> {
    const id = row.obstacle.id;
    const sightings = this.deps.store.obstacles.listObstacleSightings(id).filter((s) => s.transition === null);
    const reading = parseObstacleReading(
      await reader({
        obstacleId: id,
        what: row.obstacle.what,
        kind: row.obstacle.kind,
        sightings: sightings.map((s) => ({ words: s.words, whyNotMine: s.whyNotMine, goalRef: s.goalRef })),
        others: board
          .filter((other) => other.obstacle.id !== id)
          .map((o) => ({ id: o.obstacle.id, what: o.obstacle.what })),
        checks: reportedChecks(this.deps.store.world.getWorldBaseline()),
      }),
      new Set(board.map((other) => other.obstacle.id)),
    );
    this.attachKeys(row, reading.keys);
    for (const near of reading.near) this.deps.store.obstacles.suggestObstacleMerge(id, near, 'model');
    this.setPurpose(row, reading.purpose);
    this.deps.store.obstacles.recordObstacleReading({
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
      reported: reportedChecks(this.deps.store.world.getWorldBaseline()),
      dispatchChecks: row.keys.filter((key) => key.kind === 'check' && key.binds).map((key) => key.value),
      branchPaths: row.goalRefs.flatMap((goalRef) =>
        this.deps.store.agents.listGoalFiles(goalRef).map((file) => file.path),
      ),
      repoRoot: this.deps.repoRoot ?? null,
    });
    const own = row.keys
      .filter((key) => key.kind === 'check' && key.binds)
      .map((key) => ({ kind: key.kind, value: key.value }));
    const { taken } = this.deps.store.obstacles.addObstacleKeys(
      row.obstacle.id,
      gateKeys([...own, ...candidates], world),
    );
    for (const other of taken) this.deps.store.obstacles.suggestObstacleMerge(row.obstacle.id, other, 'key');
  }

  private setPurpose(row: ObstacleStanding, purpose: ObstaclePurpose | null): void {
    if (purpose === null) return;
    const kind: ObstacleKind = purpose === 'docs' ? 'note' : 'obstacle';
    if (kind !== row.obstacle.kind) this.deps.store.obstacles.setObstacleKind(row.obstacle.id, kind);
  }

  private noticeBoard(): DeliverableObstacle[] {
    return this.deps.store.obstacles
      .listObstacles()
      .map((obstacle) => ({ obstacle, keys: this.deps.store.obstacles.listObstacleKeys(obstacle.id) }));
  }

  private liveAgents(rows: readonly DeliverableObstacle[]): NoticeAgent[] {
    const out: NoticeAgent[] = [];
    for (const agent of this.deps.store.agents.listAgents()) {
      if (!this.deps.fleet.isLive(agent.id)) continue;
      const task = this.deps.store.tasks.getTask(agent.taskId);
      if (!task) continue;
      const goalRef = corroborationGoal(task.originRef);
      const reported = new Set(
        rows
          .filter((row) =>
            this.deps.store.obstacles
              .listObstacleSightings(row.obstacle.id)
              .some((s) => s.agentId === agent.id || (goalRef !== null && s.goalRef === goalRef)),
          )
          .map((row) => row.obstacle.id),
      );
      out.push({
        agentId: agent.id,
        goalRef,
        scopes: dispatchFactScopes(task.originRef, task.ciChecks ?? null),
        reported,
        notified: this.deps.store.obstacles.obstaclesNoticedBy(agent.id),
      });
    }
    return out;
  }

  private releaseGoals(): void {
    const blocks = this.deps.store.obstacles.listObstacleBlocks();
    if (blocks.length === 0) return;
    for (const block of releasedBlocks(blocks, this.deps.store.obstacles.obstacleBoard()))
      this.deps.store.obstacles.clearObstacleBlock(block.originRef);
  }

  private recoverStaleClaims(board: readonly ObstacleStanding[]): void {
    for (const row of board)
      if (row.obstacle.state === 'owned' && row.obstacle.ownerRef === null)
        this.deps.store.obstacles.releaseObstacle(row.obstacle.id);
  }

  private recordRepairs(board: readonly ObstacleStanding[]): void {
    const live = new Set(
      this.deps.store.tasks
        .listTasks()
        .filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'waiting')
        .map((task) => task.originRef ?? ''),
    );
    for (const row of board) {
      if (row.obstacle.state !== 'standing' || row.obstacle.ownerRef !== null) continue;
      const origin = obstacleRepairOrigin(row.obstacle.id);
      if (!live.has(origin)) continue;
      if (this.deps.store.obstacles.claimObstacle(row.obstacle.id))
        this.deps.store.obstacles.setObstacleOwner(row.obstacle.id, origin);
    }
  }

  private async fileTickets(board: readonly ObstacleStanding[], red: ReadonlySet<string>): Promise<void> {
    const filing = this.deps.filing;
    if (!filing) return;
    const row = board.find((candidate) => ownershipDoor(candidate, red) === 'ticket');
    if (!row) return;
    if (!this.deps.store.obstacles.claimObstacle(row.obstacle.id)) return;
    const sightings = this.deps.store.obstacles.listObstacleSightings(row.obstacle.id);
    const fields = obstacleTicketFields(row, sightings);
    const written = this.deps.store.obstacles.obstacleReading(row.obstacle.id);
    try {
      const ref = await filing({
        title: written?.title ?? fields.title,
        body: written?.body ?? (this.deps.ticketBody ? this.deps.ticketBody(fields.vars) : plainBody(fields.vars)),
        labels: this.deps.watchLabel ? [this.deps.watchLabel] : [],
        bug: true,
        relatedTo: obstacleTicketGoal(row) ?? undefined,
      });
      this.deps.store.obstacles.setObstacleOwner(row.obstacle.id, ref);
    } catch (err) {
      this.deps.store.obstacles.releaseObstacle(row.obstacle.id);
      this.deps.errors?.record({
        source: 'provider',
        message: `Filing a ticket for obstacle ${row.obstacle.id} failed: ${(err as Error).message}`,
      });
    }
  }

  private settleConditions(board: readonly ObstacleStanding[], world: WorldSnapshot): void {
    for (const row of board) {
      const conditions = this.deps.store.obstacles.listObstacleConditions(row.obstacle.id);
      if (conditions.length === 0) continue;
      const settledBefore = conditions.every((condition) => condition.metAt !== null);
      for (const condition of conditions)
        this.deps.store.obstacles.setObstacleConditionMet(condition.id, conditionMet(condition, world.pullRequests));
      if (settledBefore && conditionsSettled(conditions, world.pullRequests))
        this.deps.store.obstacles.endObstacle(row.obstacle.id, 'resolved', 'condition');
    }
  }

  private settleLandings(board: readonly ObstacleStanding[]): void {
    const owned = board.filter((row) => row.obstacle.state === 'owned' && row.obstacle.ownerRef !== null);
    if (owned.length === 0) return;
    const landings = this.deps.store.environments.listGoalLandings();
    for (const row of owned)
      if (ownerLanded(row.obstacle, landings))
        this.deps.store.obstacles.endObstacle(row.obstacle.id, 'resolved', 'landing');
  }

  private expire(board: readonly ObstacleStanding[], now: number): void {
    for (const row of board)
      if (clockExpired(row.obstacle, now)) this.deps.store.obstacles.endObstacle(row.obstacle.id, 'resolved', 'expiry');
  }

  private decay(board: readonly ObstacleStanding[], now: number): void {
    for (const row of board)
      if (decayed(row.obstacle, now, this.deps.dormantMs))
        this.deps.store.obstacles.endObstacle(row.obstacle.id, 'dormant', 'decay');
  }

  private sweepWriteUps(): void {
    const open = this.deps.store.obstacles.openObstacleWriteUps();
    if (open.length === 0) return;
    for (const writeUp of open) {
      const nodes = this.deps.store.graph.listWorkSubtree(`job:${writeUp.jobId}`);
      const pr = nodes.find((node) => node.kind === 'pr');
      if (pr && writeUp.prRef === null) this.deps.store.obstacles.noteObstacleWriteUpPr(writeUp.obstacleId, pr.ref);
      const reading = writeUpReading(writeUp.jobId, nodes);
      if (reading !== 'landed' && reading !== 'abandoned') continue;
      if (!this.deps.store.obstacles.settleObstacleWriteUp(writeUp.obstacleId, reading)) continue;
      if (reading === 'landed') this.deps.store.obstacles.endObstacle(writeUp.obstacleId, 'resolved', 'written-down');
    }
  }

  private writeUpNotes(): void {
    const docs = this.deps.docsPrompt;
    if (!docs) return;
    if (this.deps.store.obstacles.openObstacleWriteUps().length > 0) return;
    const row = notesToWriteUp(
      this.deps.store.obstacles.obstacleBoard(),
      this.deps.store.obstacles.obstaclesWrittenUp(),
    )[0];
    if (!row) return;
    const fields = noteWriteUpFields(row);
    const prompt = [docs(fields.vars), fields.note].join('\n\n');
    this.deps.store.writeUpObstacle(row.obstacle.id, { title: fields.title, prompt });
  }
}

function plainBody(vars: Record<string, string>): string {
  return (
    `${vars.claim}\n\n` +
    `The fleet has hit this ${vars.voices} times. It identifies as: ${vars.keys}.\n\n` +
    `Goals that hit it: ${vars.goals}\n\n` +
    `## What the agents said\n\n${vars.sightings}\n`
  );
}
