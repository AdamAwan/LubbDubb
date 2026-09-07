import type { PlanAtom, PlanPartView } from '../types.js';

// → docs/spec/17-cockpit.md#regrouping-the-atoms

export interface RegroupPart {
  slug: string;
  title: string;
  scope: string;
  atoms: string[];
  added: boolean;
}

interface RegroupCycle {
  atom: string;
  dep: string;
  from: string;
  to: string;
  sentence: string;
}

export function initialGrouping(parts: PlanPartView[], atoms: PlanAtom[]): RegroupPart[] {
  const declared = new Set(atoms.map((a) => a.slug));
  return parts.map((part) => ({
    slug: part.slug,
    title: part.title,
    scope: part.scope,
    atoms: (part.atoms ?? []).filter((slug) => declared.has(slug)),
    added: false,
  }));
}

export function moveAtom(groups: RegroupPart[], atom: string, to: string): RegroupPart[] {
  if (!groups.some((g) => g.slug === to)) return groups;
  return groups.map((group) => ({
    ...group,
    atoms: group.slug === to ? [...group.atoms.filter((a) => a !== atom), atom] : group.atoms.filter((a) => a !== atom),
  }));
}

export function addPart(groups: RegroupPart[], part: { slug: string; title: string; scope: string }): RegroupPart[] {
  if (groups.some((g) => g.slug === part.slug)) return groups;
  return [...groups, { ...part, atoms: [], added: true }];
}

export function dropPart(groups: RegroupPart[], slug: string): RegroupPart[] {
  const going = groups.find((g) => g.slug === slug);
  if (going === undefined || going.atoms.length > 0 || groups.length < 2) return groups;
  return groups.filter((g) => g.slug !== slug);
}

export function unchangedFrom(before: RegroupPart[], after: RegroupPart[]): boolean {
  const key = (groups: RegroupPart[]): string =>
    groups.map((g) => `${g.slug}:${[...g.atoms].sort((a, b) => a.localeCompare(b)).join(',')}`).join('|');
  return key(before) === key(after);
}

export function regroupCycle(atoms: PlanAtom[], groups: RegroupPart[]): RegroupCycle | null {
  const partOf = new Map<string, string>();
  for (const group of groups) for (const slug of group.atoms) partOf.set(slug, group.slug);

  const edges = new Map<string, { to: string; atom: string; dep: string }[]>();
  for (const atom of atoms) {
    const from = partOf.get(atom.slug);
    if (from === undefined) continue;
    for (const dep of atom.dependsOn) {
      const to = partOf.get(dep);
      if (to === undefined || to === from) continue;
      edges.set(from, [...(edges.get(from) ?? []), { to, atom: atom.slug, dep }]);
    }
  }

  const settled = new Set<string>();
  const onPath = new Set<string>();
  const walk = (part: string): RegroupCycle | null => {
    if (settled.has(part)) return null;
    onPath.add(part);
    for (const edge of edges.get(part) ?? []) {
      if (onPath.has(edge.to)) return describeCycle({ atom: edge.atom, dep: edge.dep, from: part, to: edge.to });
      const found = walk(edge.to);
      if (found) return found;
    }
    onPath.delete(part);
    settled.add(part);
    return null;
  };
  for (const start of edges.keys()) {
    const found = walk(start);
    if (found) return found;
  }
  return null;
}

function describeCycle(cycle: Omit<RegroupCycle, 'sentence'>): RegroupCycle {
  return {
    ...cycle,
    sentence:
      `“${cycle.atom}” is in “${cycle.from}” and waits on “${cycle.dep}”, which is in “${cycle.to}” — and ` +
      `“${cycle.to}” already waits on “${cycle.from}”. The two parts would wait on each other forever: neither ` +
      `is ever dispatched, and nothing anywhere goes red. Move “${cycle.atom}” into “${cycle.to}”, or ` +
      `“${cycle.dep}” into “${cycle.from}”.`,
  };
}

export function groupingCost(groups: RegroupPart[]): string[] {
  const n = groups.length;
  const lines = [
    `${n} part${n === 1 ? '' : 's'}: ${n} branch${n === 1 ? '' : 'es'}, ${n} pull request${n === 1 ? '' : 's'}, ` +
      `${n} review round${n === 1 ? '' : 's'} and ${n} merge${n === 1 ? '' : 's'}.`,
  ];
  const alone = groups.filter((g) => g.atoms.length === 1).map((g) => `“${g.slug}”`);
  if (alone.length > 0)
    lines.push(
      `${alone.join(', ')} carr${alone.length === 1 ? 'ies' : 'y'} one atom on its own — a whole review round and ` +
        'a whole merge for one piece. Sometimes that is exactly right, and often it is not.',
    );
  const empty = groups.filter((g) => g.atoms.length === 0).map((g) => `“${g.slug}”`);
  if (empty.length > 0)
    lines.push(
      `${empty.join(', ')} carr${empty.length === 1 ? 'ies' : 'y'} no atom at all — an agent, a branch and a pull ` +
        'request for work this plan does not name.',
    );
  return lines;
}
