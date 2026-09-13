import { basePrOf, newlyFailingChecks, recoveredOnSameCommit } from '../pr/prHealth.js';
import type { CiCheck, PullRequest, WorldSnapshot } from '../types.js';

// → docs/spec/27-obstacles.md

interface HarnessSighting {
  transition: string;
  checkName: string;
  what: string;
  words: string;
}

export function harnessSightings(prev: WorldSnapshot | null, next: WorldSnapshot): HarnessSighting[] {
  if (!prev) return [];
  const before = new Map(prev.pullRequests.map((pr) => [pr.id, pr]));
  const seen = new Set<string>();
  const out: HarnessSighting[] = [];
  const push = (sighting: HarnessSighting): void => {
    if (seen.has(sighting.transition)) return;
    seen.add(sighting.transition);
    out.push(sighting);
  };
  for (const pr of next.pullRequests) {
    for (const check of recoveredOnSameCommit(before.get(pr.id), pr)) push(flakeSighting(pr, check));
    const base = basePrOf(pr, next.pullRequests);
    if (base) for (const check of newlyFailingChecks(before.get(base.id), base)) push(baseRedSighting(pr, base, check));
  }
  return out;
}

function flakeSighting(pr: PullRequest, check: CiCheck): HarnessSighting {
  return {
    transition: `flake:${check.name}@${pr.headSha ?? ''}`,
    checkName: check.name,
    what:
      `The check \`${check.name}\` has reported failing and then passing again on the same commit, ` +
      `with nothing pushed in between.`,
    words:
      `The harness read \`${check.name}\` as failing on commit ${shortSha(pr.headSha)} of pr:${pr.number}, ` +
      `and as passing on that same commit at the next pulse. The pull request's head commit was ` +
      `unchanged between the two readings, so nothing was pushed between them.`,
  };
}

function baseRedSighting(rung: PullRequest, base: PullRequest, check: CiCheck): HarnessSighting {
  return {
    transition: `base-red:${check.name}@${base.branch}`,
    checkName: check.name,
    what:
      `The check \`${check.name}\` is failing on branch \`${base.branch}\`, which one or more open ` +
      `pull requests are based on.`,
    words:
      `The harness read \`${check.name}\` as failing on pr:${base.number}, whose branch \`${base.branch}\` ` +
      `is the base of pr:${rung.number}. It was not failing there on the previous pulse.`,
  };
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : 'an unreported commit';
}
