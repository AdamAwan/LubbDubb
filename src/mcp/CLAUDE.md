# CLAUDE.md — `src/mcp/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## The tool channel

- **A tool added to `buildTools` must also be named in `MCP_TOOL_NAMES` _and_ placed in `UNIVERSAL_TOOLS` or a `RULE_TOOLS` row (`src/mcp/names.ts`).** The server id, the tool
  names and the `mcp__<key>__<tool>` grants must agree; and an unplaced tool is granted, built and callable but in no agent's `tools/list` — named by a prompt, advertised to nobody, with `toolsForRule` failing open so nothing catches it. → [11](../../docs/spec/11-mcp-tools.md#launch-flags), [advertised to whom](../../docs/spec/11-mcp-tools.md#which-tools-an-agent-is-advertised)
- **There are two channels, and `validation_report` is a tool on both.** The fleet's is
  `src/mcp/tools/validationReport.ts`; the operator's own Claude Code gets `src/mcp/desktopTools.ts`
  (`DESKTOP_TOOL_NAMES`, never `buildTools`). Editing one leaves the other on the old behaviour.
  → [11](../../docs/spec/11-mcp-tools.md#the-desktop-channel)
