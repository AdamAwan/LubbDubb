import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react';
import { ExtLink, linkify, refLink } from './util.js';

// → docs/spec/17-cockpit.md

interface RefWorld {
  refUrls: Record<string, string>;
  openGoal: (ref: string) => void;
  hasGoal: (ref: string) => boolean;
  openPr: (prNumber: number) => void;
  hasPr: (prNumber: number) => boolean;
}

const RefContext = createContext<RefWorld | null>(null);

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

export function RefLinksExtended({
  refUrls,
  children,
}: {
  refUrls: Record<string, string>;
  children: ReactNode;
}): JSX.Element {
  const parent = useRefWorld();
  const world = useMemo(() => ({ ...parent, refUrls: { ...parent.refUrls, ...refUrls } }), [parent, refUrls]);
  return <RefContext.Provider value={world}>{children}</RefContext.Provider>;
}

const GOAL_REF = /^issue:(\d+)(?::|$)/;
const PR_REF = /^pr:(\d+)(?::|$)/;

export function refLabel(ref: string): string {
  const goal = GOAL_REF.exec(ref);
  if (goal) return `#${goal[1]}`;
  const pr = PR_REF.exec(ref);
  return pr ? `PR ${pr[1]}` : ref;
}

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
    return <ExtLinkFor keys={[to, `#${prNumber}`]} label={token} title={title} world={world} />;
  }

  return <>{refLink(label ?? to, world.refUrls)}</>;
}

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

export function RefText({ text }: { text: string }): ReactNode {
  return linkify(text, useRefWorld().refUrls);
}

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

function prUrl(refUrls: Record<string, string>, number: number): string | undefined {
  return refUrls[`pr:${number}`] ?? refUrls[`#${number}`];
}

function issueUrl(refUrls: Record<string, string>, number: string): string | undefined {
  return refUrls[`issue:${number}`] ?? refUrls[`#${number}`];
}

export function TicketLink({
  number,
  url,
  className,
  children,
}: {
  number: number;
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
