// → docs/spec/11-mcp-tools.md

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
  'validation_report',
  'local_validation_plan',
  'local_run_read',
  'local_validation_report',
  'watch_declare',
  'state_declare',
  'review_report',
  'review_route',
  'split_assess',
  'report_remedy',
  'raise',
  'review_pack_submit',
  'review_pack_check',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const TOOL_NAMING: Record<McpToolName, 'addendum' | 'point-of-use'> = {
  raise: 'addendum',
  escalate: 'addendum',
  plan_submit: 'addendum',
  plan_correct: 'addendum',
  world_read: 'addendum',
  open_pr: 'addendum',
  note_progress: 'addendum',
  request_human_task: 'addendum',
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
  local_validation_plan: 'point-of-use',
  local_run_read: 'point-of-use',
  local_validation_report: 'point-of-use',
  review_report: 'point-of-use',
  review_route: 'point-of-use',
  split_assess: 'point-of-use',
  validation_amend: 'point-of-use',
  watch_declare: 'point-of-use',
  state_declare: 'point-of-use',
  report_remedy: 'point-of-use',
  review_pack_submit: 'point-of-use',
  review_pack_check: 'point-of-use',
  request_permission: 'point-of-use',
};

export const RETIRED_TOOL_NAMES: readonly string[] = [
  'report_finding',
  'knowledge_propose',
  'knowledge_notice',
  'knowledge_contradict',
  'knowledge_ask',
];

export function retiredToolMessage(name: string): string {
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
] as const;

export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_ID}__request_permission`;
