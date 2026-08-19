import { useState } from 'react';
import {
  loadNotifyPrefs,
  notifyPermission,
  NOTIFY_CATEGORIES,
  requestNotifyPermission,
  saveNotifyPrefs,
  sendTestNotification,
  type NotifyPrefs,
  type NotifyTestResult,
} from '../cockpit/notify.js';

/**
 * Desktop notifications: the switch, the browser's grant, and the categories.
 *
 * **The only place permission is requested**, because every engine requires a
 * user gesture and refuses a mount-effect ask — silently, on some. So the grant
 * is asked for by a button an operator pressed, and never on load.
 *
 * Unlike everything else on this tab it is *writable*, which is not the
 * inconsistency it looks like: the running config is read-only because its honest
 * answer to "when does this take effect" is "at the next restart", and this
 * answers "now". It is a preference of this browser rather than of the harness —
 * held in `localStorage` beside the token, never sent anywhere — so two people on
 * one deployment can want different things without one of them being wrong.
 */
/**
 * What each outcome of the test button means, written so the sentence names who
 * is refusing — the browser, the desktop, or nobody.
 *
 * `sent` is the careful one. The constructor returning is the browser accepting
 * the notification and nothing more; whether a banner is drawn belongs to the
 * desktop, and Do Not Disturb, a focus mode and a per-application mute all drop
 * it after the point the page can observe. Claiming success outright would send
 * an operator back to look for a cockpit bug that is not there.
 */
const NOTIFY_TEST_WORDING: Record<NotifyTestResult, string> = {
  sent: 'Sent. If nothing appeared, the browser accepted it and your desktop dropped it — check Do Not Disturb or focus mode, and this browser’s own entry in the system notification settings.',
  undelivered:
    'The browser accepted it and then reported it could not be shown. That is the desktop refusing it, not the cockpit.',
  blocked: 'This browser is not granting notifications to the cockpit, so nothing can be raised.',
  unsupported: 'This browser has no Notification API.',
  failed: 'This browser refused to construct the notification.',
};

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => loadNotifyPrefs());
  const [permission, setPermission] = useState(() => notifyPermission());
  // Whether the ask has been made on this visit. A browser that neither grants
  // nor refuses leaves `permission` on `default` — the value it already held —
  // so without this the button is indistinguishable from one that did nothing.
  const [asked, setAsked] = useState(false);
  const [test, setTest] = useState<NotifyTestResult | null>(null);

  const write = (next: NotifyPrefs) => {
    setPrefs(next);
    saveNotifyPrefs(next);
  };

  const turnOn = async () => {
    setAsked(true);
    const granted = await requestNotifyPermission();
    setPermission(granted);
    // Only claim to be on if the browser actually said yes. Storing `enabled`
    // against a denied grant would leave a switch that reads on and does nothing.
    if (granted === 'granted') write({ ...prefs, enabled: true });
  };

  const runTest = () => {
    // Re-read the grant first: it is captured at mount, and the site-settings
    // route into it — the only route left once a browser has refused — changes
    // it without telling the page.
    setPermission(notifyPermission());
    setTest(sendTestNotification(() => setTest('undelivered')));
  };

  if (permission === 'unsupported') {
    return (
      <div className="settings-section">
        <span className="pm-section-label">Notifications</span>
        <p className="muted settings-hint">This browser has no Notification API, so the cockpit cannot raise one.</p>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <span className="pm-section-label">Notifications</span>
      <p className="muted settings-hint">
        Raised while the cockpit is open but not in front of you — a backgrounded tab or another window counts, a closed
        one does not. Nothing leaves this machine.
      </p>

      {permission === 'denied' && (
        <p className="muted settings-hint">
          This browser is blocking notifications for the cockpit. Allow them in its site settings; the harness cannot
          ask again once refused.
        </p>
      )}

      {asked && permission === 'default' && (
        <p className="muted settings-hint">
          The browser closed the request without answering it, so nothing is granted and nothing is blocked. Firefox
          does this with no prompt at all when <em>Block new requests asking to allow notifications</em> is ticked under
          Settings → Privacy &amp; Security → Permissions → Notifications; clear it, or add this site there by hand, and
          press the button again.
        </p>
      )}

      {permission === 'granted' ? (
        <>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => write({ ...prefs, enabled: e.target.checked })}
            />
            <span>Notify me</span>
          </label>
          {prefs.enabled &&
            NOTIFY_CATEGORIES.map((cat) => (
              <label className="settings-toggle settings-toggle-child" key={cat.id}>
                <input
                  type="checkbox"
                  checked={prefs.categories[cat.id]}
                  onChange={(e) => write({ ...prefs, categories: { ...prefs.categories, [cat.id]: e.target.checked } })}
                />
                <span>
                  {cat.label} <span className="muted">— {cat.blurb}</span>
                </span>
              </label>
            ))}
          <button className="btn small settings-test" onClick={runTest}>
            Send a test notification
          </button>
        </>
      ) : (
        <button className="btn small" disabled={permission === 'denied'} onClick={() => void turnOn()}>
          Enable notifications
        </button>
      )}

      {test !== null && <p className="muted settings-hint">{NOTIFY_TEST_WORDING[test]}</p>}
    </div>
  );
}
