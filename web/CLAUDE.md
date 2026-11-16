# CLAUDE.md — `web/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Cockpit

- **A new colour is a `:root` token registered in `web/src/cockpit/tokens.ts`** (a derived tint in `tokenTints.ts`);
  `test/cockpitTheme.test.ts` refuses a literal anywhere else. → [17](../docs/spec/17-cockpit.md#tokens)
- **A reference is drawn with `<Ref to={ref}/>` (`web/src/components/refs.tsx`), never as text.** A
  surface that names a goal or PR with no way there is a dead end that renders correctly. A
  reference **never goes inside a button**: draw the name as the control and the refs beside it in a
  `cn-refs` group. → [17](../docs/spec/17-cockpit.md#links)
- **A dispatch origin is read through `standsFor` before it is drawn or routed on.** A crash
  recovery's requeue is dispatched at `job:<id>` and keeps the work it redoes on `Job.originRef`, so a
  surface reading `task.originRef` literally draws an opaque job id — and, silently, `goalOfOrigin`
  answers null, which leaves the goal whose work is out on the fleet reading as unstaffed.
  → [17](../docs/spec/17-cockpit.md#a-job-origin-stands-in-for-other-work), [13](../docs/spec/13-jobs-and-tickets.md#standing-in-for-another-origin)
- **A new piece of "where am I" state goes on `Place` (`web/src/cockpit/place.ts`), never a
  `useState` in `useCockpit`.** The cockpit's place is the query string; state held outside it
  breaks on the back button and on reload. → [17](../docs/spec/17-cockpit.md#the-address-bar)
