# CLAUDE.md — `src/worktree/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Git and worktrees

- **`WorktreeManager.ensure(branch, base)` is reuse-first**: an existing worktree or local branch is
  handed back and `base` is ignored. An unresolvable `base` throws rather than falling back to HEAD.
  → [09](../../docs/spec/09-execution.md#worktrees)
- **A slot handed to a _different_ branch is swept of live processes, then wiped `git clean -ffdx`.**
  A weaker wipe hands another branch's `dist/` on as the agent's own output; an unswept one leaves a mapped
  image Windows cannot unlink, and a refused wipe condemns it. → [09](../../docs/spec/09-execution.md#handing-a-slot-over)
- **`ensure` grows the pool before it evicts a free slot still on a branch.** Evicting early burns
  the tree a CI fix on that branch would have come back to; every re-dispatch then pays a cold
  install, which nothing measures. → [09](../../docs/spec/09-execution.md#worktrees)
- **The lease is the only thing keeping two agents out of one directory.** Anything that hands out
  a slot goes through `WorktreeManager.ensure`; anything that frees one goes through `remove` /
  `deleteBranch`. → [09](../../docs/spec/09-execution.md#the-lease)
- **The pool bound is `RuntimeControl.cap` plus slack, read by reference on every `ensure`.**
  Snapshot it at boot and every dispatch above the lower number is refused for want of a directory
  and retried forever — a full "Up next" queue, an idle fleet, nothing red. A stranded slot with
  uncommitted changes is reclaimed only at `acquire`'s dead end, only when nothing holds it, and only
  after stashing the work to `refs/lubbdubb/salvage/…`. → [09](../../docs/spec/09-execution.md#exhaustion)
- **The local run's checkout must stay outside `worktreeRoot`.** `slots()` counts every registered
  worktree under that root, so a preview checkout in there is a pool slot: handed to an agent and
  wiped. `localRunRoot` is separate, and only `ensurePreview` touches it.
  → [23](../../docs/spec/23-local-runs.md#the-checkout)
