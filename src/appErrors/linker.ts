import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import type { EnvironmentReading, GoalLanding, WorkNode } from '../types.js';
import type { AppErrorsPayload } from '../wire.js';
import { frameFiles } from './frames.js';
import {
  deployLandings,
  groupId,
  heldAgainstDeploy,
  linkAnchor,
  linkGroups,
  linkWindows,
  type DeployVerdicts,
  type LinkFacts,
} from './link.js';

// → docs/spec/39-app-errors.md#where-it-is-computed

const LINK_DEADLINE_MS = 5_000;
const DIFF_CONCURRENCY = 4;
const CACHE_LIMIT = 20_000;
const TIMED_OUT = Symbol('timed out');
const IMMUTABLE_HEAD = /^[0-9a-f]{7,64}$/i;

interface AppErrorLinkerDeps {
  git: GitObserver;
  errors?: ErrorRecorder;
  deadlineMs?: number;
}

interface LinkInput {
  landings: readonly GoalLanding[];
  readings: readonly EnvironmentReading[];
  nodes: readonly WorkNode[];
  now: number;
}

/**
 * Fills the `link` of a route's payload from the clone, never waiting on it past a deadline. What the
 * clone answers about a fixed commit never changes, so it is kept; what it could not answer is asked again.
 */
export class AppErrorLinker {
  private readonly reached = new Map<string, boolean>();
  private readonly asking = new Map<string, Promise<Map<string, boolean | null>>>();
  private readonly diffs = new Map<string, string[]>();
  private readonly diffing = new Map<string, Promise<void>>();

  constructor(private readonly deps: AppErrorLinkerDeps) {}

  async link(payload: AppErrorsPayload, input: LinkInput): Promise<void> {
    const deadlineMs = this.deps.deadlineMs ?? LINK_DEADLINE_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs);
    });
    const late = `the clone did not answer within ${String(Math.round(deadlineMs / 1000))}s; it is asked again on the next read`;
    try {
      const facts: LinkFacts = {
        landings: input.landings,
        readings: input.readings,
        titles: new Map(input.nodes.map((n) => [n.ref, n.title])),
        deploys: new Map(),
        diffs: new Map(),
        now: input.now,
      };
      const deploys = await this.deployVerdicts(payload, facts, deadline, late);
      const placed = { ...facts, deploys };
      const diffs = await this.changedFiles(commitsToDiff(payload, placed), deadline);
      linkGroups(payload, { ...placed, diffs });
    } finally {
      clearTimeout(timer);
    }
  }

  private async deployVerdicts(
    payload: AppErrorsPayload,
    facts: LinkFacts,
    deadline: Promise<typeof TIMED_OUT>,
    late: string,
  ): Promise<Map<string, DeployVerdicts>> {
    const out = new Map<string, DeployVerdicts>();
    for (const view of payload.environments) {
      const reading = view.reading;
      if (reading === null || reading.deployedAt === null || reading.deployedSha === null) continue;
      if (reading.previousSha === null) continue;
      const held = view.groups.some((g) => {
        const anchor = linkAnchor(g, reading, facts.now);
        return anchor !== null && heldAgainstDeploy(reading, anchor);
      });
      if (!held) continue;
      const shas = [...new Set(deployLandings(facts.landings, reading.deployedAt).map((l) => l.sha))];
      const asked = await Promise.race([
        Promise.all([this.contains(shas, heads(reading.deployedSha)), this.contains(shas, heads(reading.previousSha))]),
        deadline,
      ]);
      out.set(
        view.environment,
        asked === TIMED_OUT
          ? { deployed: new Map(), previous: new Map(), unanswered: late }
          : { deployed: asked[0], previous: asked[1], unanswered: null },
      );
    }
    return out;
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
    deadline: Promise<typeof TIMED_OUT>,
  ): Promise<Map<string, string[] | null>> {
    const wanted = shas.filter((sha) => !this.diffs.has(sha));
    const queue = wanted.filter((sha) => !this.diffing.has(sha));
    const workers = Array.from({ length: Math.min(DIFF_CONCURRENCY, queue.length) }, async () => {
      for (let sha = queue.shift(); sha !== undefined; sha = queue.shift()) await this.diff(sha);
    });
    const flights = wanted.map((sha) => this.diffing.get(sha)).filter((f) => f !== undefined);
    await Promise.race([Promise.all([...workers, ...flights]), deadline]);
    return new Map(shas.map((sha) => [sha, this.diffs.get(sha) ?? null]));
  }

  private diff(sha: string): Promise<void> {
    const flight = this.deps.git
      .changedFiles(sha)
      .then((files) => {
        if (files === null) return;
        if (this.diffs.size > CACHE_LIMIT) this.diffs.clear();
        this.diffs.set(sha, files);
      })
      .catch((err: unknown) => {
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
}

function commitsToDiff(payload: AppErrorsPayload, facts: LinkFacts): string[] {
  const windows = linkWindows(payload, facts);
  const out = new Set<string>();
  for (const view of payload.environments)
    for (const group of view.groups) {
      const window = windows.get(groupId(group));
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
