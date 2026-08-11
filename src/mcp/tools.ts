import { MCP_TOOL_NAMES, type McpToolName } from './names.js';
import type { McpTool } from './protocol.js';
import { buildToolContext, type McpIdentity, type McpToolDeps, type ToolFactory } from './tools/context.js';
import { assayIssue } from './tools/assayIssue.js';
import { assessIssue } from './tools/assessIssue.js';
import { concludePart } from './tools/concludePart.js';
import { concludeWork } from './tools/concludeWork.js';
import { escalate } from './tools/escalate.js';
import { linkTicket } from './tools/linkTicket.js';
import { noteProgress } from './tools/noteProgress.js';
import { openPr } from './tools/openPr.js';
import { planSubmit } from './tools/planSubmit.js';
import { reportFinding } from './tools/reportFinding.js';
import { requestHumanTask } from './tools/requestHumanTask.js';
import { requestPermission } from './tools/requestPermission.js';
import { retroSubmit } from './tools/retroSubmit.js';
import { scratchAppend } from './tools/scratchAppend.js';
import { scratchRead } from './tools/scratchRead.js';
import { worldRead } from './tools/worldRead.js';

/**
 * The tool set, as a registry keyed on the names `names.ts` declares.
 *
 * Each entry is a module under `tools/` — one tool's description, schema and
 * handler in a file you can read end to end — and this is the whole of the
 * assembly, the way `DISPATCH_PIPELINE` + `STAGES` is for the dispatch rules and
 * for the same stated reason. The growth axis for "add a tool" used to be one
 * 844-line function whose scope every tool shared.
 *
 * **Keying on the name rather than listing factories is what keeps `names.ts`
 * honest.** `Record<McpToolName, …>` makes a name with no module a compile error
 * and a module under a name that is not granted impossible to reach, so the
 * "connected server whose every call is refused" trap — a name in `buildTools`
 * that `--allowedTools` never granted — cannot be reintroduced by a module
 * naming itself. A tool module therefore does not carry its own name at all.
 */
const TOOLS: Record<McpToolName, ToolFactory> = {
  plan_submit: planSubmit,
  escalate,
  world_read: worldRead,
  report_finding: reportFinding,
  request_human_task: requestHumanTask,
  note_progress: noteProgress,
  request_permission: requestPermission,
  link_ticket: linkTicket,
  conclude_work: concludeWork,
  assess_issue: assessIssue,
  conclude_part: concludePart,
  assay_issue: assayIssue,
  scratch_append: scratchAppend,
  scratch_read: scratchRead,
  retro_submit: retroSubmit,
  open_pr: openPr,
};

/**
 * Build the tool set for one resolved caller.
 *
 * **Identity is structural, not argued.** No tool takes an agent, task, or issue
 * argument — every one of them is derived from the credential the call arrived
 * on. An agent working origin A therefore cannot address origin B by asking
 * nicely, which is the property the `plan.json` side channel had to approximate
 * with `planOriginIssue` fencing over a transport that carried no identity at all.
 * The caller reaches a tool body on its context, never in `args`.
 *
 * The order is `MCP_TOOL_NAMES`', which is the order `tools/list` advertises.
 */
export function buildTools(deps: McpToolDeps, identity: McpIdentity): McpTool[] {
  const ctx = buildToolContext(deps, identity);
  return MCP_TOOL_NAMES.map((name) => ({ name, ...TOOLS[name](ctx) }));
}
