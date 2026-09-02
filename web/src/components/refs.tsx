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
 * - **A goal opens its page in the cockpit, and its ticket on the tracker.** The
 *   page is the richer of the two — the plan, the asks, the pull requests are all
 *   on it — and it is the one an operator cannot reach any other way from a row
 *   that merely mentions the goal; the tracker holds the story as it was written,
 *   which the page can only summarise. Both, as {@link RefDoors} draws them: two
 *   hit targets on one token, rather than a choice made on the row's behalf.
 * - **A goal the world does not carry links to the tracker instead.** Whether a
 *   ref has a page is `goalIssue`'s answer, handed in as `hasGoal`, for the
 *   reason the queue rail asks it rather than guessing: a page keyed on a ref the
 *   snapshot dropped renders nothing at all, and a link onto it is worse than a
 *   plain number.
 * - **A pull request opens its page and the provider's**, on the same terms: the
 *   page is built from the snapshot, so one for a pull request the snapshot
 *   dropped would draw nothing, and `hasPr` is what keeps a ref onto that one
 *   going to the provider alone.
 * - **Anything the provider could not resolve renders as plain text**, the rule
 *   `refLink` already follows: the `fake` provider resolves nothing, and a link
 *   that goes nowhere asserts more than a bare number does.
 *
 * How each of those is *drawn* is one vocabulary of three marks, and it lives in
 * `styles.css` rather than here: a **box** means a thing you can go to, a **fill**
 * inside the box means the destination is in the cockpit, an **arrow** means it
 * leaves. A `<Ref>` always stands on its own, so it always draws the box —
 * {@link RefText}, which is the same references inside a sentence, draws the arrow
 * alone. The exception is the last arm below: a branch name is already long, and a
 * box around `feature/context-budget` is a shape, not a signal.
 *
 * **What the marks cannot say is what a ref *is***, which is {@link refLabel}'s
 * job: `#212` for a goal, `PR 412` for a pull request. Three marks about
 * destination drew a pull request and the goal it delivers identically, and no
 * fourth mark would have been legible at 12px on a row that already carries lamps,
 * chips and hairline rules.
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
  openPr: (prNumber: number) => void;
  hasPr: (prNumber: number) => boolean;
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
export function RefLinks({
  refUrls,
  openGoal,
  hasGoal,
  openPr,
  hasPr,
  children,
}: RefWorld & { children: ReactNode }): JSX.Element {
  const world = useMemo(
    () => ({ refUrls, openGoal, hasGoal, openPr, hasPr }),
    [refUrls, openGoal, hasGoal, openPr, hasPr],
  );
  return <RefContext.Provider value={world}>{children}</RefContext.Provider>;
}

function useRefWorld(): RefWorld {
  const world = useContext(RefContext);
  if (world === null) throw new Error('a reference was drawn outside <RefLinks> — the shell provides it');
  return world;
}

/**
 * The shell's ref world with a panel's own URLs merged over it.
 *
 * For the surfaces fed by a **fetched** route rather than by the snapshot: the
 * work graph and the Tickets tab both resolve their own `refUrls` off the
 * connector, because `buildRefUrls` is assembled from the *world* and the things
 * those two remember left it long ago. `<Ref>` looks up the world the shell
 * provides, so a panel that drew one with its own URLs unmerged would render every
 * reference as plain text — correct-looking rows that are dead ends, which is the
 * single most repeated cockpit bug and the reason this module exists.
 *
 * `openGoal`, `hasGoal`, `openPr` and `hasPr` are kept from the parent deliberately,
 * not overridden.
 * `hasGoal` will say no for a ticket the snapshot has forgotten, and {@link Ref}'s
 * existing answer to that — link out to the tracker rather than open a page that
 * would render empty — is then exactly right, with no special case in the panel.
 */
export function RefLinksExtended({
  refUrls,
  children,
}: {
  refUrls: Record<string, string>;
  children: ReactNode;
}): JSX.Element {
  const parent = useRefWorld();
  // The route's URLs win: it asked the connector about these very refs, while the
  // snapshot's entry (if any) is whatever the world happened to still carry.
  const world = useMemo(() => ({ ...parent, refUrls: { ...parent.refUrls, ...refUrls } }), [parent, refUrls]);
  return <RefContext.Provider value={world}>{children}</RefContext.Provider>;
}

const GOAL_REF = /^issue:(\d+)(?::|$)/;
const PR_REF = /^pr:(\d+)(?::|$)/;

/**
 * The short name of a ref — `issue:212:part:writes` reads as `#212`, and `pr:412`
 * as `PR 412`.
 *
 * **The family is in the name, because the marks cannot carry it.** The three
 * marks below say where a reference *goes* — you can go there, it is here, it
 * leaves — and have nothing to say about what it *is*. So the rack drew `#412` for
 * a pull request and `#212` for the goal it delivers as the same token, and the
 * one question the pair raises ("which of these is the ticket?") was answered by
 * clicking one to find out. A goal keeps the tracker's own `#`, which is what
 * every tracker, every commit message and every operator already calls it; a pull
 * request says `PR`. Nothing has to be taught, and no fourth mark is spent.
 *
 * **The only place a ref becomes text.** It was written three times over (the
 * fleet's `goalLabel`, the rail's `subjectLabel`, the ask panel's own regex), and
 * a fourth was how a surface came to print a label with no link attached to it —
 * so `test/refLinks.test.ts` pins that nothing else strips a ref down to a number.
 * That is also why the `PR` belongs *here* rather than in the token that draws it:
 * two call sites had already prefixed it by hand (`` `PR ${refLabel(ref)}` ``),
 * which is the same fourth-surface bug one step along — the rows that said `PR`
 * were the rows somebody remembered.
 *
 * A ref in no family we recognise is returned whole: a branch name is already the
 * name it goes by, and shortening one would invent a thing.
 */
export function refLabel(ref: string): string {
  const goal = GOAL_REF.exec(ref);
  if (goal) return `#${goal[1]}`;
  const pr = PR_REF.exec(ref);
  return pr ? `PR ${pr[1]}` : ref;
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

  // Narrowed off the capture group rather than the match, which is the repo's
  // idiom and the thing that makes `number` a `string` for the lookups below.
  const goalNumber = GOAL_REF.exec(to)?.[1];
  if (goalNumber !== undefined) {
    const number = goalNumber;
    const ref = `issue:${number}`;
    const token = label ?? `#${number}`;
    if (world.hasGoal(ref)) {
      return (
        <RefDoors
          label={token}
          title={title ?? `Open goal #${number} — its plan, its pull requests and anything it is asking you`}
          onOpen={() => world.openGoal(ref)}
          out={issueUrl(world.refUrls, number)}
          outTitle={`Open #${number} on the tracker — the story as it was written, and its comments`}
        />
      );
    }
    // No page to open: the goal is not in the world the snapshot shipped, so the
    // tracker is the only destination that exists. `issue:<n>` before `#<n>` for
    // `TicketLink`'s reason — `#<n>` is shared with a pull request of the same
    // number, and `buildRefUrls` walks the pull requests first.
    return <ExtLinkFor keys={[ref, `#${number}`]} label={token} title={title} world={world} />;
  }

  const prNumber = PR_REF.exec(to)?.[1];
  if (prNumber !== undefined) {
    const number = Number(prNumber);
    const token = label ?? `PR ${prNumber}`;
    if (world.hasPr(number)) {
      return (
        <RefDoors
          label={token}
          title={title ?? `Open pull request #${prNumber} — its review threads, its checks and the work on its branch`}
          onOpen={() => world.openPr(number)}
          out={prUrl(world.refUrls, number)}
          outTitle={`Open pull request #${prNumber} on the provider — the diff, the review, the checks`}
        />
      );
    }
    // No page: the pull request has left the world the snapshot ships — a closed
    // one on a deployment retaining none — so the provider's page is the only
    // destination there is.
    //
    // `#412` is what `buildRefUrls` keys an open pull request by; `pr:412` is the
    // structured key a world event or a task origin resolves under. Either
    // answers, and which one the snapshot happens to carry is not the row's
    // business — the whole reason this lookup is written once.
    return <ExtLinkFor keys={[to, `#${prNumber}`]} label={token} title={title} world={world} />;
  }

  // A branch, a `job:` origin, anything else the provider may or may not know.
  return <>{refLink(label ?? to, world.refUrls)}</>;
}

/**
 * One reference with **both its doors**: the cockpit's page, and the provider's.
 *
 * A goal and a pull request each exist in two places, and the two answer different
 * questions — *what does the harness make of this* is the cockpit's page, *what
 * does the tracker or the diff actually say* is the provider's. A `<Ref>` used to
 * offer only the first, which made the provider a place you had to go and find,
 * and the one row that minded (the overview's pull-request rack) fixed it locally
 * by drawing a **second token with the same number in it**. Two `#412`s side by
 * side read as a repeat rather than as two destinations — which is how the rack
 * came to be the clearest example of references that all look alike.
 *
 * So it is one token with two hit targets, and the shape says so: the number is
 * the filled box that stays here, the arm is dashed-jointed and carries the arrow
 * that leaves. No new mark — the same three the vocabulary already has, arranged
 * so the pair reads as one thing.
 *
 * **The arm is absent, not inert, when the provider resolved nothing** (the `fake`
 * provider resolves everything to nothing). It sits against a token that *did*
 * resolve, so a dead second target reads as a broken link, where a missing one
 * reads as a token with one door — which is exactly what it is. That is the
 * opposite of {@link TicketLink}'s rule, and deliberately: a page's lone control
 * saying "no address for this" is a stated fact, a row's second target saying it
 * is noise on every row.
 */
function RefDoors({
  label,
  title,
  onOpen,
  out,
  outTitle,
}: {
  label: string;
  title: string;
  onOpen: () => void;
  out: string | undefined;
  outTitle: string;
}): JSX.Element {
  const token = (
    <button type="button" className="ref-goal" title={title} onClick={onOpen}>
      {label}
    </button>
  );
  if (out === undefined) return token;
  return (
    <span className="ref-pair">
      {token}
      {/* The glyph is decoration — the arm's name is what it opens, so a screen
          reader is told that rather than "north east arrow". */}
      <a
        className="ref-arm"
        href={out}
        title={outTitle}
        aria-label={outTitle}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span aria-hidden="true">↗</span>
      </a>
    </span>
  );
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
    <ExtLink href={url} title={title} boxed>
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

/**
 * The way to a pull request on the provider — the `Open pull request ↗` its page
 * carries, and the destination {@link Ref} stops offering the moment the cockpit
 * has a page of its own for it.
 *
 * The same shape as {@link TicketLink} and for the same reason: a `<Ref>` onto a
 * pull request the world carries now opens its **page**, which is the richer of
 * the two and the one nothing else reaches, so the provider needs a control of
 * its own. Two keys, most-trusted first — `pr:<n>` is unambiguous where `#<n>` is
 * shared with an issue of the same number, and `buildRefUrls` writes both.
 *
 * Inert rather than absent when neither resolves, which is {@link TicketLink}'s
 * rule: a control that comes and goes is a page whose shape depends on what a
 * provider happened to resolve.
 */
export function PrLink({
  number,
  className,
  children,
}: {
  number: number;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const href = prUrl(useRefWorld().refUrls, number);
  if (href === undefined)
    return (
      <span
        className={className}
        aria-disabled="true"
        title="No address for this pull request: the provider did not give it one, and the harness could not resolve it from the ref either. Nothing to open."
      >
        {children}
      </span>
    );
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A pull request's address on the provider, by the two keys `buildRefUrls` writes for one. */
function prUrl(refUrls: Record<string, string>, number: number): string | undefined {
  // `pr:<n>` first because it is unambiguous: `#<n>` is shared with an issue of the
  // same number, and the first writer into the map wins.
  return refUrls[`pr:${number}`] ?? refUrls[`#${number}`];
}

/**
 * A goal's ticket on the tracker, by the two keys `buildRefUrls` writes for one.
 *
 * `issue:<n>` first for {@link TicketLink}'s reason, which is worth restating
 * because it is the one that bites: `#<n>` is **shared**, and `buildRefUrls` walks
 * the pull requests before the issues, so on a tracker where issue 412 and PR 412
 * both exist `#412` is the pull request's address. A goal's arm that tried it
 * first opened the wrong thing on exactly the deployments busy enough to have
 * both. `TicketLink` tries the item's own `url` above these two; a `<Ref>` has no
 * item in hand, only a number.
 */
function issueUrl(refUrls: Record<string, string>, number: string): string | undefined {
  return refUrls[`issue:${number}`] ?? refUrls[`#${number}`];
}

/**
 * The way to a goal's ticket on the provider — the `Open ticket ↗` the goal page
 * carries, and the one destination {@link Ref} deliberately does not offer.
 *
 * A `<Ref>` onto a goal the world carries opens its **page**, because that is the
 * richer destination and the one nothing else reaches. So the tracker needs a
 * control of its own, and this is it: here rather than in the page that draws it,
 * because everything below is a judgement about *how a ref resolves*, which is
 * this module's job and not a page's.
 *
 * **Three keys, in the order of how much each can be trusted.** The item's own
 * `url` is the provider's and authoritative. `issue:<n>` is next because it is
 * **unambiguous**: `stateSnapshot` keys it for every world issue *and* every
 * retained run, and nothing else ever writes it. `#<n>` is last because it is
 * **shared** — `buildRefUrls` walks the pull requests before the issues and the
 * first writer wins, so on a tracker where issue 412 and PR 412 both exist, `#412`
 * is the pull request's address, and a control that tried it first was quietly
 * opening the wrong thing.
 *
 * Trying only `#<n>` is also why this control used to **vanish on a retained
 * run**: `#<n>` is built from `world.issues`, and a run the harness kept after its
 * ticket left the world is by definition not in that list — so the goals whose
 * ticket was hardest to find by hand were the ones offering no way to it.
 *
 * **Inert rather than absent when nothing resolves.** A control that comes and
 * goes is a row whose shape depends on what a provider happened to resolve, and
 * "the tracker gave this item no address" is a fact worth stating where a missing
 * button says nothing and reads as the cockpit having forgotten. It stops being an
 * `<a>` at that point rather than becoming one with no `href`: a link that leads
 * nowhere is the dead end this module exists to prevent.
 */
export function TicketLink({
  number,
  url,
  className,
  children,
}: {
  number: number;
  /** The item's own address, where the provider gave it one. */
  url?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const { refUrls } = useRefWorld();
  const href = url ?? refUrls[`issue:${number}`] ?? refUrls[`#${number}`];
  if (href === undefined)
    return (
      <span
        className={className}
        aria-disabled="true"
        title="No address for this ticket: the tracker did not give the item one, and the harness could not resolve it from the goal’s ref either. Nothing to open."
      >
        {children}
      </span>
    );
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
