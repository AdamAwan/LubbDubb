import { prState } from '../prHealth.js';
import { prRef, type PrRefStyle } from '../prRef.js';
import type { PartOutcomeKind, Plan, PlanAtom, PlanPart, PullRequest } from '../types.js';

// → docs/spec/08-planning.md

export function partOrigin(issueNumber: number, slug: string): string {
  return `issue:${issueNumber}:part:${slug}`;
}

export function partBranch(issueNumber: number, slug: string): string {
  return `issue/${issueNumber}/${slug}`;
}

export function planIssueNumber(originRef: string): number | null {
  const match = /^issue:(\d+)$/.exec(originRef);
  return match ? Number(match[1]) : null;
}

export function bySlug(parts: PlanPart[]): Map<string, PlanPart> {
  return new Map(parts.map((p) => [p.slug, p]));
}

export function dependenciesOf(part: PlanPart, index: Map<string, PlanPart>): PlanPart[] {
  const deps: PlanPart[] = [];
  for (const slug of part.dependsOn) {
    const dep = index.get(slug);
    if (dep) deps.push(dep);
  }
  return deps;
}

export function partDepth(part: PlanPart, index: Map<string, PlanPart>): number {
  const depths = new Map<string, number>();
  const walking = new Set<string>();
  const depthOf = (current: PlanPart): number => {
    const cached = depths.get(current.slug);
    if (cached !== undefined) return cached;
    if (walking.has(current.slug)) return 0;
    walking.add(current.slug);
    let deepest = 0;
    for (const dep of dependenciesOf(current, index)) deepest = Math.max(deepest, depthOf(dep) + 1);
    walking.delete(current.slug);
    depths.set(current.slug, deepest);
    return deepest;
  };
  return depthOf(part);
}

export function dependencySatisfied(dep: PlanPart, pushed: (part: PlanPart) => boolean): boolean {
  if (partSettled(dep)) return true;
  if (dep.status === 'dispatched' || dep.status === 'in_review') return pushed(dep);
  return false;
}

export function partBase(
  part: PlanPart,
  index: Map<string, PlanPart>,
  issueNumber: number,
  defaultBranch: string,
): string {
  const dep = dependenciesOf(part, index).find((d) => !partSettled(d));
  if (!dep) return defaultBranch;
  return dep.branch ?? partBranch(issueNumber, dep.slug);
}

export function liveParts(parts: readonly PlanPart[]): PlanPart[] {
  return parts.filter((p) => p.status !== 'retired');
}

export function planInFlight(plan: Plan): boolean {
  return plan.status === 'active' || plan.status === 'planning' || plan.status === 'awaiting_approval';
}

export function partSettled(part: PlanPart): boolean {
  return part.status === 'merged' || part.status === 'concluded';
}

export function partIsHuman(part: PlanPart): boolean {
  return part.expectedKind === 'human';
}

export function partOutcomeKind(part: PlanPart): PartOutcomeKind | null {
  if (part.status === 'merged') return 'code';
  if (part.status === 'concluded') return part.outcomeKind;
  return null;
}

export function planProgress(parts: PlanPart[]): { settled: number; total: number } {
  const live = liveParts(parts);
  return { settled: live.filter(partSettled).length, total: live.length };
}

export function observePartPr(
  part: PlanPart,
  branch: string,
  openPrs: PullRequest[],
  closedPrs: PullRequest[],
): Partial<PlanPart> | null {
  const open = openPrs.find((p) => p.branch === branch) ?? openPrs.find((p) => p.number === part.prNumber);
  if (open) {
    return open.merged
      ? { status: 'merged', branch, prNumber: open.number }
      : { status: 'in_review', branch, prNumber: open.number };
  }

  const merged = closedPrs.find((p) => prState(p) === 'merged' && (p.branch === branch || p.number === part.prNumber));
  if (merged) return { status: 'merged', branch, prNumber: merged.number };

  if (part.prNumber !== null) {
    const abandoned = closedPrs.find((p) => p.number === part.prNumber && prState(p) === 'closed');
    if (abandoned) return { status: 'ready', branch, prNumber: null };
  }

  if (part.status === 'in_review' && part.prNumber !== null) return { status: 'merged' };
  return null;
}

export function partHasWork(part: PlanPart): boolean {
  return part.status === 'dispatched' || part.status === 'in_review' || partSettled(part);
}

export function partsToRetire(existing: PlanPart[], declared: string[]): PlanPart[] {
  const keep = new Set(declared);
  return existing.filter((p) => !keep.has(p.slug) && p.status !== 'retired' && !partHasWork(p));
}

export function currentPlanSummary(plan: Plan, parts: PlanPart[], style: PrRefStyle): string {
  const live = liveParts(parts);
  if (live.length === 0) return `The current plan is "${plan.status}" and declares no parts.`;
  const lines = live.map((p) => {
    const where =
      p.status === 'concluded'
        ? `${partOutcomeKind(p) ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'}`
        : p.prNumber !== null
          ? `PR ${prRef(p.prNumber, style)}`
          : (p.branch ?? 'no branch yet');
    const stacks = p.dependsOn.length === 0 ? '' : `, stacks on ${p.dependsOn.map((d) => `"${d}"`).join(' + ')}`;
    const expects = partIsHuman(p)
      ? ', a step for a person'
      : p.expectedKind && p.expectedKind !== 'code'
        ? `, planned as a ${p.expectedKind}`
        : '';
    const owns = p.touches.length === 0 ? '' : `\n  touches: ${p.touches.join(', ')}`;
    const size = p.size === null ? '' : `\n  size: ${p.size}`;
    const done = p.acceptance === null ? '' : `\n  done when: ${p.acceptance}`;
    return `- "${p.slug}": ${p.title} [${p.status}, ${where}${stacks}${expects}] — ${p.scope}${owns}${size}${done}`;
  });
  const why = plan.reason ? `\nIt was split because: ${plan.reason}` : '';
  return `The current plan is "${plan.status}" with ${live.length} part(s).${why}\n${lines.join('\n')}`;
}

export function siblingContext(
  parts: PlanPart[],
  current: PlanPart,
  style: PrRefStyle,
): { done: string; remaining: string } {
  const others = liveParts(parts).filter((p) => p.slug !== current.slug);
  const exists = (p: PlanPart): boolean => partSettled(p) || p.status === 'in_review';
  return {
    done: describe(others.filter(exists), 'Nothing has landed yet — this is the first part.', style),
    remaining: describe(
      others.filter((p) => !exists(p)),
      'Nothing — this is the last part.',
      style,
    ),
  };
}

function describe(parts: PlanPart[], empty: string, style: PrRefStyle): string {
  if (parts.length === 0) return empty;
  return parts
    .map((p) => {
      const where =
        p.status === 'concluded'
          ? ` (${partOutcomeKind(p) ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'})`
          : p.prNumber !== null
            ? ` (PR ${prRef(p.prNumber, style)})`
            : p.branch !== null
              ? ` (branch ${p.branch})`
              : '';
      return `- ${p.title} [${p.slug}, ${p.status}${where}] — ${p.scope}`;
    })
    .join('\n');
}

export interface AcceptanceCriterion {
  text: string;
  met: boolean;
}

export function acceptanceCriteria(part: PlanPart): AcceptanceCriterion[] {
  if (part.acceptance === null) return [];
  const met = new Set(part.acceptanceMet);
  return part.acceptance
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((text) => text !== '')
    .map((text) => ({ text, met: met.has(text) }));
}

export function partAtoms(part: PlanPart, planAtoms: readonly PlanAtom[]): PlanAtom[] {
  const carried = part.atoms;
  if (carried === undefined || carried.length === 0) return [];
  const bySlug = new Map(planAtoms.map((a) => [a.slug, a]));
  return carried.flatMap((slug) => bySlug.get(slug) ?? []);
}

export function partDeclarationNote(part: PlanPart, planAtoms: readonly PlanAtom[] = []): string {
  const atoms = partAtoms(part, planAtoms);
  const coverage = part.coverage ?? null;
  if (part.touches.length === 0 && part.acceptance === null && coverage === null && atoms.length === 0) return '';
  const lines: string[] = [];
  if (coverage !== null) {
    lines.push(
      `**The end-to-end coverage this part is for:** ${coverage}\n\nIts planner declared this part as the one ` +
        `that adds or amends the browser suite's coverage of that area. Amending an existing spec is the ` +
        `normal case rather than a conflict. If you write a new one by copying a neighbour, strip the tags ` +
        `you inherited: the critical path is an allow-list, and promoting a spec into it is a separate ` +
        `reviewed change.`,
    );
  }
  if (part.touches.length > 0) {
    lines.push(
      `**The paths this part owns**, as its planner declared them:\n${part.touches.map((p) => `- ${p}`).join('\n')}\n\n` +
        `Writing outside them is not blocked, and sometimes it is right — but it is recorded and shown to the ` +
        `operator beside this part, so if you have to, say why in your pull request.`,
    );
  }
  if (part.acceptance !== null) {
    lines.push(
      `**This part is done when:** ${part.acceptance}\n\nA reviewer is shown that as a checklist against your ` +
        `pull request, so treat it as the specification rather than as a summary of one.`,
    );
  }
  const first = atoms[0];
  if (first !== undefined) lines.push(atomCommitNote(first, atoms));
  return `\n\n---\n\n${lines.join('\n\n')}`;
}

function atomCommitNote(first: PlanAtom, atoms: readonly PlanAtom[]): string {
  const declared = atoms
    .map((atom) => {
      const paths = atom.touches.length === 0 ? '' : `\n  paths: ${atom.touches.join(', ')}`;
      const done = atom.acceptance === null ? '' : `\n  done when: ${atom.acceptance}`;
      return `- \`${atom.slug}\` — ${atom.title}\n  why: ${atom.intent}${paths}${done}`;
    })
    .join('\n');
  return (
    `**The atoms of this part**, as its planner declared them. An atom is the smallest piece of this ` +
    `change that could land, be reviewed and be rolled back on its own:\n${declared}\n\n` +
    `**Write one commit per atom, in this order.** They are the journey, not the boundary: the part ` +
    `is what gets merged, and the merge squashes them away. What they buy is a reviewer who can walk ` +
    `your change in the order you reasoned it, before they open anything else. So the series is a ` +
    `reading and nothing checks it — if the work turns out to need a different shape, write the ` +
    `commits the work actually has and say so in your pull request rather than bending it back.\n\n` +
    `The message is already written for you: the subject is the atom's slug and title, and the body ` +
    `is its intent.\n\n` +
    '```\n' +
    `${first.slug}: ${first.title}\n\n${first.intent}\n` +
    '```'
  );
}

export function partOutcomeNote(part: PlanPart): string {
  if (!part.expectedKind || part.expectedKind === 'code' || partIsHuman(part)) return '';
  const what =
    part.expectedKind === 'report'
      ? 'a write-up, a measurement or a document — not a change to the code'
      : 'a determination: whether anything needs doing here at all, and the evidence for it';
  return (
    `\n\n---\n\nThis part was planned to produce ${what}. So it may well end with no pull request, and ` +
    `that is success rather than failure. When you have finished, call **conclude_part** with kind ` +
    `"${part.expectedKind}" and a summary of what you found. That is the only thing that closes a part ` +
    `with no pull request behind it — until you do, this plan and its issue stay open. If the work turns ` +
    `out to need code after all, ignore this and open a pull request as normal.`
  );
}
