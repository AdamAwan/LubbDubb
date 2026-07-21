# Real GitHub Connectors — Design

**Date:** 2026-07-21
**Status:** Approved (pending spec review)

## Problem

Today every "GitHub" capability in LubbDubb is a fake. `FakeGitHubIntegration`
(`sourceControl`) and `FakeIssuesIntegration` (`issues`) read from an in-memory,
SQLite-persisted "world document" and only change when events are manually
`inject()`-ed. There is no network code anywhere in the repo — no HTTP client, no
GitHub token, no owner/repo config. The modular "capability seam" was built so a
real provider drops in behind the existing interfaces; this work implements that
real provider for both `sourceControl` and `issues`.

## Goals

- Real `github` providers for **both** `sourceControl` (PRs + PR-monitoring) and
  `issues`, selectable via `integrations.sourceControl: "github"` /
  `integrations.issues: "github"`.
- **Full fidelity**: reproduce every field the fakes produce (CI status,
  approvals, mergeability, unresolved comments; issue state + linked PR).
- Zero changes downstream of the seam (`CompositeConnector`, `system.ts`,
  `Harness`, `ActionExecutor` stay untouched — that is the point of the seam).
- Fakes remain the **default** provider so the entire existing test suite is
  unaffected and runs without network.

## Non-goals

- Replacing the `backlog` or `calendar` fakes (out of scope).
- Webhooks / push delivery. Reads are poll-based off the existing heartbeat.
- Conditional-request/ETag caching or the octokit throttling plugin (can be a
  later optimization; v1 relies on the gentle default 5-min heartbeat).

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| HTTP layer | `@octokit/rest` (official SDK), used **REST-only** |
| Repo target + auth | `GITHUB_TOKEN` env var for the token; `owner`/`repo` in config |
| Capabilities | Both `sourceControl` and `issues`, full fidelity |
| Scope | Optional `prAuthor` / `issueLabel` filters; unset = all open |

## Architecture

### Client seam: `GitHubApi`

A narrow interface (`src/integrations/github/githubApi.ts`) exposing **only** the
operations the two integrations need — not the whole GitHub surface. This is the
network boundary and the test seam.

```ts
export interface GitHubApi {
  /** Authenticated bot login, used to decide whether a comment thread is "handled". */
  viewerLogin(): Promise<string>;

  listOpenPulls(): Promise<GhPullSummary[]>;        // GET /repos/{o}/{r}/pulls?state=open
  getPull(number: number): Promise<GhPullDetail>;   // GET /pulls/{n} (mergeable, merged, head.sha)
  listPullReviews(number: number): Promise<GhReview[]>;      // GET /pulls/{n}/reviews
  listPullReviewComments(number: number): Promise<GhReviewComment[]>; // GET /pulls/{n}/comments
  getCombinedStatus(sha: string): Promise<GhCombinedStatus>; // GET /commits/{sha}/status
  listCheckRuns(sha: string): Promise<GhCheckRun[]>;         // GET /commits/{sha}/check-runs

  listOpenIssues(label?: string): Promise<GhIssue[]>;        // GET /issues?state=open&labels=
  listIssueTimeline(number: number): Promise<GhTimelineEvent[]>; // GET /issues/{n}/timeline

  createPullReviewReply(number: number, inReplyTo: number, body: string): Promise<GhCommentRef>;
  createIssueComment(number: number, body: string): Promise<GhCommentRef>;
  mergePull(number: number, method: MergeMethod): Promise<GhMergeResult>;
}
```

- **Real impl** `OctokitGitHubApi` wraps one `Octokit` instance
  (`new Octokit({ auth: token })`) and binds `owner`/`repo`. It uses
  `octokit.paginate` where lists can exceed one page.
- **Fake impl** `FakeGitHubApi` (test helper) returns scripted payloads with no
  network. All unit tests inject this — consistent with the repo's existing
  `FakePtyBackend` / `streamSpawner` fakes.

The `Gh*` payload types are minimal structural types describing only the fields we
read (avoids leaking octokit's enormous generated types across the codebase and
keeps `web/` unaffected). No `as unknown` casts.

### `GitHubSourceControlIntegration`

`implements Integration, PrReplyCapable, PrMergeCapable` — **not** `Injectable`.

`snapshot()` → `{ pullRequests }`:
1. `listOpenPulls()`, then apply the optional `prAuthor` filter client-side.
2. For each PR (in parallel): `getPull` (mergeable/merged/head.sha), reviews,
   review comments, combined status + check-runs.
3. Map to `PullRequest`:
   - `ciStatus`: aggregate check-runs (`conclusion`) and combined status
     (`state`). Any failure/cancelled/timed_out → `failing`; else any
     pending/queued/in_progress → `pending`; else if ≥1 signal and all
     success → `passing`; else `unknown`.
   - `unresolvedComments`: group review comments into threads by
     `in_reply_to_id` (root id = the comment's own id when it has no parent).
     Surface one `PrComment` per thread using the **root** comment's id/author/
     body; `handled = latest comment in the thread was authored by the viewer
     login`. (After `postPrReply`, the next poll sees the bot as latest author →
     `handled: true` → the deterministic loop settles, exactly like the fake's
     `markCommentHandled`.)
   - `approved`: fold reviews to the latest state per reviewer; `true` iff ≥1
     `APPROVED` and zero `CHANGES_REQUESTED` outstanding.
   - `mergeable`: PR `mergeable` boolean; `null` → leave `undefined` (unknown).
   - `merged`: PR `merged` boolean.
   - `url`: `html_url`.

`postPrReply(input)`:
- `commentId` present → `createPullReviewReply(prNumber, Number(commentId), body)`
  (threaded reply under the review comment).
- `commentId` null → `createIssueComment(prNumber, body)` (top-level PR comment).
- Returns `{ ok: true, ref: html_url }`.

`mergePr(input)` → `mergePull(prNumber, method)`; returns `{ ok: true, ref: sha }`.

### `GitHubIssuesIntegration`

`implements Integration` (reads only).

`snapshot()` → `{ issues }`:
1. `listOpenIssues(issueLabel)` (native `labels` query param when the filter is set).
2. **Drop entries with a `pull_request` field** — the Issues API returns PRs as
   issues; we only want real issues.
3. Map `state`/`labels`/`title`/`body`/`url`.
4. `linkedPrNumber`: from `listIssueTimeline`, take the most recent
   `cross-referenced`/`connected` event whose source is a PR in this repo; `null`
   if none.

### Registry & config wiring

`src/integrations/registry.ts` — add a `github` factory under `sourceControl`
and `issues`:

```ts
sourceControl: {
  fake: (ctx, world) => new FakeGitHubIntegration(world, ctx.store),
  github: (ctx) => buildGitHubSourceControl(ctx),
},
issues: {
  fake: (_ctx, world) => new FakeIssuesIntegration(world),
  github: (ctx) => buildGitHubIssues(ctx),
},
```

`buildGitHub*` helpers:
- Read `GITHUB_TOKEN` from `process.env`. Missing → throw a clear error naming
  the env var.
- Read `ctx.config.github` (`owner`/`repo`/`filters`). Missing owner/repo → throw
  a clear error.
- Construct `OctokitGitHubApi` and the integration. A shared client per
  `buildIntegrations` call is fine (both integrations can share one `Octokit`);
  build it lazily and reuse.

`src/config.ts` — extend `Config`:

```ts
/** GitHub target + optional scope filters. Required when a capability uses the
 *  `github` provider. The token is NOT here — it comes from GITHUB_TOKEN. */
github?: {
  owner: string;
  repo: string;
  filters?: {
    /** Only surface PRs opened by this login. Unset = all open PRs. */
    prAuthor?: string;
    /** Only surface issues carrying this label. Unset = all open issues. */
    issueLabel?: string;
  };
};
```

Default: `github` unset. `loadConfig` deep-merges it like `autoSend`/`integrations`
so a config file can supply it. The token stays out of `Config` entirely so it is
never serialized or logged.

### Resilience

`snapshot()` on both integrations wraps its network work in try/catch:
- On error: `store.recordConnectorEvent('github_snapshot_error', { message, capability })`
  and return the **last-good slice** held in an in-memory field (empty slice on
  cold start). This prevents a transient GitHub/rate-limit blip from making the
  world's PRs/issues "vanish" and triggering spurious dispatcher decisions.
- Mutations (`postPrReply`/`mergePr`) do **not** swallow errors — they propagate,
  and the executor already treats a thrown send as a failed action.

## Testing

New `test/githubIntegration.test.ts`, all using `FakeGitHubApi` (no network):

- CI aggregation: failing/pending/passing/unknown from mixed check-runs + status.
- `unresolvedComments` threading + `handled` = viewer-is-latest-author.
- `approved` folding (latest-per-reviewer, CHANGES_REQUESTED cancels APPROVED).
- `mergeable: null` → `undefined`; `merged` passthrough.
- PR `prAuthor` filter.
- Issues: `pull_request` entries dropped; `issueLabel` passed through;
  `linkedPrNumber` from timeline; `null` when no linking event.
- `postPrReply` threaded vs top-level; `mergePr` method + returned ref.
- Resilience: `snapshot()` returns last-good slice and records
  `github_snapshot_error` when the api throws.

Existing suites are untouched because `fake` stays the default selection.

## Docs

- `README.md`: document the `github` provider, the `github` config block, and the
  `GITHUB_TOKEN` env var in the connectors/provider table.
- `CLAUDE.md`: one note that `github` is a real provider needing `GITHUB_TOKEN`
  and a `github` config block; fakes remain the default.

## Verification

`npm run check` (format, lint, both typecheckers, knip, tests) must stay green.
knip in particular requires the new `@octokit/rest` dependency to be imported and
every new export to be consumed — the registry wiring and tests cover that.
