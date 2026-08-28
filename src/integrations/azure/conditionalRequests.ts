/**
 * Conditional GETs for the Azure DevOps client — and an honest account of how
 * little of the surface they cover.
 *
 * The GitHub client's `etagCache.ts` makes an unchanged read genuinely free:
 * GitHub sends an `ETag` on essentially every resource, honours `If-None-Match`
 * with a `304`, and does not charge a `304` against the rate limit. Azure DevOps
 * is not that server. It documents conditional requests on a **narrow slice** of
 * its REST API — the Git **items** and blob reads are the well-known case — and
 * documents nothing of the kind for the endpoints this harness's world read
 * actually spends its budget on:
 *
 * - `_apis/git/repositories/{repo}/pullrequests` (the active/closed lists)
 * - `_apis/git/repositories/{repo}/pullRequests/{id}/threads`
 * - `_apis/policy/evaluations` (the branch-policy evaluations for a PR)
 * - `_apis/git/repositories/{repo}/pullRequests/{id}/labels`
 * - `_apis/wit/wiql`, `_apis/wit/workitems`, `_apis/wit/workItems/{id}/updates`
 *
 * None of those is *documented* to answer `304`, and behaviour varies by
 * organization and API version, so a hard-coded list of "endpoints that support
 * it" would be a claim this file cannot keep. It is therefore written to make no
 * claim at all: a validator is only ever sent for a URL **the server itself
 * ETagged on the previous response**. An endpoint that sends no `ETag` is never
 * asked a conditional question, costs exactly what it costs today, and this
 * layer is a no-op for it — which is the whole point, because a cache that
 * silently covers nothing while looking like it covers everything is worse than
 * no cache.
 *
 * Concretely: expect this to save little or nothing on the world read as Azure
 * ships today. The saving on that path comes from `hydrationCache.ts`, which
 * does not need the server's cooperation. This layer is here so that the parts
 * of Azure which *do* validate (today: the Git item reads; tomorrow: whatever
 * Microsoft adds) are picked up automatically rather than needing a code change,
 * and so a deployment behind a caching proxy that adds validators benefits too.
 *
 * Correctness comes from the server, exactly as it does on the GitHub side.
 * There is no TTL and nothing to invalidate: a label the harness writes changes
 * the resource, so its validator changes, so the next GET is a `200` with the
 * new body. An entry can only ever be served when the server has just said it is
 * still current.
 */

/** The most responses held at once — a memory guard, nothing more. */
const MAX_ENTRIES = 256;

/**
 * The largest body worth holding, in bytes. A PR's threads on a long-running
 * review is the big one; past this the memory is worth more than the request.
 */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Bounded, insertion-ordered validator store, keyed by absolute request URL.
 *
 * The **text** of the response is kept rather than its parsed form, so a replay
 * hands each caller its own object graph: the mappers downstream are pure, but
 * an aliased response that one of them ever mutated would be a bug visible only
 * on the second pulse.
 */
export class AzureEtagCache {
  private readonly entries = new Map<string, { etag: string; body: string }>();

  constructor(private readonly max = MAX_ENTRIES) {}

  get(url: string): { etag: string; body: string } | undefined {
    const hit = this.entries.get(url);
    // Re-insert so eviction drops the least recently *used*: a snapshot writes
    // every per-entity read in one burst, so write order says nothing about
    // which is still wanted.
    if (hit) {
      this.entries.delete(url);
      this.entries.set(url, hit);
    }
    return hit;
  }

  set(url: string, etag: string, body: string): void {
    if (body.length > MAX_BODY_BYTES) return;
    this.entries.delete(url);
    this.entries.set(url, { etag, body });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
