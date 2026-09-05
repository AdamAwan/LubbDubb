import type { AppState, EnvironmentHealthReading, SetupPayload } from '../types.js';
import { buildNeedsYou, type NeedKind } from '../view/needsYou.js';

/**
 * Desktop notifications, so the cockpit can reach an operator who is not looking
 * at it.
 *
 * Everything the harness asks of a human — an escalation holding a parked agent
 * and its worktree, a plan waiting to be approved, a permission request, a
 * close-out — lands in a queue that is only visible in an open browser tab, on
 * loopback, on the machine the harness runs on. Nothing carried it any further.
 * A parked agent therefore held its slot for exactly as long as it took somebody
 * to happen to look, and the recovery queue holds *every* pulse while it is up,
 * so an unnoticed restart stops the fleet outright.
 *
 * ## Why the Notification API and not Web Push
 *
 * Web Push survives the tab being closed, and costs a service worker, VAPID
 * keys, a subscription table to persist, and an outbound HTTPS connection from
 * the harness to Google's or Mozilla's push service. That last one is the whole
 * objection: this deployment binds loopback, holds its token in a 0600 file and
 * sends nothing off the box, and a notification channel is a poor reason to be
 * the first thing that does. The Notification API needs none of it — the page is
 * already holding a websocket, and a notification is one constructor call.
 *
 * The cost is stated rather than hidden: **the tab must still be open.** It may
 * be backgrounded, buried behind other windows, on another desktop — all of which
 * are the cases that matter — but a closed tab notifies nothing.
 *
 * ## Why the preference is in `localStorage`
 *
 * Beside the cockpit token, and for the same reason: it is a property of *this
 * browser*, not of the harness. Two people on one deployment want different
 * answers, and a server-side setting would make one of them wrong. It is not
 * {@link Place} state either — the address bar holds where you are, and this is
 * not somewhere you can be.
 */

/** What a notification can be about. Each is independently switchable. */
type NotifyCategory = 'needsYou' | 'errors' | 'agents' | 'environments';

export interface NotifyPrefs {
  /** The master switch. False until the operator turns it on and the browser grants permission. */
  enabled: boolean;
  categories: Record<NotifyCategory, boolean>;
}

/**
 * The categories, with the wording the settings panel draws.
 *
 * `agents` is the noisy one and is described as such rather than quietly left
 * off: on a three-wide fleet it fires several times an hour, which is fine when
 * you are waiting on one run and tiresome when you are not. Switchable is the
 * answer to that, not a default nobody can find.
 */
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

/**
 * Read the stored preference, falling back to the default on anything unreadable.
 *
 * Tolerant by construction: a preference is not worth an error screen, and a
 * half-written or older-shaped value must degrade to "notifications off" rather
 * than throwing on the first render.
 */
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
    // A browser refusing storage (private mode, quota) costs the preference its
    // durability, not the session its notifications.
  }
}

/** `'unsupported'` where the API is absent, else the browser's current grant. */
export function notifyPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Ask the browser for permission. **Must be called from a user gesture** — every
 * engine refuses it otherwise, silently in some — which is why the only caller is
 * a button in Settings and never a mount effect.
 */
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

/**
 * The slice of a snapshot notifications are decided from.
 *
 * Everything is derived from **state**, not from websocket frames, and that is
 * the design rather than an implementation detail. The needs-you queue is
 * assembled from four sources that arrive as one coarse `dirty` signal, so
 * frame-watching would have covered escalations and missed human tasks, plan
 * approvals and recovery — the three a frame never announces. Diffing the
 * rendered queue instead covers all of them by construction, and stays true if a
 * seventh kind is added.
 */
interface NotifySnapshot {
  needsYou: { id: string; kind: NeedKind; title: string }[];
  errors: { id: string; message: string }[];
  agents: { id: string; status: string }[];
  /**
   * The health readings, whole rather than reduced to a word: the notification
   * quotes the check's own reasons, and how long the episode it is ending ran.
   */
  environments: EnvironmentHealthReading[];
}

/** Statuses that mean a run is over. The live three are not endings. */
const AGENT_ENDINGS = new Set(['done', 'killed', 'interrupted', 'failed', 'crashed']);

/**
 * How a needs-you row's kind reads in a notification title.
 *
 * Total over {@link NeedKind} rather than a lookup with a fallback, so a new
 * kind of ask fails the typecheck here instead of quietly notifying under a
 * generic heading — which is the failure a fallback would have hidden for
 * exactly as long as nobody read the notification carefully.
 */
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
 * What appeared between two snapshots that is worth a notification.
 *
 * Pure, and the whole of the decision — the browser half below does no filtering
 * beyond the operator's switches, so this is the one place to read or test what
 * fires.
 *
 * **A null `prev` yields nothing.** The first snapshot after a load, a reconnect
 * or a token entry seeds the comparison; without this every row already in the
 * queue would announce itself as new, which is a notification storm on exactly
 * the deployments with the most waiting for them.
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

  // An ending, not an appearance: an agent is in the list from the moment it
  // spawns, so a new id is a run *starting*. The transition into a terminal
  // status is the event, and an agent already terminal in `prev` has had its.
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

  // An environment is notified on a **change between two readings the cockpit
  // holds both of**, which is `changed_at`'s own rule read forwards: state or
  // tier moves it, and a shifting reason list under one tier does not — that is
  // the same episode still running, and firing on it would be a notification
  // every interval for as long as the outage lasts.
  //
  // An environment absent from `prev` is skipped rather than announced. It is a
  // first reading — a newly configured environment, or a snapshot that arrived
  // without the list — and every one of those would otherwise announce itself as
  // an event on the pulse the cockpit first saw it, `unknown` and healthy alike.
  const wasRead = new Map(prev.environments.map((e) => [e.environment, e]));
  for (const env of next.environments) {
    const was = wasRead.get(env.environment);
    if (was === undefined) continue;
    if (was.state === env.state && was.tier === env.tier) continue;
    items.push({
      category: 'environments',
      // Keyed on the reading and not the environment, so the next change stacks
      // beside this one rather than replacing it: an outage and its all-clear are
      // two things to have been told.
      tag: `env:${env.environment}:${env.changedAt}`,
      title: healthTitle(env),
      body: healthBody(env, was),
    });
  }

  return coalesce(items);
}

/**
 * What one environment's change is called.
 *
 * The three states get three sentences, and `unknown` gets its own rather than
 * borrowing either neighbour's: a check that could not answer is not an outage,
 * and telling an operator their environment is down because a credential expired
 * is the failure the three-valued state exists to prevent.
 */
function healthTitle(env: EnvironmentHealthReading): string {
  if (env.state === 'healthy') return `${env.environment} is well again`;
  if (env.state === 'unknown') return `${env.environment} did not answer`;
  return `${env.environment} is not well`;
}

/**
 * What it says under the title: the check's own words where it has any, and what
 * the harness knows where it has none.
 *
 * A recovery has no reasons by construction, so it carries the one fact the
 * reading it replaced can supply — how long the episode ran. It is measured
 * between the two `changedAt`s rather than against the clock, which keeps this
 * function pure and gives the same answer however late the cockpit noticed.
 */
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
 * Fold a batch to **at most one notification per category**.
 *
 * The diff above is per subject, and that is the right record of what is new —
 * but it is not the right number of interruptions. A cascade records thirty
 * errors inside one pulse and a restart fills the queue rail in one go, so the
 * operator got thirty desktop banners for one event and ten for one glance's
 * worth of work. Every one of them said the same thing: *go and look at the
 * cockpit*. Past the first, they are not information, they are a denial of
 * service on the person the feature exists to reach.
 *
 * So a batch says it once and says how many. What each row **is** stays in the
 * queue rail and the error list, which is where it is answered anyway — a
 * notification's whole job is to get somebody there.
 *
 * The tag is built from the batch's first subject and its size, so it is stable
 * for the same batch (a re-render replaces rather than repeats, exactly as a
 * per-subject tag does) and different for the next one (a second burst stacks
 * beside the first rather than silently overwriting its count).
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
 * Fire the items the operator has switched on.
 *
 * **Suppressed only while the cockpit is actually in front of the operator**,
 * which is the one piece of judgement here: a notification for a row you are
 * looking at is noise, and the whole point is to reach you when you are
 * somewhere else.
 *
 * That takes **both** halves, and visibility alone is not it. A document is
 * `hidden` only when its tab is not the selected one or its window is minimized;
 * a window merely *behind* another, or on another virtual desktop, still reads
 * `visible` in every engine — so a visibility-only gate suppressed precisely the
 * case this feature exists for, and did it silently. `hasFocus()` is the half
 * that answers "is this the window you are in", and it is false for both.
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
      // Some engines throw on construction rather than resolving to a no-op
      // (older Android WebView most notably). A failed notification must never
      // take the render down with it.
    }
  }
}

/**
 * How far a test notification got. `sent` is the browser having **accepted** it,
 * which is deliberately not the same claim as the operator having seen it —
 * everything past the constructor belongs to the desktop, and `undelivered` is
 * the engine coming back to say so.
 */
export type NotifyTestResult = 'sent' | 'undelivered' | 'blocked' | 'unsupported' | 'failed';

/**
 * Raise one notification on demand, so the chain can be proved rather than
 * waited on.
 *
 * The feature is otherwise unfalsifiable, and that is the whole reason this
 * exists: every quiet link in the chain — a grant that was never given, an
 * engine that refuses the constructor, a desktop dropping what the browser
 * accepted — presents to an operator as *no notification*, which is also what a
 * fleet with nothing to say presents as. There is no way to tell those apart by
 * watching, and the honest reading of "I can't get this working" is usually that
 * nothing had happened worth announcing yet.
 *
 * It skips **both** gates {@link fireNotifications} applies, each for its own
 * reason. The focus gate cannot survive a button: a press means the window is
 * focused by definition, so keeping it would make the test unpassable. And
 * `prefs.enabled` is skipped because the switch is what you are trying to decide
 * whether to trust — a diagnostic that answers only once you have already
 * committed to the thing diagnoses nothing.
 *
 * `onUndelivered` fires on the engine's `error` event, which is the one signal
 * that separates "the desktop dropped it" from "it worked and you were not
 * looking". It is late and best-effort — engines that drop a notification
 * silently report nothing, so its absence proves nothing either way.
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
