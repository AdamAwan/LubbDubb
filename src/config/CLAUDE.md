# CLAUDE.md — `src/config/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Config layers

- **A config layer carries only what its file said.** `mergeLayers` never folds `DEFAULTS` in; that
  happens once, in `mergeConfig`. A layer that arrives dense does not merge, it replaces — and
  shadows the project file with a policy no file on the machine states.
  → [02](../../docs/spec/02-configuration.md#precedence)
