import type { JSX, ReactNode } from 'react';
import { desktopDeepLink } from '../cockpit/desktopLink.js';

/**
 * Every control that opens the operator's own Claude Code, through one component.
 *
 * The URL was already written once — {@link desktopDeepLink} owns the scheme, and
 * the four prompt builders beside it own the commands — but the *control* was
 * written five times: the goal header's **Ask ↗** and **run it locally ↗**, the
 * validation card's **Run it in Claude Code**, and the plan sheet's **Discuss…**
 * twice over. Each hand-rolled its own anchor and its own title, and they had
 * already drifted: the two Discuss anchors said what the session would do and
 * never said *what command it would arrive with*, which is the one thing the deep
 * link's standing rule requires them to say.
 *
 * That rule is the reason this is a component rather than a convention. The link
 * fires only on the machine the browser is on, and a client that is not installed
 * answers **nothing at all** — no error, no tab, no window. So an operator reading
 * the cockpit from another desk needs the line to type, and the only place left to
 * put it is the title. A site that forgets leaves them with a control that did
 * nothing and said nothing; nothing is red, and the failure is only ever reported
 * by the person it happened to. Composing the title here means a new deep link
 * cannot be added without one.
 *
 * **The sentence is assembled, not passed.** `Opens your own Claude Code with
 * "<command>" <ready>, <explain>` — so every one of these controls opens with the
 * same clause in the same words, and a call site is left with only the half that
 * is actually its own: what the session will do once it is there.
 *
 * **An anchor, never a button.** A deep link is a destination. `className` is the
 * caller's, because these controls live in four different rows and wear those
 * rows' tones — the header's `cn-tgl`, the card's `btn`, the plan sheet's
 * `btn ghost`. What is shared is the address and the sentence, not the paint.
 *
 * No `target="_blank"`: `claude://` is handed to the OS handler rather than
 * navigated to, and a tab opened for it is a blank one left behind.
 */
export function DesktopLink({
  folder,
  prompt,
  explain,
  ready = 'ready to send',
  className,
  children,
}: {
  folder: string;
  prompt: string;
  /** What the session does once it is open — the half of the title that is the call site's own. */
  explain: string;
  /**
   * Whether the command is complete. Three of the four are, and send as they land;
   * **Ask** deliberately is not — it fills the composer with `/lubbdubb ask 284 `
   * and stops, because the operator has not said what they are asking yet.
   */
  ready?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <a
      className={className}
      href={desktopDeepLink(folder, prompt)}
      title={`Opens your own Claude Code with "${prompt.trim()}" ${ready}, ${explain}`}
    >
      {children}
    </a>
  );
}
