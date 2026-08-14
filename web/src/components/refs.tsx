import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react';
import { ExtLink, linkify, refLink } from './util.js';

/**
 * Every cross-reference the cockpit draws, through one component.
 *
 * A surface that *names* another thing — a goal, a pull request, the part an
 * agent is on — and does not offer a way there is the cockpit's most repeated
 * bug: the fleet card said "fix failing CI on PR #412" beside "#212" and neither
 * was a link, so the one question the row raises ("what is that?") was answered
 * by scrolling somewhere else. It kept coming back because linking was a thing
 * each site remembered to do rather than the only way to draw a ref at all.
 *
 * So there is one vocabulary and one component. **The vocabulary is the
 * harness's own colon-form ref** — `issue:212`, `issue:212:part:writes`,
 * `pr:412` — which is what tasks, queue items, findings and world events already
 * carry, so most call sites pass a value they are already holding rather than
 * re-deriving a number. And **the destination is the ref's own business**, not
 * the caller's:
 *
 * - **A goal opens its page in the cockpit.** That is the richer of the two
 *   destinations — the plan, the asks, the pull requests and the ticket's own
 *   `Open ticket ↗` are all on it — and it is the one an operator cannot reach
 *   any other way from a row that merely mentions the goal.
 * - **A goal the world does not carry links to the tracker instead.** Whether a
 *   ref has a page is `goalIssue`'s answer, handed in as `hasGoal`, for the
 *   reason the queue rail asks it rather than guessing: a page keyed on a ref the
 *   snapshot dropped renders nothing at all, and a link onto it is worse than a
 *   plain number.
 * - **A pull request links out.** There is no PR page in the cockpit, so the
 *   provider's is the only destination there is.
 * - **Anything the provider could not resolve renders as plain text**, the rule
 *   `refLink` already follows: the `fake` provider resolves nothing, and a link
 *   that goes nowhere asserts more than a bare number does.
 *
 * The one thing a call site still has to get right is *not putting a ref inside a
 * button*: a link nested in a control is a second destination for one click. The
 * rows that carry both draw the name as the control and the refs beside it — see
 * the fleet card and the backlog row.
 */
interface RefWorld {
  refUrls: Record<string, string>;
  openGoal: (ref: string) => void;
  hasGoal: (ref: string) => boolean;
}

/**
 * Null rather than a working default, so a `<Ref>` rendered outside the provider
 * throws where it is written instead of quietly drawing plain text — which is the
 * failure this whole module exists to stop, and the one nothing would catch.
 */
const RefContext = createContext<RefWorld | null>(null);

/**
 * What references resolve against, provided once at the shell so no surface has
 * to be handed `refUrls` and a way onto a goal's page to draw a link.
 *
 * At the shell rather than in the console, because the drawer and the modals draw
 * refs too and none of them is inside `ConsoleRoot`.
 */
export function RefLinks({ refUrls, openGoal, hasGoal, children }: RefWorld & { children: ReactNode }): JSX.Element {
  const world = useMemo(() => ({ refUrls, openGoal, hasGoal }), [refUrls, openGoal, hasGoal]);
  return <RefContext.Provider value={world}>{children}</RefContext.Provider>;
}

function useRefWorld(): RefWorld {
  const world = useContext(RefContext);
  if (world === null) throw new Error('a reference was drawn outside <RefLinks> — the shell provides it');
  return world;
}

const GOAL_REF = /^issue:(\d+)(?::|$)/;
const PR_REF = /^pr:(\d+)(?::|$)/;

/**
 * The short name of a ref — `issue:212:part:writes` and `pr:412` both read as
 * `#212` / `#412`, which is what every row calls them.
 *
 * **The only place a ref becomes text.** It was written three times over (the
 * fleet's `goalLabel`, the rail's `subjectLabel`, the ask panel's own regex), and
 * a fourth was how a surface came to print a label with no link attached to it —
 * so `test/refLinks.test.ts` pins that nothing else strips a ref down to a number.
 *
 * A ref in no family we recognise is returned whole: a branch name is already the
 * name it goes by, and shortening one would invent a thing.
 */
export function refLabel(ref: string): string {
  const goal = GOAL_REF.exec(ref);
  if (goal) return `#${goal[1]}`;
  const pr = PR_REF.exec(ref);
  return pr ? `#${pr[1]}` : ref;
}

/**
 * One reference, as the way to the thing it names.
 *
 * `to` is a colon-form ref; a null one draws nothing at all, so a call site with
 * an optional origin needs no conditional of its own. `label` overrides the short
 * name for a row that wants to say `PR #412` rather than `#412` — it never
 * changes where the click goes.
 */
export function Ref({
  to,
  label,
  title,
}: {
  to: string | null | undefined;
  label?: string;
  title?: string;
}): ReactNode {
  const world = useRefWorld();
  if (!to) return null;

  const goal = GOAL_REF.exec(to);
  if (goal) {
    const ref = `issue:${goal[1]}`;
    const token = label ?? `#${goal[1]}`;
    if (world.hasGoal(ref)) {
      return (
        <button
          type="button"
          className="ref-goal"
          title={title ?? `Open goal #${goal[1]} — its plan, its pull requests and anything it is asking you`}
          onClick={() => world.openGoal(ref)}
        >
          {token}
        </button>
      );
    }
    // No page to open: the goal is not in the world the snapshot shipped, so the
    // tracker is the only destination that exists.
    return <ExtLinkFor keys={[`#${goal[1]}`, ref]} label={token} title={title} world={world} />;
  }

  const pr = PR_REF.exec(to);
  if (pr) {
    // `#412` is what `buildRefUrls` keys an open pull request by; `pr:412` is the
    // structured key a world event or a task origin resolves under. Either
    // answers, and which one the snapshot happens to carry is not the row's
    // business — the whole reason this lookup is written once.
    return <ExtLinkFor keys={[`#${pr[1]}`, to]} label={label ?? `#${pr[1]}`} title={title} world={world} />;
  }

  // A branch, a `job:` origin, anything else the provider may or may not know.
  return <>{refLink(label ?? to, world.refUrls)}</>;
}

/** The first key the provider resolved, or the label as plain text when it resolved none. */
function ExtLinkFor({
  keys,
  label,
  title,
  world,
}: {
  keys: string[];
  label: string;
  title?: string;
  world: RefWorld;
}): JSX.Element {
  const url = keys.map((key) => world.refUrls[key]).find((found) => found !== undefined);
  if (url === undefined) return <>{label}</>;
  return (
    <ExtLink href={url} title={title}>
      {label}
    </ExtLink>
  );
}

/**
 * A run of prose that mentions references — a queue reason, a world signal, an
 * agent's note. Every `#n` in it becomes a tracker link where the provider
 * resolved one.
 *
 * Deliberately **not** routed through {@link Ref}: a bare `#412` in a sentence
 * does not say whether it is a goal or a pull request, and guessing would be a
 * link onto whichever of the two shares the number. The tracker's page answers
 * either.
 */
export function RefText({ text }: { text: string }): ReactNode {
  return linkify(text, useRefWorld().refUrls);
}
