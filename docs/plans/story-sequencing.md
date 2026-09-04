# Build plan — story sequencing

The staged order [33 — Story sequencing](../spec/33-story-sequencing.md) gets built in. **Delete this
file in the change that finishes stage 4**, and remove the "not yet built" marker at the top of the
spec in the same change — a spec still marked unbuilt after its code has landed is the failure that
convention has instead of the one it replaced (`docs/README.md`).

Each stage lands on its own, passes `npm run check`, and leaves the harness working. The marker at
the top of the spec stays until the last one; the sections each stage makes true have their paths
moved from italic to backticked as they land, which `test/docsReferences.test.ts` then holds.

## Stage 0 — read the order somebody already drew — **landed**

The whole gate, on human-authored edges only. No agent, no proposal, no approval — and therefore no
inference to be wrong about. This is the stage that is worth having even if nothing after it is
built.

1. **`Issue.dependsOn`** on the domain type (`src/types.ts`) and the wire type (`src/wire.ts`), a
   `IssueRelative[] | undefined` beside `parent` / `children` / `siblings`. `undefined` means the
   provider tracks no dependencies.
2. **A third hydration pass** in `src/integrations/azure/workItems.ts`, resolving
   `System.LinkTypes.Dependency-Forward` / `-Reverse` alongside the existing `Hierarchy` pass.
   Extend `AzureDevOpsApi` **and** its scripted fake in the same change.
   `FakeIssuesIntegration` grows a way to script links.
3. **`sequenceReadiness`** in _src/sequence/readiness.ts_, pure over edges plus the world, reusing
   `dependencySatisfied`'s rule from `src/plans/parts.ts` (settled, or in flight with a branch
   pushed).
4. **The hold**: `'sequenced'` added to `HeldReason` (`src/dispatcher/admission.ts`); readiness
   computed once in `RuleDispatcher`'s context assembly beside `routes` and `eligibleIssues`, and put
   on `StageContext`; `issue-pickup` and `issue-plan` push `held: 'sequenced'` with the reason naming
   what it waits behind, outside `consider`.
5. **`issueSequencing`** in `src/config.ts` / `src/configFields.ts`, default `off`. Stage 0 ships
   `off` and `links` only; `full` arrives with stage 1.
6. **The override**: a flagged or dragged origin clears the hold
   (`src/dispatcher/priorityOverride.ts`, `src/dispatcher/goalPriority.ts`).

Tests: `test/storySequencing.test.ts`, at the `RuleDispatcher` seam beside the queue's other held
reasons — a held story is queued and not dispatched; it dispatches once the predecessor pushes a
branch; every fail-open arm dispatches everything; a flag and a drag each clear the hold and only
that hold; `linkEdges` / `sequenceReadiness` / `sequenceHoldReason` as pure unit tests.

Three things landed differently from what is written above, each on purpose:

1. **The dependency read rides in the hierarchy pass's batch**, not a third round of its own — a
   dependency is nearly always a sibling already being fetched, so it costs no request.
2. **`issueSequencing` sits on `IssuePickupPolicy`**, not on `RuleDispatcher`'s constructor. It is a
   pickup gate like every other field there, and the constructor already takes fourteen positional
   arguments.
3. **The `FakeIssuesIntegration` scripting was not built.** The tests drive `RuleDispatcher`
   directly, which is where the other held reasons are asserted and needs no fake; adding a provider
   API nothing exercises would be a seam with no reader. Stage 1's sequencer, which does need a
   whole system, is where it earns its place.

The override clears the hold in `decide`, after `expeditedOrigins` and the drag ranks are resolved
and before `rankByPriorityOverride` — that function still clears no hold, which is its own contract.

Spec sections this makes true: [the tracker's own links](../spec/33-story-sequencing.md#the-trackers-own-links),
[readiness and the hold](../spec/33-story-sequencing.md#readiness-and-the-hold), most of
[fail open](../spec/33-story-sequencing.md#fail-open), [precedence](../spec/33-story-sequencing.md#precedence).

> **The decision to take before stage 1.** Stage 0 tells us whether the boards this harness runs
> against carry dependency links at all. If they largely do, stage 1 is optional and the sequencer
> may not be worth its spend. Look at the answer before building it.

## Stage 1 — the record and the sequencer — **landed**

1. **`src/store/sequences.ts`** — `feature_sequences` and `feature_sequence_edges`. Both new, so
   `CREATE TABLE IF NOT EXISTS` is sufficient; no `ColumnMigrations` entry is owed. Threaded through
   `src/system.ts`.
2. **`featureSequenceKey`** in `src/sequence/sequence.ts` — digests the set of watched, unsettled
   children plus the provider's edges. Pure, unit-tested, and deliberately **not** the summary's key.
3. **Rule `feature-sequence`** — `src/dispatcher/rules/featureSequence.ts`, registered in `STAGES`
   and given a `DISPATCH_PIPELINE` entry beside `feature-summary` at the bottom. Origin
   `issue:<n>:sequence`, classified in `src/issueOrigins.ts`. Desk agent, no branch, no worktree,
   fails open and silent.
4. **The prompt** — a new `PromptId` (`feature-sequence`) in `src/dispatcher/promptTemplates.ts`. The
   children, their types and the Feature's description are **appended** to the rendered prompt
   (`src/sequence/dossier.ts`), never interpolated. **No `docs/prompt-templates/` copy**: that
   directory holds thirteen of the thirty-odd prompts and `feature-summary` — the rule this one is a
   copy of — is not among them, so adding one here would be a sample of one new prompt in a folder
   whose README already overstates its coverage. Worth fixing; not worth fixing in this change.
5. **`sequence_submit`** — `src/mcp/tools/sequenceSubmit.ts`, named in `buildTools` **and**
   `MCP_TOOL_NAMES` (`src/mcp/names.ts`), authorised structurally against the caller's origin.
   Rejects a cycle, naming it, and stores nothing.
6. **Edges written as a set**, never merged, and `issueSequencing: full` switched on.

Tests: `test/featureSequence.test.ts` — the key changes when a child is added, when a Predecessor
link appears, and **not** when a child merges; a cycle, a self-edge and a story the Feature does not
have are each refused with nothing stored; a `proposed` and a `declined` sequence hold nothing and an
`accepted` one holds; a declined order holds the sequencer off until the Feature gains a story; an
order is rewritten as a set and a rewrite drops the answer.

Four things landed differently from the list above:

1. **The key digests every watched child, settled ones included.** Digesting the open ones would
   re-propose on every merge, which is the summary's behaviour and the one this key exists not to
   have. `FeatureGroup.members` is that set; `children` is the open ones the prompt is about.
2. **Two Features are never asked about**: one with a single story (an order is a question with one
   arm) and one above the cap. Neither was in the plan and both are pure spend.
3. **The answer route came forward from stage 2.** A stage has to leave the harness working, and an
   order nobody can accept is a mechanism that cannot do the thing it was built for.
   `POST /api/features/:number/sequence`, schema in `src/sequence/answer.ts` beside the rule that
   owns it. It takes `accepted` and `declined` and refuses `proposed`.
4. **`waveOf` was not written.** Waves are a cockpit vocabulary and the cockpit is stage 2; a helper
   nothing calls is a helper nothing checks.

## Stage 2 — the cockpit — **landed**

Stage 1 brought the answer **route** forward; what is left here is everything a person looks at.
`waveOf` — depth in the edge graph, longest path, `partDepth`'s rule — is written here, where its
first reader is.

1. **Wire** — the sequence on the feature board payload and on the goal page payload (`src/wire.ts`),
   waves derived on read.
2. **Feature page** (`web/src/components/FeatureBoard.tsx`) — the wave rail grouping the children
   list that is already there, not a second list. Provenance mark per edge.
3. **The proposal card** — order, reason, what it was unsure about, what accepting costs; accept /
   discuss / decline.
4. **Goal page** (`web/src/console/GoalPage.tsx`) — the copy, folded shut. The folded reading
   carries the whole point: the wave, and how many goals wait on this one.
5. **Tokens** — any new tint on `:root` and in `web/src/cockpit/tokens.ts`; no colour literal at a
   use site.

Landed with three departures:

1. **No new token.** The proposal card wears the amber family already on `:root` — this cockpit’s
   "awaiting you", the same tone the watch digest and the signals card use for a declaration nobody
   has ruled on. A new tint would have been a sixth family for one card.
2. **The wave list is `HeadRow`s, not an `ol`.** `test/cockpitTheme.test.ts` refuses a twelfth
   hand-written head row, and the wave row is one; using the component is the fix rather than
   restyling around the assertion.
3. **The Goal page reads the snapshot, not `/api/features`.** That page is assembled client-side
   from `AppState`, so the order rides on the state snapshot as `featureSequences`. The Feature
   board keeps its own fetched copy.

The mockup the surfaces were designed against is a design canvas published from this session; it is
not in the tree and is not a reference — the spec's [cockpit
section](../spec/33-story-sequencing.md#the-cockpit) is.

## Stage 3 — amending

1. **`sequence_amend`** and **`sequence_read`** in `src/mcp/desktopTools.ts` / `DESKTOP_TOOL_NAMES`,
   never `buildTools`.
2. **The `Discuss…` link** on the Feature card, `web/src/components/DesktopLink.tsx`, with a prompt
   that resolves the Feature and ends by calling `sequence_amend`.

## Stage 4 — close it out

1. Remove the **not-yet-built marker** from the top of `docs/spec/33-story-sequencing.md`, and move
   every remaining italic path in it to backticks.
2. Add the sharp edge to `CLAUDE.md` — **a sequence hold must fail open**, since a hold that
   survives a missing or unreadable sequence parks a whole Feature with nothing red, which is
   exactly the genre that file holds.
3. Pointers into 33 from [06](../spec/06-issue-pickup.md) (the gate), [08](../spec/08-planning.md)
   (a sequence is not a plan) and [17](../spec/17-cockpit.md) (the two surfaces).
4. A row in `docs/feature-timeline.md`.
5. **Delete this file.**
