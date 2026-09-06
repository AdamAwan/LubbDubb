// → docs/spec/34-usage-metrics.md

export type UsageVerb =
  | 'view'
  | 'expand'
  | 'filter'
  | 'create'
  | 'edit'
  | 'accept'
  | 'reject'
  | 'defer'
  | 'waive'
  | 'abandon'
  | 'stop'
  | 'undo'
  | 'send';

export const VERBS_BY_SUBJECT = {
  plan: ['view', 'expand', 'edit', 'accept', 'reject', 'abandon'],
  goal: ['view', 'expand', 'edit', 'accept', 'abandon'],
  pr: ['view', 'accept', 'send'],
  validation: ['view', 'expand', 'accept', 'reject', 'defer', 'waive', 'undo'],
  'review-pack': ['view', 'expand', 'send'],
  escalation: ['view', 'accept', 'reject', 'send'],
  'human-task': ['view', 'accept', 'reject'],
  ticket: ['view', 'filter', 'create'],
  feature: ['view', 'expand', 'filter'],
  agent: ['view', 'expand', 'send', 'stop'],
  obstacle: ['view', 'expand', 'accept', 'waive'],
  'local-run': ['view', 'create', 'stop'],
  job: ['view', 'create', 'stop'],
  retro: ['view'],
  scratchpad: ['view', 'edit'],
  insights: ['view', 'filter'],
  pool: ['view', 'filter'],
  config: ['view', 'edit'],
  upgrade: ['view', 'accept', 'reject'],
  pet: ['view', 'edit'],
} as const satisfies Record<string, readonly UsageVerb[]>;

export type UsageSubject = keyof typeof VERBS_BY_SUBJECT;

export const USAGE_SUBJECTS = Object.keys(VERBS_BY_SUBJECT) as UsageSubject[];

export type UsageEvent = {
  [S in UsageSubject]: `${S}.${(typeof VERBS_BY_SUBJECT)[S][number]}`;
}[UsageSubject];

export type UsageEventSource = 'ui' | 'record';

const EVENT_SOURCE = {
  'plan.view': 'ui',
  'plan.expand': 'ui',
  'plan.edit': 'record',
  'plan.accept': 'record',
  'plan.reject': 'ui',
  'plan.abandon': 'record',
  'goal.view': 'ui',
  'goal.expand': 'ui',
  'goal.edit': 'record',
  'goal.accept': 'record',
  'goal.abandon': 'record',
  'pr.view': 'ui',
  'pr.accept': 'record',
  'pr.send': 'record',
  'validation.view': 'ui',
  'validation.expand': 'ui',
  'validation.accept': 'record',
  'validation.reject': 'record',
  'validation.defer': 'record',
  'validation.waive': 'record',
  'validation.undo': 'ui',
  'review-pack.view': 'ui',
  'review-pack.expand': 'ui',
  'review-pack.send': 'record',
  'escalation.view': 'ui',
  'escalation.accept': 'record',
  'escalation.reject': 'record',
  'escalation.send': 'record',
  'human-task.view': 'ui',
  'human-task.accept': 'record',
  'human-task.reject': 'record',
  'ticket.view': 'ui',
  'ticket.filter': 'ui',
  'ticket.create': 'record',
  'feature.view': 'ui',
  'feature.expand': 'ui',
  'feature.filter': 'ui',
  'agent.view': 'ui',
  'agent.expand': 'ui',
  'agent.send': 'ui',
  'agent.stop': 'record',
  'obstacle.view': 'ui',
  'obstacle.expand': 'ui',
  'obstacle.accept': 'record',
  'obstacle.waive': 'record',
  'local-run.view': 'ui',
  'local-run.create': 'record',
  'local-run.stop': 'record',
  'job.view': 'ui',
  'job.create': 'record',
  'job.stop': 'record',
  'retro.view': 'ui',
  'scratchpad.view': 'ui',
  'scratchpad.edit': 'record',
  'insights.view': 'ui',
  'insights.filter': 'ui',
  'pool.view': 'ui',
  'pool.filter': 'ui',
  'config.view': 'ui',
  'config.edit': 'ui',
  'upgrade.view': 'ui',
  'upgrade.accept': 'record',
  'upgrade.reject': 'ui',
  'pet.view': 'ui',
  'pet.edit': 'record',
} as const satisfies Record<UsageEvent, UsageEventSource>;

export type UiUsageEvent = {
  [E in UsageEvent]: (typeof EVENT_SOURCE)[E] extends 'ui' ? E : never;
}[UsageEvent];

export function usageEventSource(event: UsageEvent): UsageEventSource {
  return EVENT_SOURCE[event];
}

export const USAGE_COPY: Record<UsageEvent, { label: string; blurb: string }> = {
  'plan.view': { label: 'Opened a plan', blurb: 'The plan page was reached' },
  'plan.expand': { label: 'Read into a plan', blurb: 'A part, a caveat or the write-up was opened' },
  'plan.edit': { label: 'Amended a plan', blurb: 'A correction to a plan that was already running' },
  'plan.accept': { label: 'Approved a plan', blurb: 'The decomposition was released to the fleet' },
  'plan.reject': { label: 'Sent a plan back', blurb: 'A replan: the planner runs again over what it produced' },
  'plan.abandon': { label: 'Abandoned a plan', blurb: 'The plan was dropped and nothing replaced it' },
  'goal.view': { label: 'Opened a goal', blurb: 'The goal page was reached' },
  'goal.expand': { label: 'Read into a goal', blurb: 'A section of the goal record was opened' },
  'goal.edit': { label: 'Instructed the fleet', blurb: 'A standing instruction was written on the goal' },
  'goal.accept': { label: 'Concluded a goal', blurb: 'The operator declared the work finished' },
  'goal.abandon': { label: 'Retired a goal', blurb: 'The goal was taken off the fleet without being finished' },
  'pr.view': { label: 'Opened a pull request', blurb: 'The pull request page was reached' },
  'pr.accept': { label: 'Authorised a landing', blurb: 'A merge, or a whole stack, was cleared to land' },
  'pr.send': { label: 'Sent a review reply', blurb: 'A drafted reply left the harness onto the thread' },
  'validation.view': { label: 'Opened validation', blurb: 'The goal’s checks were reached' },
  'validation.expand': { label: 'Read a check', blurb: 'One check’s procedure was opened' },
  'validation.accept': { label: 'Passed a check', blurb: 'The procedure was run and it did what it says' },
  'validation.reject': { label: 'Failed a check', blurb: 'The procedure was run and it did not' },
  'validation.defer': { label: 'Deferred a check', blurb: 'Put off, still owed' },
  'validation.waive': { label: 'Waived a check', blurb: 'Declared not needed — no longer owed' },
  'validation.undo': { label: 'Withdrew a reading', blurb: 'A previous result was taken back' },
  'review-pack.view': { label: 'Opened a review pack', blurb: 'The restatement of a change was reached' },
  'review-pack.expand': { label: 'Read into a review pack', blurb: 'A claim, an idea or the witness log was opened' },
  'review-pack.send': { label: 'Sent a review pack', blurb: 'The pack left the harness towards a reviewer' },
  'escalation.view': { label: 'Opened an escalation', blurb: 'The inbox item was reached' },
  'escalation.accept': { label: 'Answered an escalation', blurb: 'The question was answered, or the act approved' },
  'escalation.reject': { label: 'Refused an escalation', blurb: 'The act was declined, or the item dismissed' },
  'escalation.send': { label: 'Replied to an agent', blurb: 'The answer was typed into the parked session' },
  'human-task.view': { label: 'Opened a bench item', blurb: 'The ask was reached' },
  'human-task.accept': { label: 'Did a bench item', blurb: 'The work only a person could do was done' },
  'human-task.reject': { label: 'Declined a bench item', blurb: 'The harness asked for the wrong thing' },
  'ticket.view': { label: 'Opened the backlog', blurb: 'The tracker items were reached' },
  'ticket.filter': { label: 'Re-cut the backlog', blurb: 'A filter, an ordering or a layout was changed' },
  'ticket.create': { label: 'Filed a ticket', blurb: 'A new tracker item was opened' },
  'feature.view': { label: 'Opened the feature board', blurb: 'The board was reached' },
  'feature.expand': { label: 'Read into a feature', blurb: 'One feature’s detail was opened' },
  'feature.filter': { label: 'Re-cut the feature board', blurb: 'A card was opened, or the order or filter changed' },
  'agent.view': { label: 'Opened an agent', blurb: 'A run’s console was reached' },
  'agent.expand': { label: 'Read into a run', blurb: 'The transcript, its files or its flags were opened' },
  'agent.send': { label: 'Steered an agent', blurb: 'Text was typed into a running session' },
  'agent.stop': { label: 'Stopped an agent', blurb: 'A running agent was halted by a person' },
  'obstacle.view': { label: 'Opened the obstacle board', blurb: 'What is in the fleet’s way was reached' },
  'obstacle.expand': { label: 'Read into an obstacle', blurb: 'One row’s keys, sightings or owner were opened' },
  'obstacle.accept': { label: 'Took an obstacle on', blurb: 'Somebody or something was named as owning it' },
  'obstacle.waive': { label: 'Retired an obstacle', blurb: 'Declared no longer in the way' },
  'local-run.view': { label: 'Opened the local run', blurb: 'The machine’s dev environment was reached' },
  'local-run.create': { label: 'Brought a branch up', blurb: 'A goal was checked out into the local environment' },
  'local-run.stop': { label: 'Took the local run down', blurb: 'The environment was stopped by a person' },
  'job.view': { label: 'Opened the job queue', blurb: 'The operator’s own queue was reached' },
  'job.create': { label: 'Launched a job', blurb: 'Work was queued that no ticket asked for' },
  'job.stop': { label: 'Stopped a job', blurb: 'A queued or running job was halted' },
  'retro.view': { label: 'Opened a retro', blurb: 'What the fleet learned on a goal was reached' },
  'scratchpad.view': { label: 'Opened the scratchpad', blurb: 'The shared notes were reached' },
  'scratchpad.edit': { label: 'Wrote in the scratchpad', blurb: 'The shared notes were changed' },
  'insights.view': { label: 'Opened Insights', blurb: 'A reading tab was reached' },
  'insights.filter': { label: 'Re-cut Insights', blurb: 'The window or a tab was changed' },
  'pool.view': { label: 'Opened the pool', blurb: 'The cross-fleet digest was reached' },
  'pool.filter': { label: 'Re-cut the pool', blurb: 'A fleet, a section or a day was changed' },
  'config.view': { label: 'Opened configuration', blurb: 'The settings were reached' },
  'config.edit': { label: 'Changed configuration', blurb: 'A key the harness reads was written' },
  'upgrade.view': { label: 'Opened the build', blurb: 'The harness’s own build was reached' },
  'upgrade.accept': { label: 'Accepted an upgrade', blurb: 'The fleet drained and the harness rebuilt itself' },
  'upgrade.reject': { label: 'Declined an upgrade', blurb: 'The available build was not taken' },
  'pet.view': { label: 'Opened the vivarium', blurb: 'The corner was reached' },
  'pet.edit': { label: 'Named a pet', blurb: 'A creature was renamed' },
};

export const PLACE_KEYS = [
  'overview',
  'tickets',
  'obstacles',
  'features',
  'insights',
  'pets',
  'config',
  'goal',
  'pr',
  'review-pack',
  'agent',
  'plan',
  'retro',
  'scratchpad',
  'ask',
  'hatch',
  'obstacle',
  'faults',
  'launch',
  'build',
  'local-run',
  'setup',
  'record',
  'upnext',
  'signals',
  'environments',
] as const;

export type PlaceKey = (typeof PLACE_KEYS)[number];

export type UsageArrival = 'linked' | 'direct';

export const SUBJECT_LABEL: Record<UsageSubject, string> = {
  plan: 'Plans',
  goal: 'Goals',
  pr: 'Pull requests',
  validation: 'Validation',
  'review-pack': 'Review packs',
  escalation: 'Escalations',
  'human-task': 'The bench',
  ticket: 'Tickets',
  feature: 'The feature board',
  agent: 'Agents',
  obstacle: 'Obstacles',
  'local-run': 'The local run',
  job: 'Jobs',
  retro: 'Retros',
  scratchpad: 'The scratchpad',
  insights: 'Insights',
  pool: 'The pool',
  config: 'Configuration',
  upgrade: 'The build',
  pet: 'The vivarium',
};

export const VERB_LABEL: Record<UsageVerb, string> = {
  view: 'Reached',
  expand: 'Opened something inside',
  filter: 'Re-cut',
  create: 'Created',
  edit: 'Edited',
  accept: 'Accepted',
  reject: 'Rejected',
  defer: 'Deferred',
  waive: 'Waived',
  abandon: 'Abandoned',
  stop: 'Stopped',
  undo: 'Undone',
  send: 'Sent',
};
