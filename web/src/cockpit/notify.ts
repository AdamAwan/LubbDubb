import type { AppState } from '../types.js';
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
type NotifyCategory = 'needsYou' | 'errors' | 'agents';

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
];

const PREFS_KEY = 'lubbdubb.notify';

const DEFAULT_PREFS: NotifyPrefs = {
  enabled: false,
  categories: { needsYou: true, errors: true, agents: true },
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
}

/** Statuses that mean a run is over. The live three are not endings. */
const AGENT_ENDINGS = new Set(['done', 'killed', 'interrupted', 'failed', 'crashed']);

/**
 * How a needs-you row's kind reads in a notification title.
 *
 * Total over {@link NeedKind} rather than a lookup with a fallback, so a seventh
 * kind of ask fails the typecheck here instead of quietly notifying under a
 * generic heading — which is the failure a fallback would have hidden for
 * exactly as long as nobody read the notification carefully.
 */
const NEED_KIND_LABEL: Record<NeedKind, string> = {
  recovery: 'Runs orphaned by a restart',
  escalation: 'An agent is asking you',
  proposal: 'A decision is waiting on you',
  permission: 'An agent wants a command',
  bench: 'Work only you can do',
  close_out: 'A delivered goal needs closing',
  limit: 'An agent is out of account limit',
};

/** Reduce a snapshot to what {@link notifiableChanges} compares. */
export function notifySnapshot(state: AppState): NotifySnapshot {
  return {
    needsYou: buildNeedsYou(state).map((r) => ({ id: r.id, kind: r.kind, title: r.title })),
    errors: state.errors.map((e) => ({ id: e.id, message: e.message })),
    agents: state.agents.map((a) => ({ id: a.id, status: a.status })),
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

  return items;
}

/**
 * Fire the items the operator has switched on.
 *
 * **Suppressed while the document is visible**, which is the one piece of
 * judgement here: a notification for a row you are looking at is noise, and the
 * whole point is to reach you when you are somewhere else. Backgrounded, behind
 * another window and on another desktop all count as hidden, so the cases that
 * matter still fire.
 */
export function fireNotifications(items: readonly NotifyItem[], prefs: NotifyPrefs): void {
  if (!prefs.enabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
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
