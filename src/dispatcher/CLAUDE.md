# CLAUDE.md — `src/dispatcher/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Dispatch

- **A new agent-dispatch rule must route through the candidate list.** An inline `raw.push` of a
  `dispatch_*` action bypasses both the headroom cut and the Up next queue. Adding a rule is a
  `DISPATCH_PIPELINE` entry in the position it should run, and a module under
  `src/dispatcher/rules/` registered in `STAGES` under that id. → [05](../../docs/spec/05-dispatcher.md#the-rule-book)
- **Pipeline order is load-bearing state.** `issue-appraisal` and `issue-investigate` write
  `appraising` / `investigating` on the `StageContext` for later stages to read. Moving one below its readers silently puts two agents on one issue.
- **The investigate label is applied once, when the appraisal asks, and never reconciled.** The appraiser's flag rides only on the `appraisal` event; storing it for a sweep to re-apply silently overrules the operator who took the label off — removing it is their _no_. → [38](../../docs/spec/38-bug-investigation.md#the-label)
- **Lenses stay out of `src/dispatcher/`** (asserted structurally) — fix the file a failure names, not the assertion.
