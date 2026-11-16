# CLAUDE.md — `src/agents/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Agent runtimes

- **A new agent-termination path must reap the process _subtree_, before it signals the child.**
  `session.kill()` does this via the injected `ProcessReaper`; a direct `kill` leaves the agent's
  shells holding the worktree as cwd, and every later dispatch onto that branch fails `EBUSY`,
  forever. Reaping _after_ the child dies finds nothing.
  → [10](../../docs/spec/10-agent-runtimes.md#reaping-the-process-subtree)
- **A launch carries `--session-id` _or_ `--resume`, never both** — lint keeps them inside `appendSessionFlags`.
  → [10](../../docs/spec/10-agent-runtimes.md#launch-arguments)
- **A mid-run crash re-attaches through `AgentManager.resume`, which must be handed a torn-down
  agent.** `resume` was written for boot: for an agent still in `sessions` it returns a silent
  success and overwrites the spool key and MCP token, leaking a spool dir and leaving a **bearer
  credential live** with nothing to revoke it. Drop the session, `disposeFileEvents` and
  `releaseMcp` first. → [10](../../docs/spec/10-agent-runtimes.md#auto-resume-on-a-mid-run-crash)
- **A _re-dispatch_ re-attaches through `spawn`'s `resumeSessionId`, never `resume`.** It writes a
  new agent row, so there is nothing to tear down; two agent rows sharing one `sessionId` is the
  _correct_ shape here. → [10](../../docs/spec/10-agent-runtimes.md#inheriting-a-conversation-on-re-dispatch)
- **`agentMode` is `stream` or `raw`, and only `stream` runs a model.** `raw` is the mock agent and
  what nearly every test drives, so a change asserted only there has not been asserted against a
  model. → [10](../../docs/spec/10-agent-runtimes.md#the-session-contract)
- **The account's 5h/weekly windows are read off `rate_limit_event` beside the park, by a second
  function that must stay one.** It fires on **every ordinary turn**, so folded into `rateLimitPark`
  it is one edit from parking the fleet on a reading that says there is room. Freshest wins by
  `capturedAt`, not arrival. → [10](../../docs/spec/10-agent-runtimes.md#the-account-usage-windows)

## Agent launch and the tool channel

- **Do not allow-list Bash via `claudeArgs: ["--allowedTools", …]`.** Operator args are appended
  last, so it wins over the harness's and silently drops the `mcp__lubbdubb__*` grants. Use
  `agentAllowedTools`, which rides in `--settings`.
- `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root.
  `agentAllowedTools` plus the permission backstop complete a task unattended under `acceptEdits`.
