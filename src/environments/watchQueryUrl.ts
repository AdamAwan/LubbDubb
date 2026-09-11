import { gzipSync } from 'node:zlib';

// → docs/spec/29-post-deploy-watch.md

/**
 * The two substitutions a `watch.queryUrl` template may carry. Declared here
 * rather than in `policy.ts` so the refusal and the substitution cannot come to
 * disagree about which tokens exist.
 *
 * @public named by `validateWatchQueryUrl`, which refuses a template carrying neither
 */
export const QUERY_URL_TOKENS = ['{query}', '{queryGzip}'] as const;

/**
 * Where an operator goes to run a declared query themselves, or **null where the
 * environment named no template** — which is every deployment until one does, and
 * draws no link rather than a dead one.
 *
 * @public read by the finding's detail and by the window view the cockpit draws
 */
export function watchQueryUrl(template: string | undefined, query: string): string | null {
  if (template === undefined || template.trim() === '') return null;
  return template
    .replaceAll('{queryGzip}', encodeURIComponent(gzipSync(Buffer.from(query, 'utf8')).toString('base64')))
    .replaceAll('{query}', encodeURIComponent(query));
}
