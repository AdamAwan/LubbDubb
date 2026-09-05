import type { JSX } from 'react';
import { desktopDeepLink } from '../cockpit/desktopLink.js';
import { buttonClass } from './button.js';
import { Icon } from './icons.js';

/**
 * Every control that opens the operator's own Claude Code, through one component.
 *
 * The URL was already written once — {@link desktopDeepLink} owns the scheme, and
 * the prompt builders beside it own the commands — and the *sentence* was written
 * here. The **label** and the **look** were still the call site's, and both had
 * drifted: six controls said `Ask Claude Code ↗`, `run it locally ↗`, `Question?`,
 * `Run it in Claude Code` and `Discuss…` twice, wearing `cn-tgl`, `cn-linkish`,
 * `cn-ask-btn` and two different `buttonClass` looks. Six names for one act is a
 * vocabulary an operator has to learn per surface, and the argument about which
 * verb a given site deserves has no end, because every site can make a case.
 *
 * So the component owns all four now — address, sentence, label and look — and
 * takes no `className` and no `children`. What differs between call sites is what
 * the session *arrives with*, which is `prompt`, and what it *does*, which is
 * `explain` — the two things that were always the caller's and still are.
 *
 * **The label varies by the _act_, never by the surface**, which is why it is a
 * closed union rather than a string. Five of the six controls are the same act —
 * *open the thing I am looking at* — and say “Open in Claude Code”. The top bar's
 * is not that act: it is drawn beside the wordmark, addresses no goal and starts a
 * *question*, so a label naming the destination described the mechanism and left
 * the offer unmade. Two acts, two names, and a `string` here is how six come back.
 *
 * **The look is the shared button kit's, not a family of its own.** `buttonClass`
 * carries `btn` twice, which is what survives `console.css`'s `.cn button` reset —
 * so one call here is native on both grounds, the goal header and the top bar
 * inside `.cn`, the plan sheet and the escalation card outside it. A control drawn
 * on two grounds is exactly the case a second class would have had to keep in step
 * by hand.
 *
 * The link fires only on the machine the browser is on, and a client that is not
 * installed answers **nothing at all** — no error, no tab, no window. So an
 * operator reading the cockpit from another desk needs the line to type, and the
 * only place left to put it is the title. Composing it here means a new deep link
 * cannot be added without one.
 *
 * **An anchor, never a button.** A deep link is a destination. No `target="_blank"`:
 * `claude://` is handed to the OS handler rather than navigated to, and a tab
 * opened for it is a blank one left behind.
 */
export function DesktopLink({
  folder,
  prompt,
  explain,
  ready = 'ready to send',
  label = 'Open in Claude Code',
}: {
  folder: string;
  prompt: string;
  /** What the session does once it is open — the half of the title that is the call site's own. */
  explain: string;
  /**
   * Whether the command is complete. Most are, and send as they land; the two
   * that start a *conversation* deliberately are not — they fill the composer and
   * stop, because the operator has not said what they are asking yet.
   */
  ready?: string;
  /**
   * Which of the two acts this is. `Question?` belongs to the one control that
   * addresses nothing and asks — the top bar's; everything drawn beside the thing
   * it opens takes the default. A union rather than a `string` so a seventh name
   * cannot be written at a call site.
   */
  label?: 'Open in Claude Code' | 'Question?';
}): JSX.Element {
  return (
    <a
      className={buttonClass({ ghost: true, size: 'small' })}
      href={desktopDeepLink(folder, prompt)}
      title={`Opens your own Claude Code with "${prompt.trim()}" ${ready}, ${explain}`}
    >
      <Icon name="chat" />
      {label} ↗
    </a>
  );
}
