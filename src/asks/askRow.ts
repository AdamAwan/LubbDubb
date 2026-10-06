import type { SetupCheck } from '../setup/reading.js';

// → docs/spec/17-cockpit.md#the-queue-rail--needs-you

export type AskKind =
  | 'config'
  | 'config_gap'
  | 'recovery'
  | 'escalation'
  | 'permission'
  | 'plan'
  | 'reply'
  | 'merge'
  | 'describe'
  | 'description_wrong'
  | 'description_note'
  | 'shortfall'
  | 'intake'
  | 'sitting'
  | 'profile'
  | 'placement'
  | 'bench'
  | 'close_out'
  | 'validate'
  | 'validation_plan'
  | 'watch'
  | 'unwatched'
  | 'burn'
  | 'limit'
  | 'supply'
  | 'dispatch'
  | 'assigned'
  | 'assign'
  | 'bot_pr'
  | 'upgrade'
  | 'project_pull';

export type AskGroup = 'blocking' | 'yours';

/** `now` is work the fleet cannot get past; `next` the operator's own obligation; `later` holds nothing. */
export type AskUrgency = 'now' | 'next' | 'later';

/* `prediction` is `goal` with a pane named. → docs/spec/17-cockpit.md#the-panes */
export type AskDestination = 'goal' | 'prediction' | 'ask' | 'config' | 'build' | 'provider' | 'pr' | null;

/**
 * The record an ask is about, which is what answers it and what says it has been answered.
 * → docs/spec/17-cockpit.md#one-list-for-the-cockpit-and-for-claude-code
 */
export type AskSubject =
  | {
      type: 'escalation';
      escalationId: string;
      proposalId: string | null;
      /** Present, and true, only while the plan behind it waits on the operator's reveal. */
      planWithheld?: true;
    }
  | { type: 'human_task'; taskId: string }
  | { type: 'recovery'; taskIds: string[] }
  | { type: 'parked_agent'; agentId: string }
  | { type: 'setup_check'; checkId: string }
  | { type: 'refused_dispatch'; key: string }
  | { type: 'pull_request'; prNumber: number }
  | { type: 'part'; originRef: string; prNumber: number }
  | { type: 'description_check'; versionId: string; prNumber: number }
  | { type: 'issue'; issueNumber: number }
  | { type: 'build'; target: 'upgrade' | 'project_pull' };

/** What a refused dispatch's row carries, so the band can say what the refusal said. */
interface AskRefusal {
  originRef: string | null;
  pulses: number;
  detail: string;
  rule: string | null;
  since: string;
}

export interface AskRow {
  id: string;
  kind: AskKind;
  subject: AskSubject;
  group: AskGroup;
  urgency: AskUrgency;
  /**
   * Its place in the order Focus mode — and a one-at-a-time reader — walks the queue, `0` first.
   * The array itself is in the rail's order. → docs/spec/17-cockpit.md#one-ask-at-a-time
   */
  focusRank: number;
  /**
   * False only for a setup check reading `ok` or `unknown`, which is shipped so a fix the operator
   * just applied keeps its place while it shows its undo. Every reader but that one drops it.
   */
  standing: boolean;
  title: string;
  goalRef: string | null;
  originRef: string | null;
  opens: AskDestination;
  /** The pull request a `pr` destination opens. */
  prNumber?: number;
  details?: AskDestination;
  agentId: string | null;
  agentLabel: string | null;
  note?: string;
  holding: number;
  raisedAt: string;
  check?: SetupCheck;
  /** Which backlog field a `placement` ask is about. */
  placementField?: 'parent' | 'areaPath';
  /** The press that answers this row, where the kind's verb would name the wrong one. */
  verb?: string;
  refusal?: AskRefusal;
}
