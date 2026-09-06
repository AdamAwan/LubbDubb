import type { Issue, IssueAppraisal } from '../types.js';
import { isOrphanIssue } from '../issueRelations.js';

// → docs/spec/06-issue-pickup.md

export type PlacementField = 'parent' | 'areaPath';

export interface AreaPathTree {
  root: string;
  paths: string[];
}

const AREA_PATH_LIMIT = 40;

export function truncateAreaPaths(tree: AreaPathTree): { paths: string[]; omitted: number } {
  const paths = tree.paths.slice(0, AREA_PATH_LIMIT);
  return { paths, omitted: Math.max(0, tree.paths.length - paths.length) };
}

function isAreaPathMissing(issue: Issue, tree: AreaPathTree | null): boolean {
  if (issue.areaPath === undefined || tree === null) return false;
  return normalizeAreaPath(issue.areaPath) === normalizeAreaPath(tree.root);
}

export function normalizeAreaPath(path: string): string {
  return path
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/^\\|\\$/g, '')
    .trim()
    .toLowerCase();
}

export interface PlacementAsk {
  field: PlacementField;
  proposedParent: number | null;
  proposedAreaPath: string | null;
}

export function placementAsks(
  appraisal: IssueAppraisal | null,
  issue: Issue,
  tree: AreaPathTree | null,
  goalRef: string,
  types: PlacementTypePolicy = {},
): PlacementAsk[] {
  const current = appraisal !== null && appraisal.goalRef === goalRef ? appraisal : null;
  const asks: PlacementAsk[] = [];
  if (isOrphanIssue(issue, types.containerTypes, types.parentedTypes) && current?.parentSettledAt == null)
    asks.push({ field: 'parent', proposedParent: current?.proposedParent ?? null, proposedAreaPath: null });
  if (
    current !== null &&
    current.proposedAreaPath !== null &&
    current.areaPathSettledAt === null &&
    isAreaPathMissing(issue, tree)
  )
    asks.push({ field: 'areaPath', proposedParent: null, proposedAreaPath: current.proposedAreaPath });
  return asks;
}

export interface PlacementTypePolicy {
  containerTypes?: readonly string[];
  parentedTypes?: readonly string[];
}
