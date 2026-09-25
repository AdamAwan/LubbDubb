import type {
  Obstacle,
  ObstacleDeskReading,
  ObstacleCondition,
  ObstacleEnding,
  ObstacleKey,
  ObstacleKind,
  ObstaclePurpose,
  ObstacleSighting,
  ObstacleState,
  ObstacleTicketDecision,
  ObstacleWriteUp,
  ObstacleWriteUpOutcome,
} from '../types.js';

export interface ObstacleRow {
  id: string;
  what: string;
  kind: string;
  state: string;
  owner_ref: string | null;
  until: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_by: string | null;
  ticket_decision: string | null;
}

export interface ConditionRow {
  id: string;
  obstacle_id: string;
  kind: string;
  check_name: string;
  branch: string;
  met_at: string | null;
  created_at: string;
}

export interface WriteUpRow {
  obstacle_id: string;
  job_id: string;
  pr_ref: string | null;
  outcome: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface KeyRow {
  id: string;
  obstacle_id: string;
  kind: string;
  value: string;
  binds: number;
  confirmations: number;
  created_at: string;
}

export interface SightingRow {
  id: string;
  obstacle_id: string;
  agent_id: string | null;
  task_id: string | null;
  goal_ref: string | null;
  session_id: string | null;
  transition: string | null;
  words: string;
  why_not_mine: string | null;
  matched_by: string;
  created_at: string;
}

export interface ReadingRow {
  obstacle_id: string;
  read_at: string;
  taken_at: string;
  purpose: string | null;
  title: string | null;
  body: string | null;
}

export interface BlockRow {
  origin_ref: string;
  obstacle_id: string;
  agent_id: string | null;
  task_id: string | null;
  note: string;
  created_at: string;
}
export function toObstacle(row: ObstacleRow): Obstacle {
  return {
    id: row.id,
    what: row.what,
    kind: row.kind as ObstacleKind,
    state: row.state as ObstacleState,
    ownerRef: row.owner_ref,
    until: row.until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    endedBy: (row.ended_by as ObstacleEnding | null) ?? null,
    ticketDecision: (row.ticket_decision as ObstacleTicketDecision | null) ?? null,
  };
}

export function toReading(row: ReadingRow): ObstacleDeskReading {
  return {
    obstacleId: row.obstacle_id,
    readAt: row.read_at,
    takenAt: row.taken_at,
    purpose: (row.purpose as ObstaclePurpose | null) ?? null,
    title: row.title,
    body: row.body,
  };
}

export function toCondition(row: ConditionRow): ObstacleCondition {
  return {
    id: row.id,
    obstacleId: row.obstacle_id,
    kind: row.kind as ObstacleCondition['kind'],
    checkName: row.check_name,
    branch: row.branch,
    metAt: row.met_at,
    createdAt: row.created_at,
  };
}

export function toWriteUp(row: WriteUpRow): ObstacleWriteUp {
  return {
    obstacleId: row.obstacle_id,
    jobId: row.job_id,
    prRef: row.pr_ref,
    outcome: (row.outcome as ObstacleWriteUpOutcome | null) ?? null,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export function toKey(row: KeyRow): ObstacleKey {
  return {
    id: row.id,
    obstacleId: row.obstacle_id,
    kind: row.kind as ObstacleKey['kind'],
    value: row.value,
    binds: row.binds === 1,
    confirmations: row.confirmations,
    createdAt: row.created_at,
  };
}

export function toSighting(row: SightingRow): ObstacleSighting {
  return {
    id: row.id,
    obstacleId: row.obstacle_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    goalRef: row.goal_ref,
    sessionId: row.session_id,
    transition: row.transition,
    words: row.words,
    whyNotMine: row.why_not_mine,
    matchedBy: row.matched_by,
    createdAt: row.created_at,
  };
}
