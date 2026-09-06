import type { AppState, EnvironmentHealthReading, SetupPayload } from '../types.js';
import { buildNeedsYou, type NeedKind } from '../view/needsYou.js';

/**
 * Desktop notifications, so the cockpit can reach an operator who is not looking at it. The
 * Notification API rather than Web Push, since this deployment binds loopback and sends nothing off
 * the box — the cost is that **the tab must still be open**. Preference lives in `localStorage`,
 * not {@link Place} state, as a property of this browser.
 */

/** What a notification can be about. Each is independently switchable. */
type NotifyCategory = 'needsYou' | 'errors' | 'agents' | 'environments';

export interface NotifyPrefs {
  /** The master switch. False until the operator turns it on and the browser grants permission. */
  enabled: boolean;
  categories: Record<NotifyCategory, boolean>;
}

/** The categories, with the wording the settings panel draws. `agents` is the noisy one and its blurb says so rather than being defaulted off. */
export const NOTIFY_CATEGORIES: readonly { id: NotifyCategory; label: string; blurb: string }[] = [
  { id: 'needsYou', label: 'Needs you', blurb: 'A new escalation, plan, permission request or task for you' },
  { id: 'errors', label: 'Errors', blurb: 'A failure recorded by the harness' },
  { id: 'agents', label: 'Agent finished', blurb: 'A run reached an end — frequent on a busy fleet' },
  {
    id: 'environments',
    label: 'Environments',
    blurb: 'An environment stopped being well, got worse or better, or recovered',
  },
];

const PREFS_KEY = 'lubbdubb.notify';

const DEFAULT_PREFS: NotifyPrefs = {
  enabled: false,
  categories: { needsYou: true, errors: true, agents: true, environments: true },
};

/** Read the stored preference, falling back to the default on anything unreadable, so a half-written value degrades quietly rather than throwing. */
export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs>;
    return {
      enabled: parsed.enabled === true,
      categories: { ...DEFAULT_PREFS.categories, ...(parsed.categories ?? {}) },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Refused storage costs the preference its durability, not the session its notifications.
  }
}

/** `'unsupported'` where the API is absent, else the browser's current grant. */
export function notifyPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Ask the browser for permission. **Must be called from a user gesture** — every engine refuses it otherwise, so the only caller is a Settings button, never a mount effect. */
export async function requestNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

/** One thing worth telling the operator about. */
interface NotifyItem {
  category: NotifyCategory;
  /** Stable per subject, so a re-render or a reconnect replaces rather than repeats. */
  tag: string;
  title: string;
  body: string;
}

/** The slice of a snapshot notifications are decided from. Derived from **state**, never websocket frames, since the needs-you queue arrives as one coarse `dirty` signal. */
interface NotifySnapshot {
  needsYou: { id: string; kind: NeedKind; title: string }[];
  errors: { id: string; message: string }[];
  agents: { id: string; status: string }[];
  /** Whole readings, not a word: the notification quotes the check's own reasons. */
  environments: EnvironmentHealthReading[];
}

/** Statuses that mean a run is over. The live three are not endings. */
const AGENT_ENDINGS = new Set(['done', 'killed', 'interrupted', 'failed', 'crashed']);

/** How a needs-you row's kind reads in a notification title. Total over {@link NeedKind} with no fallback, so a new kind fails typecheck here rather than notifying under a generic heading. */
const NEED_KIND_LABEL: Record<NeedKind, string> = {
  config: "This harness's own configuration is stopping it",
  config_gap: "Something in this harness's configuration is hiding work",
  recovery: 'Runs orphaned by a restart',
  escalation: 'An agent is asking you',
  plan: 'A plan is waiting on your approval',
  reply: 'A drafted reply is waiting to be sent',
  merge: 'A merge is waiting on your verdict',
  shortfall: 'Delivered work did not reach its goal',
  intake: 'The appraisal could not say a goal is workable',
  permission: 'An agent wants a command',
  profile: 'A goal is waiting on which profile to run on',
  placement: 'A goal is missing from the backlog',
  bench: 'Work only you can do',
  close_out: 'A delivered goal needs closing',
  validate: 'A delivered goal is ready to be validated',
  watch: 'A post-deploy watch is reporting a regression',
  burn: 'A run is spending far more than usual',
  limit: 'An agent is out of account limit',
  supply: 'The fleet is running out of work',
  dispatch: 'A dispatch is being refused every pulse',
  assigned: 'A pull request is assigned to you',
  upgrade: 'An update to the harness is waiting',
  project_pull: 'The project checkout cannot be pulled',
};

/** Reduce a snapshot to what {@link notifiableChanges} compares. */
export function notifySnapshot(state: AppState, setup: SetupPayload | null = null): NotifySnapshot {
  return {
    needsYou: buildNeedsYou(state, setup).map((r) => ({ id: r.id, kind: r.kind, title: r.title })),
    errors: state.errors.map((e) => ({ id: e.id, message: e.message })),
    agents: state.agents.map((a) => ({ id: a.id, status: a.status })),
    environments: state.environmentHealth ?? [],
  };
}

/**
 * What appeared between two snapshots that is worth a notification. Pure, and the whole decision.
 * **A null `prev` yields nothing** — it seeds the comparison after a load or reconnect, so
 * already-queued rows don't announce themselves as new.
 */
export function notifiableChanges(prev: NotifySnapshot | null, next: NotifySnapshot): NotifyItem[] {
  if (prev === null) return [];
  const items: NotifyItem[] = [];

  const seenNeeds = new Set(prev.needsYou.map((r) => r.id));
  for (const row of next.needsYou) {
    if (seenNeeds.has(row.id)) continue;
    items.push({
      category: 'needsYou',
      tag: `need:${row.id}`,
      title: NEED_KIND_LABEL[row.kind],
      body: row.title,
    });
  }

  const seenErrors = new Set(prev.errors.map((e) => e.id));
  for (const err of next.errors) {
    if (seenErrors.has(err.id)) continue;
    items.push({ category: 'errors', tag: `error:${err.id}`, title: 'Error recorded', body: err.message });
  }

  // An ending, not an appearance: an agent is listed from the moment it spawns.
  const before = new Map(prev.agents.map((a) => [a.id, a.status]));
  for (const agent of next.agents) {
    if (!AGENT_ENDINGS.has(agent.status)) continue;
    const was = before.get(agent.id);
    if (was !== undefined && AGENT_ENDINGS.has(was)) continue;
    items.push({
      category: 'agents',
      tag: `agent:${agent.id}`,
      title: agent.status === 'done' ? 'Agent finished' : `Agent ${agent.status}`,
      body: agent.id,
    });
  }

  // Only state or tier is a change; a shifting reason list under one tier is the same episode.
  // An environment absent from `prev` is a first reading, skipped rather than announced.
  const wasRead = new Map(prev.environments.map((e) => [e.environment, e]));
  for (const env of next.environments) {
    const was = wasRead.get(env.environment);
    if (was === undefined) continue;
    if (was.state === env.state && was.tier === env.tier) continue;
    items.push({
      category: 'environments',
      // Keyed on the reading, not the environment, so an outage and its all-clear stack.
      tag: `env:${env.environment}:${env.changedAt}`,
      title: healthTitle(env),
      body: healthBody(env, was),
    });
  }

  return coalesce(items);
}

/** What one environment's change is called. `unknown` gets its own sentence: a check that could not answer is not an outage. */
function healthTitle(env: EnvironmentHealthReading): string {
  if (env.state === 'healthy') return `${env.environment} is well again`;
  if (env.state === 'unknown') return `${env.environment} did not answer`;
  return `${env.environment} is not well`;
}

/** What it says under the title: the check's own words where it has any; a recovery carries how long the episode ran, measured between the two `changedAt`s. */
function healthBody(env: EnvironmentHealthReading, was: EnvironmentHealthReading): string {
  if (env.state === 'healthy') return `After ${spell(was.changedAt, env.changedAt)} ${SAID[was.state]}`;
  const said = env.state === 'unknown' ? (env.detail ?? '') : '';
  const parts = [env.tier === null ? null : TIER_WORD[env.tier], said, ...env.reasons].filter(
    (part): part is string => part !== null && part !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : `The check said ${SAID[env.state]} and gave no reason`;
}

/** How each state reads inside a sentence about the state it has left or reached. */
const SAID: Record<EnvironmentHealthReading['state'], string> = {
  healthy: 'well',
  unhealthy: 'not well',
  unknown: 'unanswered',
};

/** The tier, as the notification's first word. Capitalised because it leads the body. */
const TIER_WORD: Record<'red' | 'orange', string> = { red: 'Red', orange: 'Orange' };

/** How long an episode ran, at the scale it is read: `2m`, `41m`, `3h 40m`. */
function spell(fromIso: string, toIso: string): string {
  const mins = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** The most subjects a coalesced notification spells out before it counts the rest. */
const SUMMARY_BODIES = 3;

/** How a batch of more than one reads in a title. */
const SUMMARY_TITLE: Record<NotifyCategory, (n: number) => string> = {
  needsYou: (n) => `${n} things need you`,
  errors: (n) => `${n} errors recorded`,
  agents: (n) => `${n} runs ended`,
  environments: (n) => `${n} environments changed`,
};

/**
 * Fold a batch to **at most one notification per category** — thirty errors in one pulse must not
 * be thirty banners. The tag is the batch's first subject plus its size, stable for the same batch
 * and different for the next.
 */
function coalesce(items: readonly NotifyItem[]): NotifyItem[] {
  const out: NotifyItem[] = [];
  for (const { id } of NOTIFY_CATEGORIES) {
    const batch = items.filter((i) => i.category === id);
    if (batch.length === 0) continue;
    if (batch.length === 1) {
      out.push(batch[0]!);
      continue;
    }
    const named = batch.slice(0, SUMMARY_BODIES).map((i) => i.body);
    const rest = batch.length - named.length;
    out.push({
      category: id,
      tag: `${batch[0]!.tag}+${batch.length - 1}`,
      title: SUMMARY_TITLE[id](batch.length),
      body: [...named, ...(rest > 0 ? [`+${rest} more`] : [])].join(' · '),
    });
  }
  return out;
}

/**
 * Fire the items the operator has switched on, suppressed only while the cockpit is actually in
 * front of them. Takes **both** `visibilityState` and `hasFocus()`: a window merely behind another
 * still reads `visible`, and a visibility-only gate would suppress exactly the case this exists for.
 */
export function fireNotifications(items: readonly NotifyItem[], prefs: NotifyPrefs): void {
  if (!prefs.enabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
  for (const item of items) {
    if (!prefs.categories[item.category]) continue;
    try {
      new Notification(item.title, { body: item.body, tag: item.tag });
    } catch {
      // Some engines throw on construction; a failed notification must never take the render down.
    }
  }
}

/** How far a test notification got. `sent` is the browser having **accepted** it, not the operator having seen it — `undelivered` is the engine reporting that gap. */
export type NotifyTestResult = 'sent' | 'undelivered' | 'blocked' | 'unsupported' | 'failed';

/**
 * Raise one notification on demand, so the chain can be proved rather than waited on. Deliberately
 * skips **both** gates {@link fireNotifications} applies: a button press means the window is
 * focused, and `prefs.enabled` is the switch being diagnosed. `onUndelivered` is best-effort.
 */
export function sendTestNotification(onUndelivered?: () => void): NotifyTestResult {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'granted') return 'blocked';
  try {
    const raised = new Notification('LubbDubb', {
      body: 'Notifications are working. The cockpit will reach you like this when it needs you.',
      tag: 'lubbdubb:test',
    });
    raised.onerror = () => onUndelivered?.();
    return 'sent';
  } catch {
    return 'failed';
  }
}
