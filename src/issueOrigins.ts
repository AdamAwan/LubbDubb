// → docs/spec/05-dispatcher.md#the-issue-origin-vocabulary

type IssueOriginRole = 'work' | 'evidence' | 'deliberation' | 'unrecognised';

type IssueOriginFamily =
  | 'root'
  | 'plan'
  | 'appraisal'
  | 'sequence'
  | 'split'
  | 'summary'
  | 'shortfall'
  | 'part'
  | 'assess'
  | 'retro'
  | 'validationPlan'
  | 'validate'
  | 'validateFailure'
  | 'localValidation'
  | 'localValidationFix'
  | 'remoteValidation';

interface IssueOriginDeclaration {
  readonly suffix: string;
  readonly id: string | null;
  readonly role: IssueOriginRole;
}

const FAMILIES = {
  root: { suffix: '', id: null, role: 'work' },
  part: { suffix: 'part', id: '[^:]+', role: 'work' },
  localValidationFix: { suffix: 'validate-local-fix', id: '[A-Za-z0-9-]+', role: 'work' },
  assess: { suffix: 'assess', id: null, role: 'evidence' },
  retro: { suffix: 'retro', id: null, role: 'evidence' },
  // `validate-plan` carries no id: there is one check set per goal and it is written once, so this is
  // `assess` and `retro`'s shape rather than `validate:<check>`'s.
  validationPlan: { suffix: 'validate-plan', id: null, role: 'evidence' },
  validate: { suffix: 'validate', id: '.+', role: 'evidence' },
  validateFailure: { suffix: 'validate-failure', id: '.+', role: 'evidence' },
  localValidation: { suffix: 'validate-local', id: '[A-Za-z0-9-]+', role: 'evidence' },
  remoteValidation: { suffix: 'validate-remote', id: '[A-Za-z0-9-]+', role: 'evidence' },
  plan: { suffix: 'plan', id: null, role: 'deliberation' },
  appraisal: { suffix: 'appraisal', id: null, role: 'deliberation' },
  sequence: { suffix: 'sequence', id: null, role: 'deliberation' },
  split: { suffix: 'split', id: '\\d+', role: 'deliberation' },
  summary: { suffix: 'summary', id: null, role: 'unrecognised' },
  shortfall: { suffix: 'shortfall', id: null, role: 'unrecognised' },
} as const satisfies Record<IssueOriginFamily, IssueOriginDeclaration>;

type PlainFamily = {
  [K in IssueOriginFamily]: (typeof FAMILIES)[K]['id'] extends null ? K : never;
}[IssueOriginFamily];

type IdFamily = Exclude<IssueOriginFamily, PlainFamily>;

const SUFFIXED: readonly {
  readonly family: IssueOriginFamily;
  readonly decl: IssueOriginDeclaration;
  readonly match: RegExp | null;
}[] = (Object.entries(FAMILIES) as [IssueOriginFamily, IssueOriginDeclaration][])
  .filter(([, decl]) => decl.suffix !== '')
  .map(([family, decl]) => ({
    family,
    decl,
    match: decl.id === null ? null : new RegExp(`^${decl.suffix}:(${decl.id})$`),
  }));

/** Every declared family, for the test that holds the vocabulary to its asserted strings. */
export const issueOriginFamilies = Object.keys(FAMILIES) as readonly IssueOriginFamily[];

export function issueOriginRef(family: PlainFamily, issueNumber: number): string;
export function issueOriginRef(family: IdFamily, issueNumber: number, id: string | number): string;
export function issueOriginRef(family: IssueOriginFamily, issueNumber: number, id?: string | number): string {
  const { suffix } = FAMILIES[family];
  const head = `issue:${issueNumber}`;
  if (suffix === '') return head;
  return id === undefined ? `${head}:${suffix}` : `${head}:${suffix}:${id}`;
}

interface ParsedIssueOrigin {
  issueNumber: number;
  family: IssueOriginFamily;
  id: string | null;
}

export function parseIssueOrigin(originRef: string | null): ParsedIssueOrigin | null {
  const head = /^issue:(\d+)(?::(.+))?$/.exec(originRef ?? '');
  if (head === null) return null;
  const issueNumber = Number(head[1]);
  const suffix = head[2];
  if (suffix === undefined) return { issueNumber, family: 'root', id: null };
  for (const { family, decl, match } of SUFFIXED) {
    if (match === null) {
      if (suffix === decl.suffix) return { issueNumber, family, id: null };
      continue;
    }
    const hit = match.exec(suffix);
    if (hit !== null) return { issueNumber, family, id: hit[1] as string };
  }
  return null;
}

/** The id an origin of this family carries, or null when it is an origin of some other family. */
export function issueOriginId(family: IdFamily, originRef: string | null): { issueNumber: number; id: string } | null {
  const parsed = parseIssueOrigin(originRef);
  if (parsed === null || parsed.family !== family || parsed.id === null) return null;
  return { issueNumber: parsed.issueNumber, id: parsed.id };
}

/** The issue number of an origin of exactly this family, or null. */
export function issueOriginNumber(family: PlainFamily, originRef: string | null): number | null {
  const parsed = parseIssueOrigin(originRef);
  return parsed !== null && parsed.family === family ? parsed.issueNumber : null;
}

/**
 * Whether an origin is under this family at all, judged on the suffix and never on the id — the
 * leniency `issueOriginRole` reads with, for the call sites that only ask which family they are in.
 */
export function inIssueOriginFamily(family: IdFamily, originRef: string | null): boolean {
  const head = /^issue:\d+:(.+)$/.exec(originRef ?? '');
  return head !== null && head[1]!.startsWith(`${FAMILIES[family].suffix}:`);
}

/**
 * The issue number and the raw suffix of an origin under an issue, whatever that suffix means — for
 * the callers that refuse on a *named* suffix and let every other one through.
 */
export function issueOriginHead(originRef: string | null): { issueNumber: number; suffix: string | null } | null {
  const match = /^issue:(\d+)(?::(.+))?$/.exec(originRef ?? '');
  return match === null ? null : { issueNumber: Number(match[1]), suffix: match[2] ?? null };
}

/** The issue number of any origin in the `issue:<n>` subtree, whatever its suffix. */
export function issueSubtreeNumber(originRef: string | null): number | null {
  const match = /^issue:(\d+)(?::|$)/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

export function issueOriginRole(issueNumber: number, originRef: string | null): IssueOriginRole | null {
  const root = issueOriginRef('root', issueNumber);
  if (originRef === root) return 'work';
  const prefix = `${root}:`;
  if (originRef === null || !originRef.startsWith(prefix)) return null;

  const suffix = originRef.slice(prefix.length);
  for (const { decl } of SUFFIXED) {
    const hit = decl.id === null ? suffix === decl.suffix : suffix.startsWith(`${decl.suffix}:`);
    if (hit) return decl.role;
  }
  return 'unrecognised';
}

export function obstacleOriginId(originRef: string | null): string | null {
  const match = /^obstacle:([A-Za-z0-9_-]+)$/.exec(originRef ?? '');
  return match ? match[1]! : null;
}
