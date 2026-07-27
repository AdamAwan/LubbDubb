# Cockpit skins — design

**Date:** 2026-07-27
**Status:** approved, phase 1 in progress

## The problem

`web/src/App.tsx` is 853 lines doing three unrelated jobs: acquiring state (fetch +
websocket + coalesced refresh), deriving view state from it (`liveAgents`,
`crashedAgents`, `openEscalations`, `flagsByAgent`, the heartbeat maths), and rendering
the entire layout. A second visual treatment only wants to replace the third, and today
cannot touch it without dragging the other two along. The derivation is also untestable
where it sits — it is a pure function trapped inside a component.

So a skin is the forcing function, but the split is worth doing on its own merits.

## What a skin is

**A skin owns its whole layout.** It is a root component handed a finished view-model and
renders whatever tree it likes — its own topbar, its own arrangement, its own panels. It is
not a set of overrides on a shared page, because the treatments worth having are not
rearrangements of the current one: a Factorio-style production line draws the queue as a
belt feeding assembler bays, which is a different drawing of the same data, not a different
order of the same components.

The cost of that freedom is duplication, bounded by the shared/skinned split below.

## Layers

| Layer        | Path                            | Job                                                                                                      |
| ------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Wiring       | `web/src/cockpit/useCockpit.ts` | fetch, websocket, coalesced refresh, selection, auth refusal. Returns `{view, actions, status}`. No JSX. |
| Derivation   | `web/src/view/viewModel.ts`     | pure `buildViewModel(...)` → `CockpitView`. No React.                                                    |
| Presentation | `web/src/skins/<id>/`           | one directory per skin, registered in `skins/registry.ts`.                                               |

`App.tsx` becomes ~20 lines: call the hook, look up the skin, render its root.

## The contract

```ts
interface Skin {
  id: SkinId;
  label: string;
  Root: (p: SkinProps) => JSX.Element;
}
interface SkinProps {
  view: CockpitView;
  actions: CockpitActions;
}
```

`CockpitView` is plain data — no functions, no promises. `CockpitActions` is every mutation,
pre-bound and returning promises.

**Skins never import `api.js`.** This is the load-bearing rule: it is what stops one skin
quietly growing a capability another lacks, and what keeps every mutation in a list the
whole cockpit shares. Enforced structurally by a test that walks `skins/` and asserts the
import is absent — the same shape as the single-importer assertion in
`test/prAttention.test.ts`, and for the same reason: an import-graph property nobody
remembers to check is a property that decays.

## Shared vs skin-owned

The line is **behaviour weight**, not visual prominence.

**Shared** (`web/src/components/`) — anything with an async flow, a refusal rule, or hold
semantics. `AgentDrawer`, `EscalationCard`, `RecoveryPanel`, `InjectPanel`, `LaunchPanel`,
`FindingsPanel`, `PlanPanel`, `AsyncButton`, `ConfirmButton`, plus the leaf helpers both
sides need (`util`, `FlagChips`, `FilesList`, `UsageChip`). The escalation 409 rules and the
recovery verdicts get exactly one implementation, forever.

**Skin-owned** (`web/src/skins/<id>/`) — anything that draws over data it was handed.
`AgentCard`, `UpNext`, `Vitals`, `DecisionLog`, `ActivityFeed`, `OverlapPanel`,
`ErrorsPanel`, the chip helpers currently at the bottom of `App.tsx`, `WorldSummary`, and
the topbar.

`UpNext` is the interesting one: it carries the reorder drag, which is a mutation, and it is
also exactly what a Factory skin replaces with a belt. Resolved by putting the _call_ in
`CockpitActions` and leaving only the drag UI skin-side, so a skin can implement dragging
differently, or not at all, without touching the priority-override write.

## Tokens

Tokens are **the styling contract for shared components**, which is narrower than the usual
meaning. A skin may write whatever CSS it likes for its own markup. Tokens exist so that the
one `AgentDrawer` and the one `EscalationCard` can look native in every skin.

So: **shared components style themselves only through tokens; skins define the tokens.**

The vocabulary that requires:

- colour — today's 12, plus the ~45 values currently hardcoded outside `:root` (they are all
  tints of the semantic colours: `#4d3a12` is an amber line, `#3a1420` a dark accent).
- `--r-sm | --r-md | --r-lg | --r-pill` — radius. The one non-colour token that actually
  blocks a skin: a square-cornered treatment is unreachable by palette alone.
- `--font-ui | --font-mono | --font-display`.
- `--border-hi` / `--border-lo` — so a four-sided bevel is expressible. Classic points both
  at today's `--border`, which makes that refactor a provable no-op.

Each skin ships `skins/<id>/skin.css`, all bundled, scoped under `[data-skin="<id>"]`.

## Selection

`localStorage['lubbdubb.skin']`, stamped onto `<html data-skin>` by a small inline script in
`index.html` before first paint so there is no flash, and read by React for the registry
lookup. An unknown or missing id falls back to Classic silently — a bad stored value must
not be an error screen.

**Deliberately not in `Config` or `/api/state`.** It is a per-viewer preference; shipping it
in the snapshot would make one operator's taste global to every cockpit and buy a route, a
column and a migration for nothing.

## Testing

- **`buildViewModel` unit tests** — new coverage, since none of this derivation is testable
  today.
- **Structural** — no file under `skins/` imports `api.js`.
- **Conformance** — every registered skin renders against `web/src/demo/fixtures.ts` without
  throwing. A skin added later is asserted on the day it is written.
- **Classic markup golden** — `renderToStaticMarkup(<ClassicRoot …/>)` over the demo
  fixtures, committed as a snapshot. `react-dom` is already a devDependency and
  `test/ansi.test.ts` / `test/worldBuckets.test.ts` are precedent for testing web modules
  from the root suite, so this needs no jsdom and no new dependency.

Stated limits of the golden: it proves the _static tree_ is unchanged, not that effects and
handlers are, and it says nothing about CSS. The CSS half is covered by moving rules verbatim
and only adding token indirection whose resolved values are identical. The golden's durable
value is forward-looking — it fails on any later change that alters Classic's markup.

## Out of scope

- The Factory skin. Lands as a separate change on a proven seam.
- New snapshot fields. A skin renders what `/api/state` already carries; a skin wanting new
  data is an ordinary server change.
- Third-party or user-authored skins. In-repo only, so the contract can churn freely and
  knip keeps the registry honest.
- Light/dark within a skin.

## Consequences

- `docs/spec/17-cockpit.md` is updated in the same change.
- knip: the registry is what imports each skin, so skins stay reachable. A skin directory
  nothing registers is correctly reported as dead.
