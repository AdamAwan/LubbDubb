# CLAUDE.md — `src/system/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Pulse order

- **`DeliveryCloseOutDesk` runs below `ValidationReadyDesk` in the pulse**, because it holds the
  close while the goal's `validate` row is open. Above it, both arrive together.
  → [24](../../docs/spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time)
