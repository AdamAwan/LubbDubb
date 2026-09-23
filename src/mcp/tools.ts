import { MCP_TOOL_NAMES, type McpToolName, toolsForRule } from './names.js';
import type { McpTool } from './protocol.js';
import { retiredTools } from './retiredTools.js';
import { buildToolContext, type McpIdentity, type McpToolDeps, type ToolFactory } from './tools/context.js';
import { appraiseIssue } from './tools/appraiseIssue.js';
import { assessIssue } from './tools/assessIssue.js';
import { concludePart } from './tools/concludePart.js';
import { concludeWork } from './tools/concludeWork.js';
import { escalate } from './tools/escalate.js';
import { featureSummary } from './tools/featureSummary.js';
import { sequenceSubmit } from './tools/sequenceSubmit.js';
import { linkTicket } from './tools/linkTicket.js';
import { noteProgress } from './tools/noteProgress.js';
import { openPr } from './tools/openPr.js';
import { planNotNeeded } from './tools/planNotNeeded.js';
import { planCorrect } from './tools/planCorrect.js';
import { planSubmit } from './tools/planSubmit.js';
import { raise as raiseFact } from './tools/raise.js';
import { reportRemedy } from './tools/reportRemedy.js';
import { replyToReview } from './tools/replyToReview.js';
import { requestHumanTask } from './tools/requestHumanTask.js';
import { requestPermission } from './tools/requestPermission.js';
import { retroSubmit } from './tools/retroSubmit.js';
import { reviewReport } from './tools/reviewReport.js';
import { reviewRoute } from './tools/reviewRoute.js';
import { splitAssess } from './tools/splitAssess.js';
import { prDescribe } from './tools/prDescribe.js';
import { scratchAppend } from './tools/scratchAppend.js';
import { scratchRead } from './tools/scratchRead.js';
import { validationAmend } from './tools/validationAmend.js';
import { validationPlan } from './tools/validationPlan.js';
import { validationReport } from './tools/validationReport.js';
import { remoteValidationReport } from './tools/remoteValidationReport.js';
import { remoteValidationListing } from './tools/remoteValidationListing.js';
import { localValidationPlan } from './tools/localValidationPlan.js';
import { localRunRead } from './tools/localRunRead.js';
import { localValidationReport } from './tools/localValidationReport.js';
import { watchDeclare } from './tools/watchDeclare.js';
import { stateDeclare } from './tools/stateDeclare.js';
import { worldRead } from './tools/worldRead.js';

// → docs/spec/11-mcp-tools.md

const TOOLS: Record<McpToolName, ToolFactory> = {
  plan_submit: planSubmit,
  plan_correct: planCorrect,
  plan_not_needed: planNotNeeded,
  escalate,
  world_read: worldRead,
  request_human_task: requestHumanTask,
  note_progress: noteProgress,
  request_permission: requestPermission,
  link_ticket: linkTicket,
  conclude_work: concludeWork,
  assess_issue: assessIssue,
  conclude_part: concludePart,
  appraise_issue: appraiseIssue,
  scratch_append: scratchAppend,
  scratch_read: scratchRead,
  retro_submit: retroSubmit,
  feature_summary: featureSummary,
  sequence_submit: sequenceSubmit,
  open_pr: openPr,
  reply_to_review: replyToReview,
  validation_amend: validationAmend,
  validation_plan: validationPlan,
  validation_report: validationReport,
  remote_validation_report: remoteValidationReport,
  remote_validation_listing: remoteValidationListing,
  local_validation_plan: localValidationPlan,
  local_run_read: localRunRead,
  local_validation_report: localValidationReport,
  watch_declare: watchDeclare,
  state_declare: stateDeclare,
  review_report: reviewReport,
  review_route: reviewRoute,
  split_assess: splitAssess,
  pr_describe: prDescribe,
  report_remedy: reportRemedy,
  raise: raiseFact,
};

export function buildTools(deps: McpToolDeps, identity: McpIdentity): McpTool[] {
  const ctx = buildToolContext(deps, identity);
  const advertised = toolsForRule(identity.task.rule ?? null);
  return [
    ...MCP_TOOL_NAMES.map((name) => ({
      name,
      ...TOOLS[name](ctx),
      ...(advertised.has(name) ? {} : { hidden: true }),
    })),
    ...retiredTools(),
  ];
}
