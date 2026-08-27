# 15 — Integrations

The harness reads the world through **one** interface and writes through **one** interface. Behind
them the world is assembled from small per-capability integrations, each with interchangeable
providers selected in config. Swapping a provider is a config change, not a code change.

## The two seams

```ts
interface Connector {
  getState(): Promise<WorldSnapshot>;
}
```

```ts
interface ActionSink {
  postPrReply(input): Promise<SendResult>;
  canResolvePrThread(): boolean;
  resolvePrThread(input): Promise<SendResult>;
  mergePr(input): Promise<SendResult>;
  setPrLabel(input): Promise<SendResult>;
  setIssueLabel(input): Promise<SendResult>;
  setWorkItemState(input): Promise<SendResult>;
  setWorkItemParent(input): Promise<SendResult>;
  setWorkItemAreaPath(input): Promise<SendResult>;
  upsertIssueComment(input): Promise<SendResult>;
  createIssue(input): Promise<SendResult>;
}
```

Every outbound method **throws** on failure; `SendResult` carries `ok` and an optional provider-side
`ref` (a comment id or URL, a merge SHA) for the audit log.

## Capabilities and providers

| Capability      | Owns                | Providers registered      |
| --------------- | ------------------- | ------------------------- |
| `sourceControl` | Pull requests       | `fake`, `github`, `azure` |
| `issues`        | Issues / work items | `fake`, `github`, `azure` |

`src/integrations/registry.ts` maps capability → provider id → factory. Adding a provider is one line
there. An unknown provider id throws at boot, listing the valid ids for that capability. The fake
providers share one `FakeWorldStore` so their world stays coherent.

## Outbound is many small interfaces, not one fat one

`src/integrations/integration.ts` defines each outbound capability separately, with a type guard:

`PrReplyCapable`, `PrThreadResolveCapable`, `PrMergeCapable`, `PrLabelCapable`, `PrCreateCapable`, `PrTitleCapable`,
`PrBaseCapable`, `PrBaseUpdateCapable`, `BranchDeleteCapable`, `IssueLabelCapable`,
`WorkItemStateCapable`, `WorkItemLinkCapable`, `IssueCommentCapable`, `IssueCreateCapable`,
`IssueCloseCapable`,
`CiEvidenceCapable`, `RefResolvable`, `TicketHistoryCapable`, and the fake-only `Injectable`.

`PrThreadResolveCapable` marks a review thread resolved, and is separate from `PrReplyCapable`
because the two are different provider operations — GitHub resolves through a GraphQL mutation and
replies through REST, Azure patches the thread's status — and because a provider may gain one without
the other. It is keyed on the **root comment id**, the same id a reply threads under and the same id
`PrComment` carries, so nothing outside a provider handles a second identifier. `ok: false` means the
pull request carries no such thread — a stale reading rather than a fault.

`BranchDeleteCapable` deletes a branch outright — the reap after a pull request merges. Both
providers implement it, and both report **already gone as success**: GitHub's "automatically delete
head branches" setting removes the branch at merge time, so absence is the common case rather than a
failure. GitHub deletes the ref; Azure has no delete verb for one and updates it to the zero object
id, which needs the id it currently points at, so the Azure arm is two calls and the first is also
the already-gone check.

`TicketHistoryCapable` lists the tracker's items **across states**, which nothing else here does, and
that is precisely why it is its own capability rather than a widening of `snapshot()`. The snapshot is
_the world the harness acts on_, and that is open items by definition — a rule that could see a closed
one would eventually act on it. This reads history for [the ticket mirror](14-persistence.md#the-ticket-mirror),
and it is narrowed **exactly as each provider's own open listing is**: `workItemTag` and
`workItemAssignedTo` on Azure, nothing on GitHub. The mirror therefore always holds the population the
harness works, never a wider one — and on GitHub, where there is no issue-side assignee filter
([the `github` provider](#the-github-provider)), "the assignment filter" is the whole repository, which
is the honest answer rather than a second, quieter filter invented for this feature.

Both arms take a **changed-since** instant, and that is what makes a sweep incremental instead of a
re-list of the tracker every pulse: GitHub's issues list takes `since` with `state=all`, Azure's WIQL
filters on `System.ChangedDate` (with the `T` separator and sub-second precision stripped, which WIQL
rejects by faulting the whole query, and the request sent with `?timePrecision=true` — a WIQL query
runs at date precision by default and faults on _any_ time supplied under it. The flag is a
query-string parameter; the `Wiql` body is `{query}` alone, so putting it there is dropped in
silence). It is also why the mirror's one-month floor is a floor rather
than a cut — asking by last-changed brings back older items that are still alive.

`IssueCloseCapable` **closes** a tracker item — the plan back-out's "this is not really an issue"
([08](08-planning.md#backing-out-of-a-plan)). Its input is the number and a reason in the two
readings every tracker distinguishes (`completed` / `not_planned`); the operator's words are a
separate `upsertIssueComment`, because a close reason is a provider's own two-word vocabulary and
prose does not fit in it. It is its own capability rather than a method on `WorkItemStateCapable` for
`PrBaseUpdateCapable`'s reason: **GitHub** closes an issue and has no workflow state at all, while
**Azure** has a dozen states and no generic close, and which of them means _we are not doing this_
belongs to the project's process template rather than to the harness. So Azure is deliberately not
capable, `ActionSink.canCloseIssue()` answers false there, and the back-out reports that the item was
left open instead of guessing a state word — the goal is concluded and un-watched either way, so the
fleet is stopped and only the card on the board is left for a human to move.

`IssueCreateCapable` **creates** a tracker item — the seam the four filing arms had no answer for, so
each of them composed a `gh`/`az` command as a string and spent a desk agent typing it back
([13](13-jobs-and-tickets.md#filing-a-ticket)). Its input is provider-neutral and every provider
answers the parts it has:

| Field       | GitHub                                                    | Azure DevOps                                          |
| ----------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `title`     | the issue title                                           | `System.Title`                                        |
| `body`      | the issue body                                            | `System.Description`                                  |
| `labels`    | `labels` on the create                                    | `System.Tags`, semicolon-joined, on the create        |
| `assignee`  | `assignees: [login]` on the create                        | `System.AssignedTo` on the create                     |
| `type`      | **dropped** — a GitHub issue is not created _as_ anything | the create's URL segment (`$User Story`)              |
| `relatedTo` | appended to the body as `Related to #<n>`                 | a second write: a `System.LinkTypes.Related` relation |

Two of those rows are the whole point. Labels and the assignee ride on the **create** rather than on
follow-up writes, because an item that exists for a moment untagged is one the pickup gate can miss
and a filing nobody is assigned. And `relatedTo` is one field rather than a caller's second call: on
Azure a bug is only correct with two writes, and a caller that could forget the second is exactly what
this replaced. A relation that fails does **not** cost the item — it exists and the operator asked for
it — so the throw carries the id of what was created.

`ref` on the result is `issue:<n>`, the harness's own vocabulary rather than a provider id: that is
what a filing row stores, what `link_ticket` speaks and what the cockpit resolves to a URL, so the one
translation happens in the provider instead of at each call site.

**A report about LubbDubb itself does not come through here at all** (issue #449). The cockpit's
"Raise an issue" control is about the tool rather than about the work, and `UpstreamIssues`
(`src/tickets/upstream.ts`) is its own seam past the connector for that reason: it always files into
`AdamAwan/LubbDubb`, whatever provider this deployment selected. Routing it through the composite
would mean an Azure deployment creating a GitHub issue through a work-item API, which nothing can do.

Its transport is the **`gh` CLI**, and that is a choice. The harness's `GITHUB_TOKEN` is scoped to the
repo the fleet works on and may not reach this one; `gh` is already on the machine (the agents use it),
is authenticated as the operator, and files as _them_ — the right byline for a bug report about the
tool, and the reason an Azure-only deployment with no GitHub credential anywhere in its config can
still send one. `describeTarget()` is `gh api user`, one authenticated round trip that a missing or
logged-out CLI fails outright; `create()` is `gh issue create --repo`, whose stdout is the new issue's
URL. Neither is spawned through a shell: the arguments carry a title and a body the operator typed, and
a shell between them and the CLI would make that text executable.

Both **throw** rather than reporting a failure, exactly as `createIssue` does. Which of "gh is not
installed", "gh is logged out" and "the CLI did not answer" an operator should be shown is the caller's
decision — made once, in `GET /api/issues/filing-target`
([16](16-http-api.md#get-apiissuesfiling-target)).

`PrBaseUpdateCapable` merges a pull request's **base into it** — the arm of rule `pr-base-update` that
costs no agent ([05](05-dispatcher.md#pr-base-update--two-arms)). GitHub implements it with
`PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`; **Azure DevOps has no equivalent and does not
implement it**, which is exactly the asymmetry a per-capability interface exists for. Note that it is
_not_ `PrBaseCapable`: one changes which branch a pull request merges into, the other merges that
branch in.

`CiCheckRequeueCapable` queues a **fresh run of an expired CI check** — the arm of rule `pr-ci-gate`
that costs no agent ([05](05-dispatcher.md#pr-ci-gate-a-check-that-waits-rather-than-fails),
[09](09-execution.md#requeue_ci_check--the-expired-build-without-an-agent)). **Only Azure implements
it**, and only because only Azure has the state: a blocking build policy that sits `queued` forever
with nothing in flight. It is deliberately not a method on `CiEvidenceCapable`, the other per-check
provider call — that one reads a failure, this one writes. `ok: false` covers one case more than
`updatePrBranch`'s does: not just a provider without the operation, but a provider that has it and
declined, which on Azure is a 200 whose record comes back still expired.

`WorkItemLinkCapable` hangs a **pull-request artifact link off a work item** — the relation Azure's
**Check for linked work items** branch policy reads, and the only thing that satisfies it. **GitHub
does not implement it and does not need to**: a `#12` in a pull request's body cross-references the
issue by itself, which is precisely the asymmetry a per-capability interface exists for, and it is
why the composite answers `ok: false` here rather than throwing. It is on the **issues** provider,
not the source-control one, because the write is a work-item PATCH: Azure derives a pull request's
`workItemRefs` from these relations and its create-PR payload's copy is read-only, so there is no way
to open a pull request already linked. The artifact id is `{projectId}/{repositoryId}/{prId}` encoded
into a single vstfs path segment, so both GUIDs are resolved (and cached for the client's life)
rather than the configured names used. A duplicate relation comes back as a 400 and is absorbed;
anything else — a PAT without **Work Items (write)** — surfaces. → [07](07-pull-requests.md#linking-the-work-item)

`CiEvidenceCapable` is the one that reads rather than writes, and it is here because it is asked per
act rather than per pulse. It fetches the **failing output** of a red check so a CI-fix dispatch
carries the assertion instead of only the check's name — see
[05](05-dispatcher.md#what-a-ci-fix-dispatch-carries) for what is done with it, and `src/ci/ciEvidence.ts`
for why the excerpt is shaped the way it is. Both providers implement it, and both cover their own
job system and not their third-party status channel:

|        | Structured errors             | Raw fallback                          | Never covered                                                 |
| ------ | ----------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| GitHub | check-run annotations         | the Actions job log, downloaded whole | commit statuses (`target_url` names a system with no log API) |
| Azure  | the build timeline's `issues` | the failing task's log                | status policies (no build, no timeline, no log)               |

Two asymmetries are worth knowing before touching either arm. GitHub's job-log endpoint redirects to
a blob and honours no line range, so a "tail" is a full download that is then discarded; Azure's log
is per **task** rather than per job, which makes the same tail cheap without a range at all. And
Azure's build reads need **Build (read)** on the token — a scope an operator granting code and
work-item access does not think to add, so it 403s while every other read succeeds. Both failures are
recorded and neither is rethrown: the dispatch goes out with today's prompt.

The PR-write capabilities are deliberately separate rather than one `PrWriteCapable`, because a
provider may genuinely have one and not the others: GitHub retargets a stack itself when a rung
merges, so its `setPullBase` serves only the hand-driven case, while Azure needs it on every merge.

A provider implements only what it supports. **New outbound actions add a new capability interface
rather than widening a shared one.** When you extend a provider's `*Api` seam, add to the interface
**and its scripted fake in the same change**.

## `CompositeConnector`

Implements both seams:

- **Reads** — fans `snapshot()` out across integrations (in parallel) and merges the slices,
  stamping `takenAt` from an injectable clock.
- **Outbound** — routes each action to the **first** integration that can handle it, by type guard.
  No handler throws a clear message naming the missing capability — with **three deliberate
  exceptions**.
  `updatePrBranch` answers `{ok: false}` instead: it is the outbound act with a second way to get
  done (the code agent the rule falls back to), so a provider without the endpoint is a configuration
  rather than a fault, and throwing would fill an Azure deployment's Errors panel with a fact about
  its provider. → [09](09-execution.md#update_pr_branch--the-base-merge-without-an-agent)
  `linkWorkItem` answers it for the mirror-image reason: on GitHub the link is **already made**, by the
  reference in the body, so there is nothing to do and nothing failed. Its caller writes no
  `pr_work_item_links` row for an `ok: false`, which is what keeps the retry alive if that deployment
  ever moves to Azure. → [07](07-pull-requests.md#linking-the-work-item)
  `requeueCiCheck` is the third, for `updatePrBranch`'s reason word for word: rule `pr-ci-gate`
  dispatched a code agent for the gate before the direct write existed and still does when the write
  is unavailable, so a provider without the operation — GitHub, which has no expired-policy state to
  begin with — is a configuration rather than a fault.
  → [09](09-execution.md#requeue_ci_check--the-expired-build-without-an-agent)
- **`resolveRefUrl(ref)`** — the first `RefResolvable`, or `null`.
- **`listTicketHistory(since)`** — the first `TicketHistoryCapable`, or `[]`. The **second** routed
  read that answers rather than throwing, for `readCiFailureEvidence`'s reason: the mirror it fills is
  a lens nothing dispatches from, and a provider with no such listing is an empty tab rather than a
  failed pulse. `tracksTicketHistory` says whether any provider can answer at all, which is what stops
  the sweep stamping a floor for a history it will never read.
- **`listAreaPaths()`** — the first `AreaPathCapable`, or **`null`**. The **third** routed read that
  answers rather than throwing, and null rather than an empty tree because the two are different
  readings and only one is about this project: an empty tree is a project that has never subdivided,
  null is a tracker with no such concept at all. `AreaPathDirectory` (`src/intake/areaPaths.ts`) is
  what calls it, from the pulse and under its own TTL, because both its readers — the `appraise_issue`
  argument schema and the state snapshot — are synchronous.
  → [06](06-issue-pickup.md#where-the-goal-belongs-the-placement-proposals-issue-463)
- **`canPlaceWorkItem()` / `setWorkItemParent` / `setWorkItemAreaPath`** — where a work item sits on
  the backlog. **One capability for the two writes**, unlike every split above and for the mirror of
  their reason: those exist because GitHub genuinely has one half and not the other, and these two are
  both Azure Boards concepts that arrive together. The predicate is asked for `canSetWorkItemState`'s
  reason — the two writes throw when nothing implements them, so a caller that wants to **offer** the
  operation has no other way to find out, and the cockpit draws no placement question where nothing
  could act on it.
- **`canCreateIssues()` / `describeFilingTarget()`** — the two halves of "can I file, and where".
  The predicate is the cheap cut, asked first by both filing routes; the probe delegates to the first
  `IssueCreateCapable` and throws when there is none, exactly as `createIssue` does. They are kept
  apart because the two answers are different things to show an operator — a provider that cannot
  file is a **deployment shape**, and a provider that could not be reached is a **fault** — and
  collapsing them would put "no tracker is configured" in the Errors panel of every fake deployment,
  every time a compose modal opened.
- **`inject(event)`** — routes to the fake that owns the event kind and logs it. An event with no fake
  owner is recorded as `inject_unhandled` rather than throwing: you cannot fake-inject onto a real
  provider. **There is no HTTP route behind this**: it is the test suite's world driver (316 call
  sites) and nothing else. Faking a world change is a demo affordance, and the only demo is the
  static Pages build, which has its own in-browser injection ([17](17-cockpit.md#demo-mode)).

## Signing what the harness says

Every outbound write rides on the **operator's own credential** — their `GITHUB_TOKEN`, their PAT. So
a plan comment, an appraisal question, a review reply or a filed ticket arrives on the thread wearing
their avatar and their name, indistinguishable from something they typed. That is a misattribution
rather than an untidiness: a reviewer answers a machine's question believing a colleague asked it,
and the thread's permanent record says a person said something they never said.

So the composite **signs every piece of prose on its way out**, in `signed()`:

> 🤖 Automated comment from **LubbDubb** — automating PR busy work so the user can go to the beach.

Four decisions hold it up.

**It is appended at the seam, not rendered by the callers.** Six surfaces write prose today — the
plan status comment, the appraisal question, the arrival announcement, the PR review reply, the filed
ticket body and the opened PR body — and every one of them reaches a provider through
`postPrReply`, `upsertIssueComment`, `createIssue` or `createPullRequest`. Signing there signs the
surfaces that exist *and* the ones added later. Six call sites each remembering to sign is six that
can quietly become five, on a comment that reads perfectly and is attributed to the wrong author.
Same reasoning as appending to a rendered prompt rather than interpolating into it
([05](05-dispatcher.md#prompt-templates)).

**Only prose is signed.** A label, a merge, a title rewrite, a state transition and a branch delete
are *acts*: they carry no voice for a reader to mistake for a human's, and a footer is not a thing
you can attach to them anyway.

**It names no account.** The avatar beside the comment already says whose credential it went out
under, so naming them restates it — and a line built from `userId` would have a second, quieter
rendering on every deployment that leaves that unset.

**It is unconditional, and not a config key.** A sign-off an operator can switch off is one that is
off exactly where the impersonation matters most.

### Markdown or HTML

`Integration.bodyFormat` says which markup a provider renders, defaulting to `markdown` — what every
provider but one speaks, so only the exception declares anything. The exception is
`issues:azure`: work item descriptions and discussion comments are HTML fields, and Markdown sent
to one arrives as its own punctuation. Azure's **pull request** threads render Markdown, which is why
the flag rides on the integration rather than on the provider family — one provider, two answers.

### Idempotence, and why the ending is hashed

The footer carries a `<!-- lubbdubb:signoff -->` marker — invisible in both flavours, since a
Markdown renderer draws nothing for an HTML comment and Azure's sanitiser drops it. `signOff`
returns a body already carrying one untouched, so a body read back from a provider and re-sent gains
no second footer.

The line's last clause is drawn from a list of endings, because one fixed ending read a hundred times
stops being a joke and becomes furniture — and furniture is what a reader's eye learns to skip,
taking the half of the line that *matters* along with it. Which ending a body gets is **hashed from
the body**, not drawn at random: the plan status comment and the appraisal question are each one living
comment edited in place, and a random ending would move under every edit, filling the thread's
revision history with diffs whose only content is the joke. Hashing spreads endings across comments
while holding each comment's own ending still — and keeps the function pure, so a test asserts
against it without a seed or a clock injected.

## The `fake` provider

Two integrations over one `FakeWorldStore`, which persists to `connector_state` so an injected world
survives restarts. `FakeGitHubIntegration` owns PRs, `FakeIssuesIntegration` issues.

They are the only `Injectable` providers. `inject(event)` accepts:

| Kind                      | Effect                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `new_pr`                  | Adds an open PR (optionally with `baseBranch`, `labels`).              |
| `ci_failed` / `ci_passed` | Sets `ciStatus`.                                                       |
| `pr_comment`              | Appends an unhandled review comment.                                   |
| `pr_approved`             | Sets `approved`.                                                       |
| `pr_mergeable`            | Sets `mergeable` and optionally `mergeableState`.                      |
| `pr_closed`               | **Moves** the PR from the open list to the closed list, merged or not. |
| `new_issue`               | Adds an open issue.                                                    |
| `issue_state`             | Opens/closes an issue.                                                 |
| `issue_linked_pr`         | Sets `linkedPrNumber`.                                                 |

`pr_closed` **moves** the row rather than copying it. `mergePr` still marks a PR merged in place so the
deterministic loop settles; a PR present in both lists would have the world diff report one merge
twice.

The outbound acts reflect into that same world, which is what makes a `buildSystem`-seam test a real
loop rather than a recording: a reply marks its comment handled, a merge marks the PR merged, and
`updatePrBranch` sets `mergeableState` to `clean` — the state a real provider reports once the merge
lands, so the concern is gone rather than re-fired every pulse.

The fake sink "sends" by reflecting the effect back into its own world (marking the answered comment
handled) and recording a connector event, so nothing leaves the machine while the seam stays real and
testable. It resolves no ref URLs, so refs render as plain text in the cockpit.

There is no `injectable` flag on the snapshot and no route to gate. A running harness reads its
provider; a panel that told it something had happened would be a way to lie to yourself about what it
is reacting to, and that is true against the `fake` provider too — a real run against a fake provider
is still a real run.

## The `github` provider

All GitHub HTTP is behind the narrow `GitHubApi` seam (`githubApi.ts`). `OctokitGitHubApi` is the only
file that imports octokit. Tests inject a scripted fake `GitHubApi` — **no network**
(`test/githubIntegration.test.ts`).

The field-mapping logic is exported as **pure functions** and tested directly:

| Function                                    | Does                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `aggregateCiStatus(checkRuns, status)`      | Folds check runs and the combined status into one `CiStatus`.                                      |
| `computeApproved(reviews)`                  | Folds reviews into a single approval flag.                                                         |
| `buildUnresolvedComments(comments, viewer)` | Threads review comments and marks the ones the viewer has **replied** to as handled.               |
| `normalizeMergeState(state)`                | GitHub `mergeable_state` → `MergeableState`.                                                       |
| `mapClosedPull(p)`                          | A closed PR in domain shape.                                                                       |
| `linkedPrFromTimeline(events)`              | The last PR to cross-reference an issue. No open/merged filter — hence `linkedPrNumber` is sticky. |
| `viewerAddedLabels(events, viewer, labels)` | Labels the viewer added, from `labeled`/`unlabeled` timeline events.                               |
| `githubRefUrl(owner, repo, ref)`            | Canonical web URL for a ref, or null.                                                              |

Behaviour worth knowing:

- **`mergeable` is tri-state.** GitHub's `null` means "still computing", so the field is left absent
  rather than asserting not-mergeable.
- **A transient snapshot failure serves the last good slice.** The failure is recorded to the error
  log and the previous PR list (open and closed) is returned, so PRs do not flap in and out of the
  world on one bad response.
- **Closed PRs carry no CI, review or comment signal** — blanked rather than fetched. The row exists to
  be _seen_, never acted on, and the per-PR fan-out is exactly the cost the feature must not have.
  Pagination stops at the first entry outside the window: GitHub sorts by `updated` descending, and
  `updated_at >= closed_at` always holds, so the break is sound.
- **`userId`** narrows the PR list to the ones you opened, client-side, for both open and closed PRs.
- **`updatePullBranch(n)` is the one write with no local git behind it.** GitHub merges the base into
  the pull request on its own machines and answers `202` with a job message rather than a commit, so
  there is nothing to return: the next snapshot is what reports the branch no longer behind. A refusal
  (`422` — the head moved, or the merge is not in fact clean) throws, which is the signal the harness
  falls back to a code agent on. → [09](09-execution.md#update_pr_branch--the-base-merge-without-an-agent)
- **A review thread is handled when the reviewer resolved it, or when the harness posted its newest
  reply — in that order.** The same two arms as the Azure provider, which is the point: both trackers
  carry a real resolution verdict, so both read it.

  Resolution costs a **GraphQL** read (`listPullReviewThreads`), because `PullRequestReviewThread`
  has no REST equivalent — `pulls/{n}/comments` returns no resolution state at all, which is the
  entire reason `handled` was ever inferred from authorship. Only `isResolved` and the root comment's
  `databaseId` are selected; the comment bodies keep coming from REST, so the query stays small and
  the two reads join on an id both already have. It is the **one call in the snapshot allowed to fail
  on its own** — it is reachable for reasons the REST reads are not (a token without GraphQL access,
  an Enterprise Server answering the schema differently, a proxy that passes `/repos` and not
  `/graphql`), and letting it throw would freeze the whole world on `lastGood` over a field that only
  refines a verdict. A failure is recorded to the error log and degrades to arm 2.

- **Arm 2 is positional rather than an identity test, and has to be.** `viewer` is whoever holds
  `GITHUB_TOKEN`, which on a single-operator deployment is the operator themselves — so comparing a
  thread _root's_ author against it marked every review comment the operator left as handled the
  instant they wrote it, and rule `pr-review-comment` never saw it. The harness was silently ignoring exactly the
  reviews a human took the time to write, and no author comparison can fix it: the two identities are
  the same string. The position test needs none — the harness only ever posts _replies_ under a root
  (`createPullReviewReply`; a `commentId: null` reply is an issue comment, which this list never
  contains), so "the newest reply is ours" holds whether the token belongs to a bot account or to the
  operator.

  Both arms, and a missing resolution read, fail toward a thread staying **open** — an agent
  dispatched for a comment already dealt with is visible and cheap, where a dropped review is neither.

- **Resolving a thread is the one GraphQL _write_**, for the read's reason: `resolveReviewThread` is a
  mutation taking the thread's node id, which no REST call returns. The node id never crosses the
  seam — `resolveReviewThread(number, rootCommentId)` looks it up through the same paginated read the
  snapshot uses, so a caller holds only the root comment id and a fixture knows one id fewer. A
  thread already resolved returns without mutating.

- Auth is `GITHUB_TOKEN` only; `github.owner`/`github.repo` are required. See [02](02-configuration.md).

## The `azure` provider

Azure DevOps Repos + Boards, the same shape: all HTTP behind the narrow `AzureDevOpsApi` seam,
`RestAzureDevOpsApi` the only file that touches the network _and_ resolves auth, and scripted fakes in
tests (`test/azureDevOpsIntegration.test.ts`).

Pure mapping functions: `aggregatePolicyCiStatus`, `computeApproved` (reviewer votes),
`normalizeMergeState` (`mergeStatus` + `isDraft`), `mergeableFromStatus`, `buildUnresolvedComments`
(thread → comment folding), `stripRef`, `mergeStrategyFor`, `mapClosedPull`, `parseTags`,
`viewerAddedTags`, `normalizeState`, `buildOpenWorkItemQuery`.

Behaviour worth knowing:

- **CI status comes from branch-policy _evaluations_, not the PR `statuses` endpoint.** That endpoint
  returns every status ever posted across _all_ iterations, so a stale `failed` from a superseded push
  poisons the PR forever — the false-"failing" bug. `aggregatePolicyCiStatus` reads
  `listPolicyEvaluations` (`/_apis/policy/evaluations`, keyed by the
  `vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}` artifact, so the project GUID is resolved once)
  and folds only **enabled, blocking, CI-type** policies: build-validation and status. Reviewer,
  comment and work-item policies are human gates and map to `approved` / `unresolvedComments` instead.
- **A policy's operator-facing name resolves through four places**, in order: `settings.displayName`,
  a status policy's `statusGenre/statusName`, the evaluation's `context.buildDefinitionName`, and the
  policy type's own display name (`policyDisplayName`, exported and unit-tested). The third arm is
  what makes most build policies nameable at all — `settings.displayName` is null unless an operator
  typed one, so a repo's required builds carried no name the harness could see, and a nameless check
  was skipped outright and could not be reached by a `ci.checks` glob.
- **`listPolicyCiChecks` is wider than the fold, in both directions the operator needs.** It carries
  `blocking` per check, taken from the policy's Required/Optional setting, and surfaces **Optional**
  (non-blocking) policies too: such a check really does fail and an agent really can fix it, so the
  harness dispatches for it while `aggregatePolicyCiStatus` stays frozen on the required ones. A
  disabled policy is dropped whatever else is true of it.
- **An expired build policy is `pending` with `expired: true`, not a status of its own.** A branch
  that takes commits after its last policy build leaves the evaluation `status: "queued"` with
  `context.isExpired` — no build is in flight and none starts on its own, so the policy never
  resolves until one is queued. Azure reports a build that _is_ running with the same `status`, which
  is why `checkStatusOf` cannot tell them apart and why the flag is read from `context` and carried
  onto the check. It is not folded into `aggregatePolicyCiStatus` and it is not mapped to `failing`:
  a build that has not run is not a broken one, and saying otherwise would claim the pull request
  cannot merge and send an agent the CI-fix prompt to investigate a failure that does not exist. The
  one thing it moves is `classifyWatchedChecks`, which watches an expired check with no `ci.checks`
  rule naming it, so rule `pr-ci-gate` acts on it
  ([07](07-pull-requests.md#ci-checks), [05](05-dispatcher.md#pr-ci-gate-a-check-that-waits-rather-than-fails)).
  Before it, such a pull request read `elsewhere` / "CI is still running" indefinitely.
- **The evaluation's own id is carried too, as the check's `requeueRef`** — the handle a requeue is
  addressed to, and set only beside `expired`, which is the only state a fresh run answers. That is
  what lets the harness clear the gate with one write instead of an agent (issue #395). The write is
  `PATCH _apis/policy/evaluations/{evaluationId}` and **not** a queue against the build definition:
  a build started from the definition is not attached to this pull request's evaluation, so the policy
  would stay expired while a build ran — a gate that looks cleared for one pulse and is not. The
  answer is read rather than discarded, because a 200 is not a requeue: Azure returns the record
  whether or not it restarted anything, and a record still carrying `isExpired` is one it declined —
  a token without **Build (execute)**, or a definition it cannot queue. `requeueCiCheck` answers
  `ok: false` for that, which is what sends the gate back to the agent it always had rather than
  leaving it waiting on a build nobody started. An evaluation that arrives without an id carries no
  `requeueRef` at all, which reads the same way.
  → [09](09-execution.md#requeue_ci_check--the-expired-build-without-an-agent)
- **Resolving a thread is a PATCH on the thread with `status: 'fixed'`**, not a write on a comment:
  Azure's resolution verdict lives on the thread, and `fixed` is one of the four statuses the resolved
  arm of `buildUnresolvedComments` already reads — so a thread the harness resolves settles on the
  next poll exactly as one a reviewer closed themselves. `commentId` carries the **thread** id here,
  as it does for a reply.
- **Merging is Azure "complete PR"**, which needs the head commit. The provider caches each PR's
  `lastMergeSourceCommit` from the last snapshot, so a `merge_pr` only works on a PR seen in a prior
  cycle.
- **Work-item tags map onto `Issue.labels`**, so the provider-agnostic pickup and priority gates work
  unchanged. `System.Tags` writes are read-modify-write.
- **`System.State` is preserved on `Issue.workItemState`** (while `Issue.state` collapses to
  open/closed), which is what drives the two state-based dispatcher knobs. `System.WorkItemType`
  rides alongside on `Issue.issueType` and drives the container gate.
- **The hierarchy is read and hydrated, never written.** `Hierarchy-Reverse`/`-Forward` relations
  give the parent and child _ids_; the ids are then read back as items through the batched
  `getWorkItems`, because the item list is narrowed by tag/assignee so a parent Feature is usually not
  in it — and a bare id is not context an agent can use. Two batched reads per snapshot at most: the
  parents and children first, then the parents' **other** children, which is where siblings come from
  and which nothing in the first round names. A board with no hierarchy costs no request at all.
  `errorPolicy: 'omit'` keeps one unreadable id from faulting a batch, and an id that comes back
  unread is dropped rather than rendered as a number — but an unreadable _parent_ leaves
  `Issue.parent` `undefined`, never `null`, so it cannot be mistaken for an orphan
  ([03](03-world-model.md#relations)). A hydration failure is recorded through `errors` and then
  dropped: the issues still ship without relations, because losing the annotation is cheaper than
  losing the world.
- **Closed PRs** use `queryTimeRangeType=closed` + `minTime` with `status=all`: one request covering
  completions and abandonments, re-filtered client-side because the range is boundary-inclusive and an
  older API version may ignore the parameters.
- Auth: `AZURE_DEVOPS_PAT` (Basic) preferred, else the logged-in `az` CLI (Bearer, cached).
  `azCliAccessToken` is the one place `az` is invoked — by `resolveAzureAuth`'s CLI arm, and by
  Setup's credential probe, which must ask exactly what the auth path asks
  ([26](26-setup.md#the-credential-check-asks-both-routes)). `isSignInHtml` detects a sign-in-HTML response,
  which is retried; only a request that spends *every* attempt reaches the Errors panel.

## Reference links

**URL construction lives in the provider, never in `web/`.** The GitHub providers implement
`RefResolvable`, backed by the pure `githubRefUrl`; the Azure providers implement it too, backed by
the pure `azureRefUrl`. `CompositeConnector.resolveRefUrl` routes to the first resolver.

**A real provider that is not `RefResolvable` renders every ref as plain text, silently** — an
unresolvable ref is _meant_ to be omitted (that is the `fake` provider's correct behaviour), so
there is nothing to see but missing links. Both integrations of a provider implement it, and both
answer every ref shape, because the composite routes to the first resolvable integration rather
than to the one whose capability matches the ref.

`azureRefUrl` differs from `githubRefUrl` in two places, both forced by Azure:

- **Work items live under the project (`_workitems/edit/<n>`), PRs and branches under a repository
  inside it (`_git/<repo>`)** — so one function spans two bases. A branch is the repo's version
  selector, `?version=GB<branch>`; a comment ref is `?discussionId=<id>` on the work item, falling
  through to the plain item page for a non-numeric id.
- **A bare or `#`-prefixed number resolves to `null`.** Azure work items and PRs are disjoint id
  spaces and neither page redirects to the other, so unlike GitHub there is no guess that is right
  more often than wrong. Nothing is lost: `buildRefUrls` keys `#42` off the world's own item URLs
  before the resolver is asked.

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
appraisal's refusal — are stored as a **provider comment id** (`GhCommentRef` carries a number; Azure
addresses an edit by work item + comment). That is the right value for `upsertIssueComment` to
round-trip and the wrong one to put on the wire: an id resolves to nothing on its own, and a bare
number is read as an _issue number_ by `githubRefUrl`'s last-but-one arm — so shipping one would key a
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
recorded through it — never swallowed — and the provider degrades to its last good slice. "Last
good" means **a read that succeeded**: all four real integrations hold the lists their previous
successful read produced, and serve those rather than nothing. Emptying the world instead would make
every open pull request look closed and every watched issue look gone, which is a far more
destructive reading of "GitHub returned a 502" than simply being a cycle behind.

A provider that has **no** successful read yet has nothing to degrade to, and must not present an
empty world as if it did — that is the one case where an empty slice would be a fabricated world, not
a stale one. On a first-read failure the integration rethrows, `CompositeConnector.getState()`
rejects, and the cycle is recorded as failed rather than deciding against a world that says every PR
vanished. The next pulse tries again.

**A degraded slice sets `stale: true` on the `WorldSlice`**, and `CompositeConnector` folds those
into `WorldSnapshot.staleSources` ([03](03-world-model.md#worldsnapshot)). The fallback was correct
from the start; what it lacked was a mark. Without one, a cycle deciding against a world several
hours old is indistinguishable from a cycle deciding against a world that simply had not changed —
including in the decision log, which is the record an operator reads when the harness does something
that looks wrong. The error log carries the failure and the decision log now carries the caveat,
because a reader of one is not looking at the other.

## Rate limits

Both real providers retry a request the service itself said to retry, through the same diagnostic
sink — a `log` callback wired to the error log in production, silent in tests. What each writes to it
differs, because the two are absorbing different things.

- **Azure DevOps** retries 429 and 5xx, and the sign-in-HTML response an `az`-CLI token produces
  while it propagates, forcing a token refresh between attempts. **A retry that recovers records
  nothing.** The `az`-CLI token is cached on a fixed window rather than a checked expiry, so a blip
  as one generation turns over is ordinary, self-healing and roughly hourly — and the notice for it
  was the whole of Azure's own message, which says the credential was rejected and to run `az login`.
  An operator reading that in the Errors panel is being told an outage that did not happen, on a
  schedule. Only exhaustion is a fault: the entry names the attempts spent and carries the final
  cause, and it is written where the throw is raised, since a caller that degrades to its last good
  reading swallows it ([15](15-integrations.md#reading-less-before-retrying-harder)).
- **GitHub** records a notice on every rate-limited attempt, recovered or not, because a limit the
  fleet is absorbing is the early warning that its read has outgrown its heartbeat — a standing
  condition, not a blip. It carries `@octokit/plugin-retry` and `@octokit/plugin-throttling`, which cover 5xx and
  network failures, the primary hourly rate limit, and the **secondary** (abuse) limit. The secondary
  one is what this fleet actually provokes: it is triggered by burst concurrency rather than an
  hourly budget, and the world read fans out per open pull request and per open issue on every pulse,
  which is a burst by construction.

### Reading less, before retrying harder

The GitHub world read costs on the order of one request per open issue plus six per open pull
request, every pulse. A retry cannot make that fit an hourly budget; only not spending the budget
can. Three things do that, and they are read in this order.

- **Every GET is conditional** (`etagCache.ts`, installed on the client in `fromToken`). The client
  re-sends the `ETag` of the reading it already holds, and **a `304 Not Modified` does not count
  against the rate limit at all** — so the timeline of an issue nobody has touched, refetched every
  pulse forever, costs nothing after the first. This is not a cache with a staleness cost and it has
  no TTL: correctness comes from GitHub, so a label the harness itself writes changes the resource,
  changes its ETag, and the very next GET is a 200 carrying the new body. That is what makes it the
  right shape of cache for reads the harness also writes to.

  Octokit raises a `304` as an error, and neither plugin claims it (retry acts on `status >= 400`,
  throttling on 403/429), so the hook is registered after both — outermost — and turns it back into
  an ordinary success. `paginate` cannot tell the difference, because the replay carries the cached
  `link` header too. A non-GET is never cached, and neither is a `string` body: that is the Actions
  job log, a whole file fetched once per dispatched CI fix, and holding megabytes to save a request
  nobody repeats is the wrong trade.

- **One client per repository, not one per capability.** `sourceControl: github` and `issues: github`
  are two views of one service, so `buildIntegrations` builds the client once and hands it to both
  (`ProviderClients`). Two would be two ETag caches, two `viewerLogin` resolutions — a second
  `GET /user` per boot for an answer fixed for the token's lifetime — and, worst, two copies of the
  throttling plugin's view of the limit, fanning into one hourly budget with no way to tell each
  other it was gone. The clients are scoped to the call rather than memoised on the context, so a
  rebuild after a config change builds against the coordinates the new config states.

- **A primary rate limit is refused, not waited out.** `onRateLimit` returns false once GitHub's
  `retryAfter` exceeds `MAX_PRIMARY_LIMIT_WAIT_S` (60s). The primary limit is not the blip
  `MAX_RETRIES` was sized for: its `retryAfter` is time-until-the-hour-window-resets, so it arrives
  in the hundreds of seconds; the snapshot fans out with `Promise.all`, so *every* request in flight
  parks for it and the pulse is held; and they then all fire again the instant the window reopens,
  re-exhausting the budget they were waiting on. What the wait buys is already free — the snapshot
  degrades to `lastGood` with `stale: true` and the next pulse tries again. A wait short enough to be
  a window turning over anyway is still absorbed, and the **secondary** limit keeps the full budget,
  because it is burst-triggered, clears in seconds, and backing off *is* the correct response to it.
  The decision is `waitOutRateLimit(retryAfterS, retryCount)` — pure, so the policy is testable
  without a clock or a socket — and both outcomes are recorded, worded by which they are.

The harness's `GITHUB_TOKEN` is inherited by every agent it spawns, so `gh` in an agent's own shell
draws on the same hourly budget. The fleet's read is whatever its agents leave it, which is the other
reason the snapshot's cost is worth this much attention.

**CI evidence is deliberately not part of that budget.** The failing output of a red check is fetched
when a CI-fix agent is actually dispatched — one or two requests per failing check, once, in the
executor — rather than in the snapshot. Reading it per pulse would put it on exactly the path this
section warns about, and almost every fetch would be discarded: a red check is red for many pulses
and dispatched for once.
