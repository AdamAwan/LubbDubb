// → docs/spec/11-mcp-tools.md

import type { DispatchRuleId } from '../dispatcher/rules.js';

export const MCP_SERVER_ID = 'lubbdubb';

export const MCP_TOOL_NAMES = [
  'plan_submit',
  'plan_correct',
  'plan_not_needed',
  'escalate',
  'world_read',
  'request_human_task',
  'note_progress',
  'request_permission',
  'link_ticket',
  'conclude_work',
  'assess_issue',
  'conclude_part',
  'appraise_issue',
  'scratch_append',
  'scratch_read',
  'retro_submit',
  'feature_summary',
  'sequence_submit',
  'open_pr',
  'reply_to_review',
  'validation_amend',
  'validation_plan',
  'validation_report',
  'remote_validation_report',
  'remote_validation_listing',
  'local_validation_plan',
  'local_run_read',
  'local_validation_report',
  'watch_declare',
  'state_declare',
  'review_report',
  'review_route',
  'split_assess',
  'pr_describe',
  'report_remedy',
  'raise',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const TOOL_NAMING: Record<McpToolName, 'addendum' | 'point-of-use'> = {
  raise: 'addendum',
  escalate: 'addendum',
  plan_correct: 'addendum',
  world_read: 'addendum',
  open_pr: 'addendum',
  note_progress: 'addendum',
  request_human_task: 'addendum',
  plan_submit: 'point-of-use',
  reply_to_review: 'point-of-use',
  link_ticket: 'point-of-use',
  plan_not_needed: 'point-of-use',
  conclude_work: 'point-of-use',
  conclude_part: 'point-of-use',
  assess_issue: 'point-of-use',
  appraise_issue: 'point-of-use',
  retro_submit: 'point-of-use',
  feature_summary: 'point-of-use',
  sequence_submit: 'point-of-use',
  scratch_append: 'point-of-use',
  scratch_read: 'point-of-use',
  validation_report: 'point-of-use',
  remote_validation_report: 'point-of-use',
  remote_validation_listing: 'point-of-use',
  local_validation_plan: 'point-of-use',
  local_run_read: 'point-of-use',
  local_validation_report: 'point-of-use',
  review_report: 'point-of-use',
  review_route: 'point-of-use',
  split_assess: 'point-of-use',
  pr_describe: 'point-of-use',
  validation_amend: 'point-of-use',
  validation_plan: 'point-of-use',
  watch_declare: 'point-of-use',
  state_declare: 'point-of-use',
  report_remedy: 'point-of-use',
  request_permission: 'point-of-use',
};

export const UNIVERSAL_TOOLS: readonly McpToolName[] = [
  'raise',
  'escalate',
  'plan_correct',
  'world_read',
  'open_pr',
  'request_human_task',
  'note_progress',
  'request_permission',
  'scratch_append',
  'scratch_read',
  'validation_amend',
];

export const RULE_TOOLS: Record<DispatchRuleId, readonly McpToolName[]> = {
  'manual-job': MCP_TOOL_NAMES,
  'local-validation': ['local_validation_plan', 'local_run_read', 'local_validation_report'],
  'local-validation-fix': [],
  'obstacle-repair': [],
  'pr-review-triage': ['review_route'],
  'pr-split': ['split_assess'],
  'pr-describe': ['pr_describe'],
  'pr-review': ['review_report', 'reply_to_review'],
  'pr-review-comment': ['report_remedy', 'reply_to_review'],
  'pr-ci-failing': ['report_remedy'],
  'pr-ci-blocked': [],
  'pr-ci-gate': [],
  'pr-base-update': [],
  'pr-base-update-conflict': [],
  'pr-merge-ready': [],
  'work-item-in-progress': [],
  'work-item-in-review': [],
  'work-item-back-to-pickup': [],
  'issue-appraisal': ['appraise_issue'],
  'issue-plan': ['plan_submit', 'plan_not_needed'],
  'issue-assess': ['assess_issue', 'validation_plan'],
  'issue-shortfall': [],
  'issue-retro': ['retro_submit'],
  'plan-approval': [],
  'plan-amendment': [],
  'plan-blocked': [],
  'plan-part': ['conclude_part', 'watch_declare', 'state_declare'],
  'issue-pickup': ['conclude_work', 'watch_declare', 'state_declare'],
  'validation-plan': ['validation_plan'],
  'validation-plan-approval': [],
  'validate-check': ['validation_report'],
  'remote-validation': ['remote_validation_listing', 'remote_validation_report'],
  'validation-failed': [],
  'feature-summary': ['feature_summary'],
  'feature-sequence': ['sequence_submit'],
  'branch-notify': [],
  'cooldown-escalate': [],
  idle: [],
};

export function toolsForRule(rule: string | null): ReadonlySet<McpToolName> {
  if (rule === null || !Object.hasOwn(RULE_TOOLS, rule)) return new Set(MCP_TOOL_NAMES);
  return new Set([...UNIVERSAL_TOOLS, ...RULE_TOOLS[rule as DispatchRuleId]]);
}

export const RETIRED_TOOL_NAMES: readonly string[] = [
  'report_finding',
  'knowledge_propose',
  'knowledge_notice',
  'knowledge_contradict',
  'knowledge_ask',
  'review_pack_submit',
  'review_pack_check',
];

const REVIEW_PACK_TOOLS: readonly string[] = ['review_pack_submit', 'review_pack_check'];

export function retiredToolMessage(name: string): string {
  if (REVIEW_PACK_TOOLS.includes(name)) {
    return (
      `${name} has been retired: review packs were removed from the harness, and nothing replaces them. ` +
      'There is nothing to hand back. If you reached this from a prompt that named it, that prompt is out of date.'
    );
  }
  return (
    `${name} has been retired. Everything it did is now one call: raise(what, why_not_mine) — say what ` +
    'you hit and why it is not your own change doing, and the harness works out the rest. **The call ' +
    'is the lookup**: it comes back with whether anybody else has hit it, who owns it if anyone does, ' +
    'and what they saw. There is no search tool; call raise the moment you are in pain. If you reached ' +
    'this from a prompt that named it, that prompt is out of date.'
  );
}

export const ALLOWED_MCP_TOOLS: string[] = MCP_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_ID}__${name}`);

export function extraMcpGrants(servers: readonly { key: string }[]): string[] {
  return servers.map((server) => `mcp__${server.key}`);
}

export const DESKTOP_TOOL_NAMES = [
  'goal_read',
  'fleet_status',
  'fleet_control',
  'attention_read',
  'escalation_answer',
  'human_task_settle',
  'agent_read',
  'queue_control',
  'goal_control',
  'goal_gate',
  'goal_placement',
  'goal_instruct',
  'proposal_read',
  'proposal_decide',
  'recovery_decide',
  'job_create',
  'ticket_target',
  'agent_control',
  'ejection_read',
  'ejection_note',
  'ejection_settle',
  'validation_read',
  'validation_claim',
  'validation_report',
  'plan_read',
  'plan_amend',
  'sequence_read',
  'sequence_amend',
  'local_run',
  'description_read',
  'description_check',
] as const;

export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_ID}__request_permission`;
