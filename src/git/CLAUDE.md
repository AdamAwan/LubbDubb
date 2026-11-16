# CLAUDE.md — `src/git/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Git and worktrees

- **`resolveCommit` prefers `origin/<ref>` over the local ref** and returns a SHA, because the
  harness's clone never checks the integration branch out. `GitObserver` methods stay read-only and
  fetch-free.
