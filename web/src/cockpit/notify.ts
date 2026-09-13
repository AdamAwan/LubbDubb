import type { AppState, EnvironmentHealthReading, SetupPayload } from '../types.js';
import { buildNeedsYou, type NeedKind } from '../view/needsYou.js';

// → docs/spec/17-cockpit.md#the-address-bar

type NotifyCategory = 'needsYou' | 'errors' | 'agents' | 'environments';

export interface NotifyPrefs {
  enabled: boolean;
  categories: Record<NotifyCategory, boolean>;
}

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
    // TECHDEBT: a browser refusing storage (private mode, quota) costs the preference its
    // durability, not the session its notifications.
  }
}

export function notifyPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

interface NotifyItem {
  category: NotifyCategory;
  tag: string;
  title: string;
  body: string;
}

interface NotifySnapshot {
  needsYou: { id: string; kind: NeedKind; title: string }[];
  errors: { id: string; message: string }[];
  agents: { id: string; status: string }[];
  environments: EnvironmentHealthReading[];
}

const AGENT_ENDINGS = new Set(['done', 'killed', 'interrupted', 'failed', 'crashed']);

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
  validation_plan: 'A validation check set is waiting on your acceptance',
  watch: 'A post-deploy watch is reporting a regression',
  burn: 'A run is spending far more than usual',
  limit: 'An agent is out of account limit',
  supply: 'The fleet is running out of work',
  dispatch: 'A dispatch is being refused every pulse',
  assigned: 'A pull request is assigned to you',
  upgrade: 'An update to the harness is waiting',
  project_pull: 'The project checkout cannot be pulled',
};

export function notifySnapshot(state: AppState, setup: SetupPayload | null = null): NotifySnapshot {
  return {
    needsYou: buildNeedsYou(state, setup).map((r) => ({ id: r.id, kind: r.kind, title: r.title })),
    errors: state.errors.map((e) => ({ id: e.id, message: e.message })),
    agents: state.agents.map((a) => ({ id: a.id, status: a.status })),
    environments: state.environmentHealth ?? [],
  };
}

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

  const wasRead = new Map(prev.environments.map((e) => [e.environment, e]));
  for (const env of next.environments) {
    const was = wasRead.get(env.environment);
    if (was === undefined) continue;
    if (was.state === env.state && was.tier === env.tier) continue;
    items.push({
      category: 'environments',
      tag: `env:${env.environment}:${env.changedAt}`,
      title: healthTitle(env),
      body: healthBody(env, was),
    });
  }

  return coalesce(items);
}

function healthTitle(env: EnvironmentHealthReading): string {
  if (env.state === 'healthy') return `${env.environment} is well again`;
  if (env.state === 'unknown') return `${env.environment} did not answer`;
  return `${env.environment} is not well`;
}

function healthBody(env: EnvironmentHealthReading, was: EnvironmentHealthReading): string {
  if (env.state === 'healthy') return `After ${spell(was.changedAt, env.changedAt)} ${SAID[was.state]}`;
  const said = env.state === 'unknown' ? (env.detail ?? '') : '';
  const parts = [env.tier === null ? null : TIER_WORD[env.tier], said, ...env.reasons].filter(
    (part): part is string => part !== null && part !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : `The check said ${SAID[env.state]} and gave no reason`;
}

const SAID: Record<EnvironmentHealthReading['state'], string> = {
  healthy: 'well',
  unhealthy: 'not well',
  unknown: 'unanswered',
};

const TIER_WORD: Record<'red' | 'orange', string> = { red: 'Red', orange: 'Orange' };

function spell(fromIso: string, toIso: string): string {
  const mins = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const SUMMARY_BODIES = 3;

const SUMMARY_TITLE: Record<NotifyCategory, (n: number) => string> = {
  needsYou: (n) => `${n} things need you`,
  errors: (n) => `${n} errors recorded`,
  agents: (n) => `${n} runs ended`,
  environments: (n) => `${n} environments changed`,
};

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

export function fireNotifications(items: readonly NotifyItem[], prefs: NotifyPrefs): void {
  if (!prefs.enabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
  for (const item of items) {
    if (!prefs.categories[item.category]) continue;
    try {
      new Notification(item.title, { body: item.body, tag: item.tag });
    } catch {
      // TECHDEBT: some engines throw on Notification construction; a failed notification must
      // never take the render down.
    }
  }
}

export type NotifyTestResult = 'sent' | 'undelivered' | 'blocked' | 'unsupported' | 'failed';

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
