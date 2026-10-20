import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import type { EnvironmentReading, GoalLanding, WorkNode } from '../types.js';
import type { AppErrorEnvironmentView, AppErrorsPayload } from '../wire.js';
import { frameFiles } from './frames.js';
import {
  deployLandings,
  groupId,
  groupWindows,
  heldAgainstDeploy,
  landingHorizon,
  linkAnchor,
  linkGroups,
  placeFacts,
  type DeployVerdicts,
  type GroupWindow,
  type LinkFacts,
} from './link.js';

// → docs/spec/39-app-errors.md#where-it-is-computed

const LINK_DEADLINE_MS = 5_000;
const DIFF_CONCURRENCY = 4;
const CACHE_LIMIT = 20_000;
/** A commit the clone could not diff is not asked about again for this long. */
const FAILED_DIFF_TTL_MS = 10 * 60_000;
const TIMED_OUT = Symbol('timed out');
const IMMUTABLE_HEAD = /^[0-9a-f]{7,64}$/i;

interface AppErrorLinkerDeps {
  git: GitObserver;
  errors?: ErrorRecorder;
  deadlineMs?: number;
  now?: () => number;
}

interface LinkInput {
  landings: readonly GoalLanding[];
  readings: readonly EnvironmentReading[];
  nodes: readonly WorkNode[];
  now: number;
}

type Deadline = Promise<typeof TIMED_OUT>;

/**
 * Fills the `link` of a route's payload from the clone, never waiting on it past a deadline. What the
 * clone answers about a fixed commit never changes, so it is kept; what it could not answer is asked again.
 */
export class AppErrorLinker {
  private readonly reached = new Map<string, boolean>();
  private readonly asking = new Map<string, Promise<Map<string, boolean | null>>>();
  private readonly diffs = new Map<string, string[]>();
  private readonly undiffable = new Map<string, number>();
  private readonly diffing = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly deps: AppErrorLinkerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Links the payload in place; false when the deadline cut some question off, so the answer is partial. */
  async link(payload: AppErrorsPayload, input: LinkInput): Promise<boolean> {
    const deadlineMs = this.deps.deadlineMs ?? LINK_DEADLINE_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline: Deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs);
    });
    const late = `the clone did not answer within ${String(Math.round(deadlineMs / 1000))}s; it is asked again on the next read`;
    try {
      const facts: LinkFacts = {
        ...placeFacts(input),
        titles: new Map(input.nodes.map((n) => [n.ref, n.title])),
        deploys: new Map(),
        diffs: new Map(),
        now: input.now,
      };
      const deploys = await this.deployVerdicts(payload, facts, deadline, late);
      const placed = { ...facts, deploys };
      const windows = groupWindows(payload, placed);
      const diffed = await this.changedFiles(commitsToDiff(payload, windows), deadline);
      linkGroups(payload, { ...placed, diffs: diffed.diffs }, windows);
      this.evictDiffs(facts);
      return diffed.answered && [...deploys.values()].every((d) => d.unanswered === null);
    } finally {
      clearTimeout(timer);
    }
  }

  private async deployVerdicts(
    payload: AppErrorsPayload,
    facts: LinkFacts,
    deadline: Deadline,
    late: string,
  ): Promise<Map<string, DeployVerdicts>> {
    const asked = await Promise.all(
      payload.environments.map(async (view) => {
        const verdicts = await this.deployVerdict(view, facts, deadline, late);
        return verdicts === null ? null : ([view.environment, verdicts] as const);
      }),
    );
    return new Map(asked.filter((entry) => entry !== null));
  }

  private async deployVerdict(
    view: AppErrorEnvironmentView,
    facts: LinkFacts,
    deadline: Deadline,
    late: string,
  ): Promise<DeployVerdicts | null> {
    const head = view.head;
    if (head === null || head.changedAt === null || head.previousSha === null) return null;
    const held = view.groups.some((g) => {
      const anchor = linkAnchor(g, head, facts.now);
      return anchor !== null && heldAgainstDeploy(head, anchor);
    });
    if (!held) return null;
    const shas = [...new Set(deployLandings(facts.landings, head.changedAt).map((l) => l.sha))];
    const asked = await Promise.race([
      Promise.all([this.contains(shas, heads(head.sha)), this.contains(shas, heads(head.previousSha))]),
      deadline,
    ]);
    return asked === TIMED_OUT
      ? { deployed: new Map(), previous: new Map(), unanswered: late }
      : { deployed: asked[0], previous: asked[1], unanswered: null };
  }

  private async contains(shas: string[], heads: string[]): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>();
    const missing: string[] = [];
    for (const sha of shas) {
      const known = this.reached.get(reachKey(heads, sha));
      if (known === undefined) missing.push(sha);
      else out.set(sha, known);
    }
    if (missing.length === 0) return out;
    const key = `${heads.join(' ')}|${[...missing].sort().join(',')}`;
    let flight = this.asking.get(key);
    if (flight === undefined) {
      flight = this.deps.git
        .contains(missing, heads)
        .then((answers) => {
          if (heads.every((h) => IMMUTABLE_HEAD.test(h))) {
            if (this.reached.size > CACHE_LIMIT) this.reached.clear();
            for (const [sha, held] of answers) if (held !== null) this.reached.set(reachKey(heads, sha), held);
          }
          return answers;
        })
        .catch((err: unknown) => {
          this.deps.errors?.record({
            source: 'cycle',
            message: `linking app errors: the clone could not place ${String(missing.length)} landing(s)`,
            detail: (err as Error).message,
          });
          return new Map<string, boolean | null>();
        })
        .finally(() => this.asking.delete(key));
      this.asking.set(key, flight);
    }
    const answers = await flight;
    for (const sha of missing) out.set(sha, answers.get(sha) ?? null);
    return out;
  }

  private async changedFiles(
    shas: readonly string[],
    deadline: Deadline,
  ): Promise<{ diffs: Map<string, string[] | null>; answered: boolean }> {
    const now = this.now();
    const wanted = shas.filter((sha) => !this.diffs.has(sha) && (this.undiffable.get(sha) ?? 0) <= now);
    const queue = wanted.filter((sha) => !this.diffing.has(sha));
    const workers = Array.from({ length: Math.min(DIFF_CONCURRENCY, queue.length) }, async () => {
      for (let sha = queue.shift(); sha !== undefined; sha = queue.shift()) await this.diff(sha);
    });
    const flights = wanted.map((sha) => this.diffing.get(sha)).filter((f) => f !== undefined);
    const raced = await Promise.race([Promise.all([...workers, ...flights]), deadline]);
    return {
      diffs: new Map(shas.map((sha) => [sha, this.diffs.get(sha) ?? null])),
      answered: raced !== TIMED_OUT,
    };
  }

  private diff(sha: string): Promise<void> {
    const flight = this.deps.git
      .changedFiles(sha)
      .then((files) => {
        if (files === null) this.undiffable.set(sha, this.now() + FAILED_DIFF_TTL_MS);
        else this.diffs.set(sha, files);
      })
      .catch((err: unknown) => {
        this.undiffable.set(sha, this.now() + FAILED_DIFF_TTL_MS);
        this.deps.errors?.record({
          source: 'cycle',
          message: `linking app errors: the clone could not list what ${sha} changed`,
          detail: (err as Error).message,
        });
      })
      .finally(() => this.diffing.delete(sha));
    this.diffing.set(sha, flight);
    return flight;
  }

  /** Keeps what was diffed only for commits some window can still hold. */
  private evictDiffs(facts: LinkFacts): void {
    const horizon = landingHorizon(facts.now);
    const live = new Set(facts.landings.filter((l) => l.at >= horizon).map((l) => l.sha));
    for (const sha of this.diffs.keys()) if (!live.has(sha)) this.diffs.delete(sha);
    const now = this.now();
    for (const [sha, until] of this.undiffable) if (until <= now) this.undiffable.delete(sha);
  }
}

function commitsToDiff(payload: AppErrorsPayload, windows: ReadonlyMap<string, GroupWindow>): string[] {
  const out = new Set<string>();
  for (const view of payload.environments)
    for (const group of view.groups) {
      const window = windows.get(groupId(group))?.window;
      if (window?.known !== true || frameFiles(group.frames).length === 0) continue;
      for (const shas of window.goals.values()) for (const sha of shas) out.add(sha);
    }
  return [...out];
}

function heads(sha: string): string[] {
  return sha.split(' ').filter((h) => h !== '');
}

function reachKey(heads: readonly string[], sha: string): string {
  return `${heads.join(' ')}\u0000${sha}`;
}
