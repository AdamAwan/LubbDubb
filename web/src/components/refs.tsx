import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react';
import { ExtLink, linkify, refLink } from './util.js';

/**
 * Every cross-reference the cockpit draws, through one component. Vocabulary is the harness's own
 * colon-form ref (`issue:212`, `pr:412`); **the destination is the ref's own business**: a goal
 * opens its cockpit page *and* its tracker ticket as two hit targets ({@link RefDoors}), keyed off
 * `hasGoal`/`hasPr` rather than guessed; anything unresolved renders as plain text.
 *
 * The three marks live in `styles.css`: a **box** means a destination, a **fill** means it's in the
 * cockpit, an **arrow** means it leaves. What they say is not what a ref *is* — that's {@link refLabel}.
 *
 * A call site must never put a ref inside a button: a link nested in a control is a second
 * destination for one click.
 */
interface RefWorld {
  refUrls: Record<string, string>;
  openGoal: (ref: string) => void;
  hasGoal: (ref: string) => boolean;
  openPr: (prNumber: number) => void;
  hasPr: (prNumber: number) => boolean;
}

/** Null rather than a working default, so a `<Ref>` outside the provider throws where written instead of quietly drawing plain text. */
const RefContext = createContext<RefWorld | null>(null);

/** What references resolve against, provided once at the shell so no surface has to be handed `refUrls`. At the shell, not the console, since the drawer and modals draw refs too. */
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
 * The shell's ref world with a panel's own URLs merged over it, for surfaces fed by a **fetched**
 * route rather than the snapshot. `openGoal`/`hasGoal`/`openPr`/`hasPr` are kept from the parent
 * deliberately: `hasGoal` saying no for a forgotten ticket makes {@link Ref} link to the tracker.
 */
export function RefLinksExtended({
  refUrls,
  children,
}: {
  refUrls: Record<string, string>;
  children: ReactNode;
}): JSX.Element {
  const parent = useRefWorld();
  // The route's URLs win: it asked the connector about these very refs.
  const world = useMemo(() => ({ ...parent, refUrls: { ...parent.refUrls, ...refUrls } }), [parent, refUrls]);
  return <RefContext.Provider value={world}>{children}</RefContext.Provider>;
}

const GOAL_REF = /^issue:(\d+)(?::|$)/;
const PR_REF = /^pr:(\d+)(?::|$)/;

/**
 * The short name of a ref — `issue:212:part:writes` reads as `#212`, `pr:412` as `PR 412`.
 * **The only place a ref becomes text**, pinned by `test/refLinks.test.ts`. A ref in no
 * recognised family is returned whole.
 */
export function refLabel(ref: string): string {
  const goal = GOAL_REF.exec(ref);
  if (goal) return `#${goal[1]}`;
  const pr = PR_REF.exec(ref);
  return pr ? `PR ${pr[1]}` : ref;
}

/**
 * One reference, as the way to the thing it names. `to` is a colon-form ref; null draws nothing, so
 * a call site with an optional origin needs no conditional. `label` overrides the short name only —
 * never where the click goes.
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

  // Narrowed off the capture group, not the match, so `number` is a `string` for the lookups below.
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
    // No page to open: the tracker is the only destination. `issue:<n>` before `#<n>` since
    // `#<n>` is shared with a pull request of the same number and `buildRefUrls` walks PRs first.
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
    // No page: the pull request has left the world, so the provider's page is the only
    // destination. `#412` is `buildRefUrls`'s key for an open PR; `pr:412` is the structured key.
    return <ExtLinkFor keys={[to, `#${prNumber}`]} label={token} title={title} world={world} />;
  }

  // A branch, a `job:` origin, anything else the provider may or may not know.
  return <>{refLink(label ?? to, world.refUrls)}</>;
}

/**
 * One reference with **both its doors**: the cockpit's page and the provider's, as one token with
 * two hit targets. **The arm is absent, not inert, when the provider resolved nothing** — the
 * opposite of {@link TicketLink}'s rule, since a second target saying "no address" is noise here.
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
      {/* The glyph is decoration; a screen reader is told what it opens instead. */}
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
 * A run of prose that mentions references. Every `#n` becomes a tracker link where resolved.
 * Deliberately **not** routed through {@link Ref}: a bare `#412` does not say whether it is a goal
 * or a pull request.
 */
export function RefText({ text }: { text: string }): ReactNode {
  return linkify(text, useRefWorld().refUrls);
}

/**
 * The way to a pull request on the provider — the `Open pull request ↗` its page carries, since a
 * `<Ref>` onto a PR the world carries opens its cockpit page instead. Inert rather than absent when
 * neither key resolves ({@link TicketLink}'s rule).
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

/** A pull request's address on the provider. `pr:<n>` first: `#<n>` is shared with an issue of the same number. */
function prUrl(refUrls: Record<string, string>, number: number): string | undefined {
  return refUrls[`pr:${number}`] ?? refUrls[`#${number}`];
}

/** A goal's ticket on the tracker. `issue:<n>` first since `buildRefUrls` walks pull requests before issues, so `#412` favours the PR when both exist. */
function issueUrl(refUrls: Record<string, string>, number: string): string | undefined {
  return refUrls[`issue:${number}`] ?? refUrls[`#${number}`];
}

/**
 * The way to a goal's ticket on the provider — the destination {@link Ref} deliberately does not
 * offer, since a `<Ref>` onto a goal the world carries opens its page instead. Three keys, most
 * trusted first: the item's own `url`, then `issue:<n>`, then `#<n>` (shared with a same-numbered PR).
 * **Inert rather than absent when nothing resolves**, never an `<a>` with no `href`.
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
