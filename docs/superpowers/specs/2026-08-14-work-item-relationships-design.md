# Modelling Azure DevOps work-item relationships — design for #267

**Status:** design only. #267 says *do not implement anything*, and this document implements nothing:
no code, no test, no `docs/spec/` change. The specs a future implementation must update are named in
[§7](#7-what-an-implementation-would-touch).

**Date:** 2026-08-14. **Issue:** [#267](https://github.com/AdamAwan/LubbDubb/issues/267).

---

## 0. The ticket's premise is half stale, and the correction changes the shape of the answer

#267 opens by saying the harness "has no model of work-item-to-work-item relationships" and that
`mapWorkItem` "discards everything except `rel === 'ArtifactLink'`". That was true when the ticket was
written. It is not true now, and a reader who takes it at face value will design a greenfield model
next to one that already exists.

What `mapWorkItem` actually does (`src/integrations/azure/restAzureDevOpsApi.ts:551-570`):

```ts
relationUrls: (w.relations ?? [])
  .filter((r) => r.rel === 'ArtifactLink' && typeof r.url === 'string')
  .map((r) => r.url as string),
parentId: hierarchyIds(w.relations, 'System.LinkTypes.Hierarchy-Reverse')[0] ?? null,
childIds: hierarchyIds(w.relations, 'System.LinkTypes.Hierarchy-Forward'),
```

Two of Azure's link types are already read, off the same `$expand: 'Relations'` batch the ticket cites
(`:529`). `AzureDevOpsWorkItemsIntegration.hydrateHierarchy` (`src/integrations/azure/workItems.ts:128`)
then resolves those ids back into full summaries — two batched `getWorkItems` calls per snapshot at
most, none at all on a flat board — and lands them on `Issue.parent`, `Issue.children`,
`Issue.siblings` (`src/types.ts:206-220`). `src/issueRelations.ts` is their single pure interpreter,
and it already feeds all three kinds of consumer #267 asks about:

| Consumer kind | Where | What it does with the hierarchy |
| --- | --- | --- |
| **Dispatch rule** | `containerPickupReason` → `src/dispatcher/issuePickup.ts:136` | Refuses to dispatch at a Feature/Epic |
| **Outbound write** | `watchCascadeTargets` | Watching a Feature tags every item beneath it |
| **Prompt append** | `relatedWorkNote` → `src/dispatcher/rules/issuePickup.ts` | The parent's goal, the siblings' edges, the orphan warning |

So a relationship model exists. It lives in the **world snapshot**, it is **read-only**, and it has a
written doctrine ([03](../../spec/03-world-model.md#relations),
[15](../../spec/15-integrations.md), [06](../../spec/06-issue-pickup.md#hierarchy)).

The design #267 is actually asking for is therefore much narrower and much more answerable: **what
happens to the link types that model does not cover** — `System.LinkTypes.Related`,
`Duplicate`/`Duplicate-Forward`, `Dependency-Forward`/`-Reverse`, and every `ArtifactLink` that is not
the resolving pull request.

### The concrete gap: the harness writes an edge it cannot read back

The motivating "raise issue" button has already shipped (`src/bugFiling.ts`, `src/store/bugFilings.ts`,
the `raise-bug` template, `POST /api/issues/:number/bug`). Its
[own design](2026-08-11-raise-issue-button-design.md) parked this question and cites the same stale
premise. What its prompt tells the desk agent to run, after creating the Bug
(`src/bugFiling.ts:80-81`):

```
az boards work-item relation add --org <org> --id <new bug id> --relation-type related --target-id <story>
```

That is a `System.LinkTypes.Related` link, created by the fleet, on the operator's behalf, today — and
`Related` is exactly the relation `mapWorkItem` drops on the very next snapshot. The story row falls
back to the `issue_bug_filings` row, which records that a **job completed**, not that a **link
exists**, and which knows nothing about a link a human made in Azure or removed afterwards.

The gap is one link type wide. That is the honest headline, and it is why the recommendation in
[§4](#4-where-a-relation-lives) is an extension of an existing model rather than a new one.

### Why this was not simply implemented

Because #267 forbids it, and because the rule-by-rule section ([§3](#3-what-the-harness-would-do-with-a-relation))
is what decides whether the field earns its keep at all. A field with no consumer is a field nobody
can judge; the whole value of the exercise is the list of behaviours *rejected*, which is longer than
the list accepted.

### A second, smaller correction

#267's ground rules say to read `docs/spec/03-integrations.md`. There is no such file: **03 is the
world model** and **integrations is 15**. Both are relevant and both were read, along with
[14](../../spec/14-persistence.md) and [17](../../spec/17-cockpit.md) as asked. Noted so the next
reader does not go looking.

### How to read the confidence markers

Claims about **this repository** are cited by path and line and were checked against the working tree
at `e0bf6be`. Claims about **Azure DevOps' own behaviour** cannot be checked from here — the harness
has no live board in this worktree — so they are marked:

- **[repo]** — verified against the code in this repo.
- **[az-doc]** — from Azure DevOps' documented behaviour; stable, but confirm before depending on it.
- **[verify]** — an implementer must establish this empirically against the operator's actual project
  before anything depends on it. Where a **[verify]** claim would change a decision, the decision is
  written so that it does not.

---

## 1. What Azure actually offers

### 1.1 The link-type vocabulary

Azure returns relations on a work item as `{ rel, url, attributes }`. `rel` is either a **work-item
link type reference name** (item ↔ item) or one of three non-work-item kinds (`ArtifactLink`,
`Hyperlink`, `AttachedFile`). The full set an inherited process exposes is queryable at
`_apis/wit/workitemrelationtypes`; `az boards work-item relation list-type` prints it **[az-doc]**.

| `rel` | Friendly name | Direction | Read today? | What it means |
| --- | --- | --- | --- | --- |
| `System.LinkTypes.Hierarchy-Reverse` | Parent | ← | **Yes** `:567` | The item this one hangs off. **At most one** — enforced by Azure, which is why `AzWorkItem.parentId` is a scalar and not a list **[repo]/[az-doc]** |
| `System.LinkTypes.Hierarchy-Forward` | Child | → | **Yes** `:568` | The items hanging off this one |
| `System.LinkTypes.Related` | Related | symmetric | **No** | "These two have something to do with each other." No rollup, no board position, no scheduling meaning |
| `System.LinkTypes.Duplicate-Forward` | Duplicate | → | **No** | This item duplicates the target |
| `System.LinkTypes.Duplicate-Reverse` | Duplicate Of | ← | **No** | The target duplicates this item |
| `System.LinkTypes.Dependency-Forward` | Successor | → | **No** | The target should follow this item |
| `System.LinkTypes.Dependency-Reverse` | Predecessor | ← | **No** | The target should precede this item |
| `System.LinkTypes.Remote.Related` | Remote Related | symmetric | **No** | Related, across organizations |
| `Microsoft.VSTS.Common.Affects-Forward` / `-Reverse` | Affects / Affected By | → / ← | **No** | **CMMI process only** |
| `Microsoft.VSTS.Common.TestedBy-Forward` / `-Reverse` | Tested By / Tests | → / ← | **No** | Links a requirement to a Test Case |
| `ArtifactLink` | Pull Request, Branch, Fixed in Commit, Build, … | — | **Partly** `:564` | A link to something that is not a work item. The `attributes.name` distinguishes the kinds; the harness keeps all of the URLs and then narrows |
| `Hyperlink`, `AttachedFile` | — | — | No | A URL and an attachment. Not relationships |

**Hierarchy is a tree and Azure enforces it as one**: one parent maximum, and circular links are
refused **[az-doc]**. Every other item↔item link type above is a free-form graph edge — Azure imposes
no cardinality, no acyclicity and no type constraint on `Related`, `Duplicate` or `Dependency`
**[az-doc]**. That asymmetry is the single most load-bearing fact in this document: it is why
hierarchy can drive a dispatch gate and the rest, mostly, cannot ([§3](#3-what-the-harness-would-do-with-a-relation)).

### 1.2 The ArtifactLinks already used

`linkedPrFromRelations` (`src/integrations/azure/workItems.ts:291`) takes every `ArtifactLink` URL and
matches one shape:

```
vstfs:///Git/PullRequestId/{project}%2F{repoId}%2F{prId}
```

The trailing segment is the PR id; the **last** match wins, and everything else — `vstfs:///Git/Commit/…`,
`vstfs:///Git/Ref/…` (branch), `vstfs:///Build/Build/…`, wiki and test-result artifacts — is discarded
**[repo]**. That is deliberate and correct for what `Issue.linkedPrNumber` promises, and
[03](../../spec/03-world-model.md#issue) states the field is **sticky**: it stays set after that PR
merges, so no gate may read it as "has an open PR". Nothing in this design changes it.

The one artifact worth naming as a future candidate is the **branch** link (`vstfs:///Git/Ref/…`),
which would let the harness see a branch a human cut for a work item outside the harness's naming
convention. It is not proposed here; it is a different question (branch discovery, `src/graph/`'s
territory) and #267 is about item↔item links.

### 1.3 Process templates: which types can be in which hierarchy

The ticket asks "which combinations a Bug and a User Story can legally be in under both the Agile and
Basic process templates." The honest answer starts by rejecting the question's framing:

**The Basic process has no Bug and no User Story.** Its three types are **Epic → Issue → Task**
**[az-doc]**. A board on Basic cannot be in any Bug/User-Story combination, legal or otherwise. This
matters to the harness concretely: `PARENTED_TYPES` in `src/issueRelations.ts` already lists `issue`
alongside `story`/`bug`, so a Basic board's `Issue` items are orphan-checked and its `Epic` items are
container-gated by `DEFAULT_CONTAINER_TYPES` **[repo]** — Basic works today, by type-name coincidence
that is worth knowing is a coincidence.

**The Agile process** has Epic → Feature → User Story → Task, with Bug's position set per-project by
the **"Working with bugs"** setting **[az-doc]**:

| Setting | Bug's backlog level | A Bug's natural parent | A Bug's natural children |
| --- | --- | --- | --- |
| Bugs managed **with requirements** | Requirement (same as User Story) | Feature | Task |
| Bugs managed **with tasks** | Task (same as Task) | **User Story** | — |
| Bugs **not on backlogs** | none | neither backlog shows it | — |

So "can a Bug be the child of a User Story?" has no single answer: it is the project's setting, not
the process template, and it can be changed by a project administrator after the fact. This is exactly
the reasoning already written into `src/bugFiling.ts:41-45`, and it is why the raise-bug prompt
chooses `related` — **Related is legal between any two work items whatever the setting** and changes
neither item's rollup nor its board position **[az-doc]**.

One caution on a claim the repo already makes. `src/bugFiling.ts:44-45` says a Story→Bug parent link
"is refused outright where it is not [bugs at task level]". Azure certainly enforces *some* hierarchy
type rules and reports them as a `TF201036`-style rule violation **[az-doc]**, but whether the REST
`PATCH` refuses a given pair, or merely leaves the item mis-placed on the backlogs, is
configuration-dependent **[verify]**. **Nothing in this design depends on the answer**: the harness
never writes a hierarchy link ([15](../../spec/15-integrations.md) — "read and hydrated, never
written"), and the one place it asks an *agent* to write a link already chose the type that is legal
either way.

### 1.4 `az boards work-item relation add`

What it can do **[az-doc]**:

```
az boards work-item relation add --id <id> --relation-type <type> --target-id <id>[,<id>...]
az boards work-item relation add --id <id> --relation-type "artifact link" --target-url <url>
az boards work-item relation remove --id <id> --relation-type <type> --target-id <id> --yes
az boards work-item relation list-type          # what this org actually offers
az boards work-item relation show --id <id>     # the item with its relations
```

`--relation-type` takes the **friendly** name, not the reference name: `parent`, `child`, `related`,
`duplicate`, `duplicate of`, `predecessor`, `successor`, `tested by`, `tests`, `artifact link`,
`remote related`. `--target-id` accepts a comma-separated list, so one call can add several. Remote
and artifact links take `--target-url` instead of `--target-id`.

What it **cannot** do:

- It cannot create a link type. The vocabulary is the process's.
- It cannot express link **attributes** (comment, `isLocked`) — only the edge itself.
- It has no `--if-not-exists`. Re-adding an existing relation is rejected rather than being a silent
  no-op **[verify]**, which matters for a **retried desk job**: an agent that re-runs its own
  `relation add` after a partial failure sees an error on a link that is already correct.
- It cannot bypass the one-parent rule or create a cycle; Azure refuses both **[az-doc]**.

How it fails: the CLI surfaces the REST 400 body on **stderr** and exits non-zero **[az-doc]**. The
message is the Azure rule text (a `TF201036`-style "you cannot add a *X* as a child of a *Y*", or a
"work item already has a parent"), not a machine-readable code. **Design consequence:** any future
agent instruction that adds a relation must tell the agent to treat a non-zero exit as a fact to
report rather than a failure to retry into — the harness has no parser for those messages and should
not grow one. The current `raise-bug` prompt already avoids the problem by using the always-legal type.

---

## 2. What GitHub can honestly express

The connector interface is shared, so every field this design proposes needs a GitHub answer that is
either real or an explicit, documented empty. There is no parity here, and inventing some would be
worse than the gap.

### 2.1 `related` — real, from the timeline, with a caveat

`GhTimelineEvent` (`src/integrations/github/githubApi.ts:195-204`) already carries the timeline, and
`GitHubIssuesIntegration.snapshot` already fetches it **per issue** for linked-PR detection
(`src/integrations/github/issues.ts:85`) **[repo]**. Today `octokitGitHubApi.listIssueTimeline`
(`:338-361`) keeps `source.issue.number` from a `cross-referenced` event **only when that source is a
PR** (`if (issue && issue.pull_request)`), discarding the issue-to-issue case entirely **[repo]**.

That discarded case is precisely GitHub's version of a Related link — and it is the same edge
`bugTrackerCoordinates` tells the GitHub desk agent to create: "Name issue `#<story>` in the body …
that cross-reference is what links the two, and GitHub shows it on both" (`src/bugFiling.ts:66-70`)
**[repo]**. So `related` can be populated on GitHub, from data already on the wire, with no extra
request.

**The caveat must be stated wherever the field is documented:** a cross-reference means *somebody
mentioned this issue*, not *somebody declared a relationship*. A passing mention in a comment produces
the same event as a deliberate link, and GitHub offers no way to tell them apart. That makes it good
enough for a **cockpit lens** (an operator reading "mentioned by #481" loses nothing if it turns out
to be a passing mention) and **not** good enough for a dispatch rule. Since this design endorses no
new dispatch rule ([§3](#3-what-the-harness-would-do-with-a-relation)), the caveat costs nothing.

### 2.2 Hierarchy — documented `undefined`, and it must stay that way for now

GitHub has shipped a **sub-issues** API (`GET /repos/{owner}/{repo}/issues/{n}/sub_issues`, with a
`parent` on the issue payload) **[az-doc — GitHub's docs; verify against the pinned octokit version]**.
So parent/child on GitHub is no longer strictly impossible, and this document will not claim it is.

It should still stay `undefined`, and the reason is a hazard rather than a limitation: **`parent`
switching from `undefined` to `null`-or-an-object turns on every hierarchy-based behaviour in the
harness at once, for every GitHub deployment.** `isOrphanIssue` reports an orphan when
`parent === null` and the type is in `PARENTED_TYPES` **[repo]**; `containerPickupReason` fires on
`issue.issueType` being a container type **[repo]**; `relatedWorkNote` starts appending orphan
warnings and candidate-parent menus to prompts **[repo]**. The tri-state contract in
[03](../../spec/03-world-model.md#relations) is what currently keeps all of that off for GitHub. A
change that populated `parent` would read in review as adding data and would land as changing
dispatch behaviour — the exact class of silent change `CLAUDE.md` exists to prevent.

If sub-issues are wanted later, they are their own change, with their own decision about
`issueType` (GitHub has no work-item type, so the container gate would have nothing to read) and their
own spec update to [06](../../spec/06-issue-pickup.md). **Out of scope for #267.**

**Task lists** (the older `- [ ] #123` markdown convention) are not proposed at all: they are body
text with no API guarantee, and parsing them would manufacture a relationship model out of prose.

### 2.3 The rest — documented empty

`Duplicate` and `Dependency` have **no GitHub equivalent**. GitHub has a `duplicate` label and a
"close as duplicate" action, neither of which yields a machine-readable target issue in the timeline
in a form worth depending on. They are `undefined` on GitHub, permanently, and that is the honest
answer rather than a gap to be closed later.

### 2.4 The summary table

| Field | Azure | GitHub | `fake` |
| --- | --- | --- | --- |
| `parent` / `children` / `siblings` | Populated today | `undefined` — see §2.2 for why not sub-issues | `undefined` |
| `related` | From `System.LinkTypes.Related` | From issue-to-issue `cross-referenced` events; "mentioned", not "declared" | `undefined` |
| `duplicateOf` *(not proposed)* | Available | `undefined`, permanently | `undefined` |
| `blockedBy` / `blocks` *(not proposed)* | Available (`Dependency-*`) | `undefined`, permanently | `undefined` |

---

## 3. What the harness would DO with a relation

This is the section that decides whether the feature is worth anything. Every candidate is judged
against the constraint `CLAUDE.md` states outright: **the dispatcher may not consult a lens.** The
work graph, `buildStacks`, `prAttentionStatus`, `findings` and `overlaps` are read-only views, and
`test/workGraph.test.ts`, `test/stacks.test.ts` and `test/prAttention.test.ts` enforce the separation
structurally **[repo]**. A behaviour is therefore one of two things, never both, and naming which is
half the answer.

### 3.1 Should an open child block the parent's conclusion resolving to `done`? — **Reject**

Three reasons, in increasing order of how much they settle the matter.

**The antecedent is never reached.** A container is never dispatched at
(`containerPickupReason`, `src/dispatcher/issuePickup.ts:136`), so a Feature never gets a run, never
gets a delivery, never gets a plan and therefore never gets a conclusion. `resolveConclusion`
(`src/issueConclusion.ts`) folds an operator toggle, a standing shortfall, a plan in flight, an
agent's declaration and a complete plan **[repo]** — a Feature has none of those. There is no `done`
to block. The rule as written in #267 cannot fire.

**It would be a sixth author with no note.** The precedence list in `src/issueConclusion.ts:72-100` is
a list of *authors*, each of whom said something, and the resolved shape carries `by`, `note` and `at`
so the cockpit can always say who decided and why **[repo]**. A tracker-derived veto has no author, no
words and no timestamp. It would render as a verdict nobody can be asked about — and `by` on the wire
type (`ConclusionAuthor | 'plan' | null`) has no value to spell it with, so adding one is a wire
change to express "the board says so".

**It is Azure's own job, done better.** Azure rolls a Feature's state up from its children on the
board already, in a UI the operator is looking at anyway. A second, worse copy of that rollup inside
the harness is a claim the harness is not positioned to make.

*If it were ever wanted*, the shape is not a veto: it is an explicit author, `by: 'hierarchy'`, with a
note naming the open children, slotted into the precedence list at a stated position — and it would
be a **dispatch-facing** change, because the conclusion feeds `deliveryHold` and rule `issue-pickup`.
Not a lens.

### 3.2 Should `issue-pickup` skip an item whose parent is being worked? — **Reject**

**As stated, the antecedent is never true**, for the same reason as above: the parent is a container,
and a container is never dispatched at. "Parent is being worked" has no referent in this harness.

Two nearby rules are worth naming, because a reader will think of them and both should be rejected on
the record.

**A sibling being worked → reject.** Siblings under one Feature are the normal decomposition of a
feature into parallel work. Gating on one would serialise exactly the case the fleet exists for, and
the real hazard it gestures at — two agents editing the same files — is already owned by file-overlap
detection ([12](../../spec/12-artifacts-and-files.md)), which measures the actual collision rather
than guessing at it from the tracker.

**A Predecessor being open → reject, with the evidence that would flip it.**
`Dependency-Reverse` is the one link type with a genuine "not yet" meaning, and a gate on it would
live legitimately in `src/dispatcher/issuePickup.ts` beside `containerPickupReason`, with its own
`pickup.status` reason string. It is rejected because:

- Dependency links are populated only where a team deliberately uses them. On a board that does not,
  the gate is a no-op — cost with no benefit.
- On a board that populates them **carelessly**, the gate silently parks work with a reason the
  operator has to open Azure to understand. A dispatch rule whose false positives are invisible from
  the cockpit is the worst shape a rule can have.
- Azure itself does not enforce the ordering — a Successor can be worked while its Predecessor is open
  **[az-doc]**. Enforcing it in the harness would be stricter than the tool the link came from.

**What would change this:** evidence from the operator's own board that Predecessor links are used
deliberately and kept current. That is a question for the operator, not for the code
([§8](#8-open-questions)). If the answer is yes, the gate is worth having, it needs `blockedBy` on the
snapshot (**not** in the work graph — see [§4](#4-where-a-relation-lives)), and it needs its own entry
in [05](../../spec/05-dispatcher.md)'s rule book and [06](../../spec/06-issue-pickup.md).

**A Duplicate gate → reject, and the reason is the interesting one.** "Don't pick up an item marked as
a duplicate" sounds like the most defensible gate of the lot: it is a statement about the item itself
rather than a scheduling opinion, and it fails safe. It is rejected because it is **almost always
redundant** — an item marked duplicate in Azure is conventionally also closed, and a closed item is
not picked up anyway **[repo]**: `normalizeState` collapses `Closed`/`Done`/`Removed`/`Resolved` to
`closed` (`src/integrations/azure/workItems.ts:279-283`). The residual case is an *open* item marked
duplicate, which is a data-entry lag, and the fix for a data-entry lag is closing the item, not a
harness gate that hides it. It is worth **reporting** — see §3.3 — never gating.

### 3.3 Should a related bug appear on the parent's row in the cockpit? — **Accept, as a read-only lens**

This is the motivating use case and the one behaviour that survives. It is a **lens**: it changes what
an operator sees and nothing about what the harness does, so it is subject to none of the constraints
above and needs no dispatcher involvement at all.

There are two halves, and — the useful finding of this investigation — **only the second is blocked on
#267**.

**Half one is unblocked today.** The server already ships `bugFilings` on the state snapshot
(`src/wire.ts:511`, `src/server/stateSnapshot.ts:101,547`) and already resolves both refs on it into
URLs, with a comment that says the chip on the row links the filed bug
(`src/server/stateSnapshot.ts:286-290`) **[repo]**. **No cockpit component reads `state.bugFilings`.**
The only web-side references are the type re-export and an empty demo fixture; `GoalPage.tsx` opens
`RaiseBugModal` and never draws what came of it **[repo]**. So an operator who raises a bug gets no
confirmation on the surface they raised it from. That is a cockpit change against a wire field that
already exists, and it needs no relationship model whatsoever. It should be done first, and it is
filed separately rather than smuggled into this design.

**Half two is what the model buys.** A filing row records that *a job completed*. It does not know
about a link a human made in Azure by hand, it does not know if someone deleted the link afterwards,
and on a fresh database it knows nothing at all. `Issue.related`, read from the provider each poll,
answers all three — it is the live edge rather than the record of the click. The right arrangement is
both: **the filing row is the durable record of the operator's action, and `related` is the live state
of the board**, drawn together, with the lens degrading to the filing row alone on GitHub if the
cross-reference read is not implemented.

Where it draws is deliberately left open ([§8](#8-open-questions)) — #267 asks for the relationship
model, not the surface. The one constraint that is not open: a related item is a **reference**, so it
is drawn with `<Ref to={ref}/>` and never as text, and never inside a button
([17](../../spec/17-cockpit.md#links)) **[repo]**.

### 3.4 One more that is neither, and belongs in the prompt

`relatedWorkNote` (`src/issueRelations.ts:213`) is the third consumer kind and the cheapest place to
put a relation to work: text **appended** to a rendered prompt, never interpolated into one, because
prompt templates are operator-overridable and `loadPromptTemplates` rejects only *unknown*
placeholders — so a `{related}` token would be dropped silently on exactly the deployments that
customised most **[repo]**, per [09](../../spec/09-execution.md) and
[05](../../spec/05-dispatcher.md#prompt-templates).

**Accept, narrowly:** a Related item is genuinely useful context for a planning agent ("a bug was
raised against this story — here is its title and state"), and appending it costs one paragraph and no
behaviour. It must be phrased the way the existing sibling paragraph is — *that is someone else's
scope, do not do their work* — because a Related bug on a story is emphatically **not** an instruction
to fix the bug. The bug carries its own work as its own item, which is the whole argument the
raise-issue design already made.

### 3.5 The verdict table

| Candidate | Verdict | Kind | Why |
| --- | --- | --- | --- |
| Open child blocks parent's `done` | **Reject** | would be a dispatch rule | A container never gets a conclusion; would be an author with no note; Azure rolls up already |
| `issue-pickup` skips item whose parent is worked | **Reject** | would be a dispatch rule | A container is never worked — the antecedent has no referent |
| `issue-pickup` skips item whose sibling is worked | **Reject** | would be a dispatch rule | Serialises the parallel case the fleet exists for; file overlap already owns the real hazard |
| `issue-pickup` skips item with an open Predecessor | **Reject**, revisitable | would be a dispatch rule | No-op where unused, invisibly harmful where misused, stricter than Azure. See [§8](#8-open-questions) |
| `issue-pickup` skips a Duplicate | **Reject** | would be a dispatch rule | A duplicate is conventionally closed, and a closed item is already skipped |
| Related bug drawn on the story's row | **Accept** | **read-only lens** | The motivating use case; changes nothing the harness does |
| Related item named in `relatedWorkNote` | **Accept**, narrowly | prompt append | Context, phrased as scope-marking, not as an instruction |
| Harness *writes* a relation through the provider seam | **Reject** | — | See [§6](#6-why-the-harness-still-writes-no-relation) |

**Net: one new field, no new dispatch rule, one lens and one paragraph of prompt.** That is a small
result, and it is the right one — it is also why the field is worth adding, since a snapshot field
with two read-only consumers is exactly as reversible as its consumers are.

---

## 4. Where a relation lives

Three candidates, as #267 frames them. The answer is **the world snapshot**, on `Issue`.

### 4.1 The world snapshot — **chosen**

Populated exactly where the hierarchy already is: a filter added in `mapWorkItem`
(`src/integrations/azure/restAzureDevOpsApi.ts:551`) alongside the two `hierarchyIds` calls, and the
resulting ids resolved by the same batched pass in `hydrateHierarchy`
(`src/integrations/azure/workItems.ts:128`) that already resolves parents, children and siblings — a
Related id joins the existing `wanted` set and costs **no additional request** in the common case,
since the batch is one call either way.

Why the snapshot:

- **The provider is the only author.** [15](../../spec/15-integrations.md) states the invariant for
  hierarchy — "read and hydrated, never written" — and [§6](#6-why-the-harness-still-writes-no-relation)
  argues it should hold for every link type. A model with exactly one author belongs where that author
  writes.
- **Staleness stops being a concept.** Someone deleting a link in Azure is a non-event: the next poll
  simply omits it. There is no reconciler to write and no reconciler to forget to write.
- **The precedent is the same shape, and it works.** `parent`/`children`/`siblings` have lived here
  through a dispatch gate, a write cascade, a prompt append and a cockpit fold.
- **Failure is already handled.** A hydration failure is recorded through `errors` and dropped, so the
  issues ship without relations rather than the world failing — losing an annotation is cheaper than
  losing the world (`src/integrations/azure/workItems.ts:122-127`, recorded at `:168-172`) **[repo]**. A new field inherits
  that for free. So does the snapshot-level `lastGood` / `stale: true` fallback.
- **The wire needs no change.** `wire.Issue extends WorldIssue` (`src/wire.ts:140`) **[repo]**, so a
  field added to the domain `Issue` reaches the cockpit through the existing extension — which is
  #267's question-4 wire clause answered: the rule that anything on a snapshot type must go through
  `src/wire.ts` is satisfied by the `extends` that is already there, and no re-declaration or widening
  is introduced ([`test/wireContract.test.ts`](../../../test/wireContract.test.ts)).

### 4.2 A `Store` table — **rejected, and this is the document's central argument**

A `work_item_relations` table is the shape #267's question 5 anticipates. It should not be built, and
the reason is not effort.

**A store table is for something the harness is the author of.** Every table in
[14](../../spec/14-persistence.md) records a decision somebody made inside the harness — a task
dispatched, a plan approved, a verdict declared, a bug filing opened. Relations are authored entirely
in Azure. A durable copy would be a **cache with no authority**, and every question about it becomes a
staleness question: a link deleted in Azure lingers until something reconciles, and nothing does. The
harness would then hold, durably, a claim about the board that the board contradicts — and the
cockpit would draw it with the same confidence as a true one.

**The reconciler that would fix it is a re-derivation of the snapshot.** The only correct reconciliation
is "delete every row not seen in the latest poll" — which is, precisely and exactly, what a snapshot
already is, for free, with no table, no migration and no code.

**The one thing a table buys is survival across a provider outage**, and the snapshot already has that:
`lastGood` returns the previous issues with `stale: true` when a snapshot throws
(`src/integrations/azure/workItems.ts:96,103`) **[repo]**.

The durable record that *should* exist already does: `issue_bug_filings`
([14](../../spec/14-persistence.md), `src/store/bugFilings.ts`) records an event with a real author —
the operator clicked, the job ran, the agent reported a ref. That is a fact about the harness's own
history, it can never be contradicted by Azure, and it is correctly stored. It is the contrast that
makes the case: **store what the harness did; snapshot what the board says.**

### 4.3 The work graph (`src/graph/`) — **rejected**

Two independent reasons, either sufficient.

**It is a structure over the wrong nouns.** The work graph models branches, pull requests, parts and
their lineage (`parentRef`) — the harness's own execution history. Tracker items are its *origins*,
not its nodes. Putting item↔item edges there would mix two graphs whose edges mean different things
and whose lifetimes differ by orders of magnitude.

**It is a lens, and the dispatcher may not consult it.** `CLAUDE.md` says so and
`test/workGraph.test.ts` asserts it structurally **[repo]**. Anything placed there is permanently out
of reach of `issue-pickup` — which is where the one revisitable dispatch rule (§3.2, Predecessor)
would have to live. Choosing the work graph would foreclose the only future this design leaves open.

### 4.4 The shape of the field

The planner's open question was flat `IssueRelative[]` versus a typed
`{ kind, item }[]` covering every link type in one field. **Neither. One field per link type**, exactly
as `parent`, `children` and `siblings` are three fields rather than one typed list:

```ts
/**
 * Items linked to this one by a non-hierarchy "related" link — Azure's
 * `System.LinkTypes.Related`, or a GitHub issue that cross-referenced this one.
 * `undefined` when the provider does not track relations at all.
 */
related?: IssueRelative[];
```

Two arguments, and the second is decisive:

- **Consistency.** The repo already spells relations as one field per kind, the specs already document
  them that way ([03](../../spec/03-world-model.md#relations)), and `IssueRelative` is reused with no
  change.
- **The tri-state contract cannot be expressed by a typed list.** `undefined` means *the provider does
  not track this*, and it is read — that is what keeps every hierarchy rule off for GitHub. A single
  `relations: {kind, item}[]` collapses "GitHub cannot express Duplicate" and "this Azure item has no
  duplicates" into the same empty array, permanently. Per-kind absence is exactly the distinction
  [03](../../spec/03-world-model.md#relations) is built on, and the flat list destroys it on the day
  a second kind is added.

**Ship `related` only.** `duplicateOf`, `blocks` and `blockedBy` are named here as the shape a future
need takes — same pattern, same `IssueRelative`, same tri-state — and are not proposed, because §3
rejected every consumer for them and a field with no reader is a field nobody can judge.

The **directionality** of `related` needs no representation: `System.LinkTypes.Related` is symmetric,
so both items carry the link and both see the other **[az-doc]**. That is the second reason it is the
right first link type: it needs no forward/reverse pair, unlike Duplicate and Dependency.

---

## 5. Migration and staleness

#267's question 5 asks what happens on deletion and what the `ColumnMigrations` entry looks like. Since
[§4.2](#42-a-store-table--rejected-and-this-is-the-documents-central-argument) rejects storage, this
section is **explicitly a counterfactual**. It is not a design for a table; it is the answer to "if you
stored it, here is what you would owe" — and the size of that debt is part of why the answer is no.

### 5.1 Under the recommendation: deletion is a non-event

Someone deletes the Related link in Azure → the next poll's `$expand: 'Relations'` does not return it →
`mapWorkItem` produces no id → `hydrateHierarchy` resolves none → `Issue.related` comes back one item
shorter → the cockpit draws one chip fewer, and `relatedWorkNote` one line fewer. No migration, no
reconciler, no code path.

The only durable trace left is the `issue_bug_filings` row, which correctly still says *the operator
raised a bug and the job filed it* — a true statement that the deletion does not falsify.

The residual staleness is the **poll interval**, which is the staleness every other world field already
has, and a snapshot failure keeps the *last good* relations with `stale: true` rather than silently
emptying them **[repo]**.

### 5.2 If it were stored — the debt, stated

A table keyed on the edge:

```sql
CREATE TABLE IF NOT EXISTS work_item_relations (
  source_number INTEGER NOT NULL,
  rel_kind      TEXT    NOT NULL,   -- 'related' | 'duplicate_of' | 'blocked_by' | ...
  target_number INTEGER NOT NULL,
  seen_at       TEXT    NOT NULL,
  PRIMARY KEY (source_number, rel_kind, target_number)
);
CREATE INDEX IF NOT EXISTS idx_work_item_relations_source ON work_item_relations(source_number);
```

**On the `ColumnMigrations` question specifically:** a brand-new table needs **no** entry — `CREATE
TABLE IF NOT EXISTS` creates it whole on every database, old and new
([14](../../spec/14-persistence.md#migrations)), exactly as `issue_bug_filings`, `work_item_filings`
and `work_item_ignores` needed none. The trap is that *a table being new once does not keep it exempt*:
the first column added later is invisible on every database created before it, silently, and the
`validation_checks` row of that spec's table is the standing record of that debt being collected one
change late. So the entry is declared **empty at birth**, in the module that owns the table, so the
next column is noticed in the file it is added to:

```ts
// src/store/workItemRelations.ts
export const WORK_ITEM_RELATION_COLUMNS: ColumnMigrations = {
  // Declared empty: still a fresh CREATE TABLE with nothing added since. The entry
  // exists so the next column added is noticed here rather than read back as undefined.
  work_item_relations: {},
};
```

applied by the composition root in `src/store/store.ts` alongside the others, per the pattern in
`src/store/agents.ts:6` **[repo]**. And the day someone adds `target_title` to avoid a hydration read:

```ts
work_item_relations: { target_title: 'TEXT' },
```

nullable, because every pre-existing row reads `null` for it.

### 5.3 And the part with no good answer: deletion

This is the debt the counterfactual actually incurs. Three options, all bad:

| Approach | What goes wrong |
| --- | --- |
| **Never delete** | The cockpit draws a link the board does not have, indefinitely, with no way for an operator to tell which rows are real |
| **TTL sweep on `seen_at`** | A link is real for the whole TTL after deletion, and *disappears* for the whole TTL after any provider outage that skipped a poll — wrong in both directions, and the second is worse |
| **Delete every row not seen in this poll** | Correct — and it is the definition of a snapshot, re-implemented in SQL, with a migration, a table and a sweep to maintain |

The third being the only correct one, and being a re-derivation of the thing it replaces, is the
proof. **This is the argument for §4.1, stated as its own section because #267 asked for it.**

---

## 6. Why the harness still writes no relation

Worth stating explicitly, because "the harness can now read Related links" invites "so let it create
them".

[15](../../spec/15-integrations.md) records the invariant for hierarchy: read and hydrated, **never
written**. It should extend to every link type, for reasons that are about authority rather than
capability:

- **A link is a human judgement about what two pieces of work have to do with each other.** The harness
  has no privileged view of that; it has a diff and a ticket.
- **The failure mode is un-auditable.** A wrongly-created link is invisible in the harness (nothing
  records it) and permanent in Azure until a human notices. Compare `relatedWorkNote`'s orphan
  handling, which offers candidate parents to an *agent* to name in prose and then says outright:
  "do not link, re-parent or edit any work item yourself" (`src/issueRelations.ts`) **[repo]**. That
  is the settled doctrine, and this design re-affirms it rather than re-litigating it.
- **The one place a link *is* created stays where it is**: the `raise-bug` desk job, where a human
  clicked, the agent runs `az` in the open, and the filing row records that it happened. That is a
  human action with an agent's hands, not the harness forming an opinion.

---

## 7. What an implementation would touch

Not a plan — #267 forbids implementing — but the blast radius, so a future ticket can be scoped
honestly. Roughly, in order:

| Area | Change |
| --- | --- |
| `src/types.ts` | `Issue.related?: IssueRelative[]`, documented with the tri-state contract |
| `src/integrations/azure/restAzureDevOpsApi.ts` | `relatedIds` off `System.LinkTypes.Related` in `mapWorkItem`, via the existing `hierarchyIds` (which is link-type-agnostic already — it takes the `rel` as a parameter) |
| `src/integrations/azure/workItems.ts` | Related ids join `hydrateHierarchy`'s `wanted` set; the returned mapper emits `related` |
| `src/integrations/github/octokitGitHubApi.ts` + `issues.ts` | Keep the issue-to-issue `cross-referenced` source; map to `related`, deduped |
| `src/issueRelations.ts` | One `relatedWorkNote` paragraph, phrased as scope-marking |
| `web/src/` | The lens: related items on the goal/story surface, drawn with `<Ref/>` |
| `src/wire.ts` | **Nothing** — `wire.Issue extends WorldIssue` already carries it |
| `src/store/` | **Nothing** — no table, no migration |
| `src/dispatcher/` | **Nothing** — no new rule, no `DISPATCH_PIPELINE` entry |

Specs to update **in the same change**, per the repo's one documentation rule:

- **[03 world model](../../spec/03-world-model.md#relations)** — `related` in the `Issue` table and in
  the Relations section, including its own tri-state row and the GitHub "mentioned, not declared"
  caveat. **Owns the field's contract.**
- **[15 integrations](../../spec/15-integrations.md)** — the Azure relation read beside the hierarchy
  paragraph, and the GitHub cross-reference read. Restate that writing stays out.
- **[17 cockpit](../../spec/17-cockpit.md)** — the lens; and, if half one of §3.3 is done, remove
  `bugFilings` from whatever "drawn by nothing" accounting covers it.
- **[06 issue pickup](../../spec/06-issue-pickup.md)** — only if a gate is ever added. This design adds
  none, so: **no change**.
- **[05 dispatcher](../../spec/05-dispatcher.md)** — likewise no change; noted here so a future reader
  can see that the omission was decided rather than missed.

Tests would go at the `buildSystem` seam plus unit tests for the pure parts, and — per `CLAUDE.md` —
extending a provider means adding to the `*Api` interface **and** its scripted fake in the same change.

---

## 8. Open questions

1. **Are Dependency (Predecessor/Successor) links used deliberately on the operator's board?** This is
   the only thing that would turn a rejected candidate into a recommended dispatch rule (§3.2). It is
   a question for the operator, not the code, and it should be asked before anyone builds `blockedBy`.
2. **Where exactly does the related-items lens draw** — the goal page, the backlog row, or both — and
   what does the chip say when the same bug is both a `related` link and a `bugFilings` row? #267 asks
   for the model, not the surface, so this is deliberately left to the cockpit change.
3. **Does the pinned octokit expose sub-issues?** Only matters if §2.2's hazard is ever accepted;
   recorded so the next reader does not re-derive it.
4. **Is `az boards work-item relation add` an error or a no-op on an existing link?** Marked
   **[verify]** in §1.4. It bears only on a retried `raise-bug` desk job, not on anything this design
   recommends.

---

## 9. What this document is not

- **Not a re-design of hierarchy.** Containers, orphans, the watch cascade and `relatedWorkNote` exist,
  are specified, and are cited here only as the precedent the new field follows.
- **Not the "raise issue" button.** It shipped; its design is
  [2026-08-11](2026-08-11-raise-issue-button-design.md). What is left of it is the cockpit half of
  §3.3, which is unblocked.
- **Not a design for writing relations back to Azure.** Argued against in §6 rather than designed.
- **Not a design for a `work_item_relations` table.** §5.2 is the counterfactual #267 asked for, and
  §4.2 is the reason it stays one.
