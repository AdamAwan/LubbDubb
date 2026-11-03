import type { GhPullDetail } from './githubApi.js';

// → docs/spec/15-integrations.md

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ResolvePullOpts {
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function resolvePullDetail(
  fetchDetail: () => Promise<GhPullDetail>,
  opts: ResolvePullOpts = {},
): Promise<GhPullDetail> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? realSleep;
  let detail = await fetchDetail();
  for (let i = 0; i < retries && detail.mergeable === null && !detail.merged; i++) {
    await sleep(delayMs);
    detail = await fetchDetail();
  }
  return detail;
}
