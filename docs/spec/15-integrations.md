# 15 — Integrations

The harness reads the world through **one** interface and writes through **one** interface. Behind
them the world is assembled from small per-capability integrations, each with interchangeable
providers selected in config. Swapping a provider is a config change, not a code change.

## The two seams

```ts
interface Connector { getState(): Promise<WorldSnapshot>; }
```

```ts
interface ActionSink {
  postPrReply(input): Promise<SendResult>;
  mergePr(input): Promise<SendResult>;
  setPrLabel(input): Promise<SendResult>;
  setIssueLabel(input): Promise<SendResult>;
  setStoryLabel(input): Promise<SendResult>;
  setWorkItemState(input): Promise<SendResult>;
  upsertIssueComment(input): Promise<SendResult>;
}
```

Every outbound method **throws** on failure; `SendResult` carries `ok` and an optional provider-side
`ref` (a comment id or URL, a merge SHA) for the audit log.

## Capabilities and providers

| Capability      | Owns                     | Providers registered              |
| --------------- | ------------------------ | --------------------------------- |
| `sourceControl` | Pull requests            | `fake`, `github`, `azure`         |
| `issues`        | Issues / work items      | `fake`, `github`, `azure`         |
| `backlog`       | Stories                  | `fake`                            |

`src/integrations/registry.ts` maps capability → provider id → factory. Adding a provider is one line
there. An unknown provider id throws at boot, listing the valid ids for that capability. The fake
providers share one `FakeWorldStore` so their world stays coherent.

## Outbound is many small interfaces, not one fat one

`src/integrations/integration.ts` defines each outbound capability separately, with a type guard:

`PrReplyCapable`, `PrMergeCapable`, `PrLabelCapable`, `IssueLabelCapable`, `StoryLabelCapable`,
`WorkItemStateCapable`, `IssueCommentCapable`, `RefResolvable`, and the fake-only `Injectable`.

A provider implements only what it supports. **New outbound actions add a new capability interface
rather than widening a shared one.** When you extend a provider's `*Api` seam, add to the interface
**and its scripted fake in the same change**.

## `CompositeConnector`

Implements both seams:

- **Reads** — fans `snapshot()` out across integrations (in parallel) and merges the slices,
  stamping `takenAt` from an injectable clock.
- **Outbound** — routes each action to the **first** integration that can handle it, by type guard.
  No handler throws a clear message naming the missing capability.
- **`resolveRefUrl(ref)`** — the first `RefResolvable`, or `null`.
- **`inject(event)`** — routes to the fake that owns the event kind and logs it. An event with no fake
  owner is recorded as `inject_unhandled` rather than throwing: you cannot fake-inject onto a real
  provider.

## The `fake` provider

Three integrations over one `FakeWorldStore`, which persists to `connector_state` so an injected world
survives restarts. `FakeGitHubIntegration` owns PRs, `FakeIssuesIntegration` issues,
`FakeBacklogIntegration` stories.

They are the only `Injectable` providers. `POST /api/inject` accepts:

| Kind             | Effect                                                                          |
| ---------------- | --------------------------------------------------------------------------------- |
| `new_pr`         | Adds an open PR (optionally with `baseBranch`, `labels`).                        |
| `ci_failed` / `ci_passed` | Sets `ciStatus`.                                                        |
| `pr_comment`     | Appends an unhandled review comment.                                            |
| `pr_approved`    | Sets `approved`.                                                                |
| `pr_mergeable`   | Sets `mergeable` and optionally `mergeableState`.                               |
| `pr_closed`      | **Moves** the PR from the open list to the closed list, merged or not.           |
| `new_issue`      | Adds an open issue.                                                             |
| `issue_state`    | Opens/closes an issue.                                                          |
| `issue_linked_pr`| Sets `linkedPrNumber`.                                                          |
| `new_story`      | Adds a story.                                                                   |
| `story_state`    | Sets a story's state.                                                           |

`pr_closed` **moves** the row rather than copying it. `mergePr` still marks a PR merged in place so the
deterministic loop settles; a PR present in both lists would have the world diff report one merge
twice.

The fake sink "sends" by reflecting the effect back into its own world (marking the answered comment
handled) and recording a connector event, so nothing leaves the machine while the seam stays real and
testable. It resolves no ref URLs, so refs render as plain text in the cockpit.

`isWorldInjectable(integrations)` is true when **any** capability uses `fake`. It gates both the
`/api/inject` route (403 otherwise) and the cockpit's inject panel, so a real-integration deployment
does not expose a demo affordance.

## The `github` provider

All GitHub HTTP is behind the narrow `GitHubApi` seam (`githubApi.ts`). `OctokitGitHubApi` is the only
file that imports octokit. Tests inject a scripted fake `GitHubApi` — **no network**
(`test/githubIntegration.test.ts`).

The field-mapping logic is exported as **pure functions** and tested directly:

| Function                                    | Does                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `aggregateCiStatus(checkRuns, status)`      | Folds check runs and the combined status into one `CiStatus`.                            |
| `computeApproved(reviews)`                  | Folds reviews into a single approval flag.                                               |
| `buildUnresolvedComments(comments, viewer)` | Threads review comments and marks the ones the viewer already answered as handled.        |
| `normalizeMergeState(state)`                | GitHub `mergeable_state` → `MergeableState`.                                             |
| `mapClosedPull(p)`                          | A closed PR in domain shape.                                                             |
| `linkedPrFromTimeline(events)`              | The last PR to cross-reference an issue. No open/merged filter — hence `linkedPrNumber` is sticky. |
| `viewerAddedLabels(events, viewer, labels)` | Labels the viewer added, from `labeled`/`unlabeled` timeline events.                      |
| `githubRefUrl(owner, repo, ref)`            | Canonical web URL for a ref, or null.                                                    |

Behaviour worth knowing:

- **`mergeable` is tri-state.** GitHub's `null` means "still computing", so the field is left absent
  rather than asserting not-mergeable.
- **A transient snapshot failure serves the last good slice.** The failure is recorded to the error
  log and the previous PR list (open and closed) is returned, so PRs do not flap in and out of the
  world on one bad response.
- **Closed PRs carry no CI, review or comment signal** — blanked rather than fetched. The row exists to
  be *seen*, never acted on, and the per-PR fan-out is exactly the cost the feature must not have.
  Pagination stops at the first entry outside the window: GitHub sorts by `updated` descending, and
  `updated_at >= closed_at` always holds, so the break is sound.
- **A `prAuthor` filter** narrows the PR list client-side, for both open and closed PRs.
- Auth is `GITHUB_TOKEN` only; `github.owner`/`github.repo` are required. See [02](02-configuration.md).

## The `azure` provider

Azure DevOps Repos + Boards, the same shape: all HTTP behind the narrow `AzureDevOpsApi` seam,
`RestAzureDevOpsApi` the only file that touches the network *and* resolves auth, and scripted fakes in
tests (`test/azureDevOpsIntegration.test.ts`).

Pure mapping functions: `aggregatePolicyCiStatus`, `computeApproved` (reviewer votes),
`normalizeMergeState` (`mergeStatus` + `isDraft`), `mergeableFromStatus`, `buildUnresolvedComments`
(thread → comment folding), `stripRef`, `mergeStrategyFor`, `mapClosedPull`, `parseTags`,
`viewerAddedTags`, `normalizeState`, `buildOpenWorkItemQuery`.

Behaviour worth knowing:

- **CI status comes from branch-policy *evaluations*, not the PR `statuses` endpoint.** That endpoint
  returns every status ever posted across *all* iterations, so a stale `failed` from a superseded push
  poisons the PR forever — the false-"failing" bug. `aggregatePolicyCiStatus` reads
  `listPolicyEvaluations` (`/_apis/policy/evaluations`, keyed by the
  `vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}` artifact, so the project GUID is resolved once)
  and folds only **enabled, blocking, CI-type** policies: build-validation and status. Reviewer,
  comment and work-item policies are human gates and map to `approved` / `unresolvedComments` instead.
- **Merging is Azure "complete PR"**, which needs the head commit. The provider caches each PR's
  `lastMergeSourceCommit` from the last snapshot, so a `merge_pr` only works on a PR seen in a prior
  cycle.
- **Work-item tags map onto `Issue.labels`**, so the provider-agnostic pickup and priority gates work
  unchanged. `System.Tags` writes are read-modify-write.
- **`System.State` is preserved on `Issue.workItemState`** (while `Issue.state` collapses to
  open/closed), which is what drives the two state-based dispatcher knobs.
- **Closed PRs** use `queryTimeRangeType=closed` + `minTime` with `status=all`: one request covering
  completions and abandonments, re-filtered client-side because the range is boundary-inclusive and an
  older API version may ignore the parameters.
- Auth: `AZURE_DEVOPS_PAT` (Basic) preferred, else the logged-in `az` CLI (Bearer, cached).
  `resolveAzureAuth` is the one place `az` is invoked. `isSignInHtml` detects a sign-in-HTML response,
  which is retried; transient-retry notices are surfaced in the Errors panel so an occasional failure
  is visible even when the retry recovers.

## Reference links

**URL construction lives in the provider, never in `web/`.** The GitHub providers implement
`RefResolvable`, backed by the pure `githubRefUrl`. `CompositeConnector.resolveRefUrl` routes to the
first resolver.

The server builds a `ref → URL` map (`buildRefUrls`, `src/server/refUrls.ts`) into the `/api/state`
snapshot as `refUrls`, and the cockpit looks refs up there (`linkify` / `refLink` in
`web/src/components/util.tsx`). It never string-builds a `github.com` URL.

`buildRefUrls` keys by `#<number>` for PRs and issues, by branch name for PR and task branches, and by
canonical ref for anything passed in `refs` (findings often name an item that is not in the current
world — a closed duplicate, say). **First writer wins**, so an authoritative item URL is never
overwritten by a resolver fallback. A ref the provider cannot resolve is simply omitted, and the
cockpit renders it as plain text — which is the correct behaviour for the `fake` provider.

### Comment refs

The two comments the harness maintains on a ticket by itself — a plan's status comment and the goal
assay's refusal — are stored as a **provider comment id** (`GhCommentRef` carries a number; Azure
addresses an edit by work item + comment). That is the right value for `upsertIssueComment` to
round-trip and the wrong one to put on the wire: an id resolves to nothing on its own, and a bare
number is read as an *issue number* by `githubRefUrl`'s last-but-one arm — so shipping one would key a
confident link to an unrelated ticket.

`issueCommentRef(originRef, commentId)` (pure, `src/server/refUrls.ts`) pairs the id with the issue it
lives on, producing `issue:12:comment:456` — the same suffixed vocabulary as `issue:12:plan` and
`issue:12:part:<slug>`. It is null-in/null-out, and refuses an origin that is not a plain `issue:<n>`,
so a caller cannot accidentally name the wrong thing. **The store is untouched**: this is a read-only
translation on the way out, and the provider seam still round-trips the id it was given.

`githubRefUrl` resolves that shape to `/issues/<n>#issuecomment-<id>` — the one ref that opens
something more specific than an item's own page. The id must be **numeric**, and the fall-through is
deliberate: GitHub's anchor is minted from a numeric id, so another provider's (or the `fake`
connector's `comment_1`) would build an anchor that scrolls nowhere, and landing on the issue page is
honest because the comment is on it. Azure implements no `RefResolvable` at all, so a comment ref
there resolves to nothing and the cockpit draws no way in — the same degradation every other ref
already has under that provider, and the reason the shape is expressible under both rather than only
GitHub-shaped.

If you add a new ref shape, extend `githubRefUrl` (and its unit test) and, if it is a new structured
field, feed it into `buildRefUrls`.

## Snapshot failures

Providers take an optional `errors` recorder in their `IntegrationContext`. A snapshot failure is
recorded through it — never swallowed — and the provider degrades (last good slice for GitHub source
control). See [18](18-observability.md).
