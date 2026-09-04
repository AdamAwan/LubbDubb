/**
 * The usage vocabulary: everything the harness measures about what a **person**
 * did, declared once and named from both sides of the wire.
 *
 * ## Two axes, not a flat list of names
 *
 * `src/remedies/remedies.ts`' arrangement, for its reason exactly. A subject is a
 * thing the product offers and a verb is what somebody did to it, and because the
 * verbs are shared across subjects, *how much of what this fleet does is
 * rejecting* and *what happens to plans* are one `group by` each. On a flat enum
 * of sixty-nine names they are neither, and no amount of care at the call site
 * gets them back.
 *
 * **A subject is a thing, never a screen.** `pr` is the pull request wherever it
 * is worked, so a control that moves to another surface keeps its row and the
 * history stays one series. Keying on the screen is how a redesign silently
 * resets every number it touches.
 *
 * ## Why the event is a string and not a member of an object
 *
 * Forced rather than preferred: `web/src/` may name only `src/wire.ts`, and
 * `test/wireContract.test.ts` asserts that module contributes **no runtime** — so
 * a `Usage.plan.view` const object could not cross the wire without either
 * breaking that rule or being hand-copied into the SPA, which is the drift
 * `src/wire.ts` exists to end. A string-literal union is erased entirely,
 * autocompletes identically, and a typo is still a compile error.
 * {@link UsageEvent} is narrowed by {@link VERBS_BY_SUBJECT}, so `plan.defer` — a
 * cell that table leaves empty — does not typecheck.
 *
 * → `docs/spec/34-usage-metrics.md#the-event-registry`
 */

/**
 * What a person did, shared across subjects on purpose.
 *
 * `plan.reject` and `validation.reject` being the *same* verb is what makes the
 * rejection question above answerable at all; two per-subject vocabularies would
 * make it a join nobody writes.
 */
export type UsageVerb =
  /** The surface was reached. */
  | 'view'
  /** A disclosure inside it was opened. */
  | 'expand'
  /** The view was re-cut — a filter, an ordering, a switch of layout. */
  | 'filter'
  /** A new one was made. */
  | 'create'
  /** Its content was changed by a person. */
  | 'edit'
  /** Approved, passed, authorised — the affirmative settle. */
  | 'accept'
  /** Refused, failed, declined — the negative settle. */
  | 'reject'
  /** Put off, still owed. */
  | 'defer'
  /** Declared not needed, no longer owed. */
  | 'waive'
  /** Dropped: not owed, and not done. */
  | 'abandon'
  /** A running thing was halted by a person. */
  | 'stop'
  /** A previous settle was taken back. */
  | 'undo'
  /** Something left the harness towards a person or a tracker. */
  | 'send';

/**
 * Which verbs each subject offers — `CAUSES_BY_KIND`' shape and its purpose.
 *
 * **An empty cell is a statement**: the product offers no such control on that
 * subject. The day it does, the cell is where it is added, and every fold and
 * every digest section keyed on this registry picks it up without being edited.
 *
 * Five cells were removed when the call sites were wired, and the removals are
 * that statement being made rather than a narrowing of the vocabulary: the pull
 * request page draws no disclosure, the cockpit cannot edit a tracker item's own
 * content, the feature board offers no filter, a retro is drawn flat and a pet's
 * card is always whole. A `ui` cell with no control behind it is a **permanent
 * silent zero** — the "never named" failure `src/mcpInsights.ts` exists to
 * diagnose, one actor over — so a cell is added on the day the control is.
 */
export const VERBS_BY_SUBJECT = {
  plan: ['view', 'expand', 'edit', 'accept', 'reject', 'abandon'],
  goal: ['view', 'expand', 'edit', 'accept', 'abandon'],
  pr: ['view', 'accept', 'send'],
  validation: ['view', 'expand', 'accept', 'reject', 'defer', 'waive', 'undo'],
  'review-pack': ['view', 'expand', 'send'],
  escalation: ['view', 'accept', 'reject', 'send'],
  'human-task': ['view', 'accept', 'reject'],
  ticket: ['view', 'filter', 'create'],
  feature: ['view', 'expand'],
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

/** Reading order for a panel and for the digest — declaration order, said once. */
export const USAGE_SUBJECTS = Object.keys(VERBS_BY_SUBJECT) as UsageSubject[];

/**
 * `subject.verb`, narrowed by the matrix. The whole vocabulary and nothing
 * outside it.
 */
export type UsageEvent = {
  [S in UsageSubject]: `${S}.${(typeof VERBS_BY_SUBJECT)[S][number]}`;
}[UsageSubject];

/**
 * Where an event is seen, and the field that keeps `collectActions`' objection
 * structurally unreachable rather than merely remembered.
 *
 * - **`ui`** — nothing durable records it, so the call site is the only witness.
 *   Every `view`, `expand` and `filter` is one of these: a person opening the pull
 *   request page leaves no trace in any table, and if the click does not say so,
 *   nothing does.
 * - **`record`** — a table already holds it, distinguishably and with a stamp, so
 *   the ledger sweeps the record and **the call site does not log it at all**. A
 *   settle logged where it happens counts only while that route is the one that
 *   settles it; swept from the record, a second route is picked up for free.
 *
 * An event logged **both** ways would be counted twice by two readings that
 * disagree quietly, which is why {@link UiUsageEvent} cannot express it.
 */
export type UsageEventSource = 'ui' | 'record';

/**
 * The split, per event.
 *
 * `record` is claimed **only where a table has actually been checked** to hold the
 * act with a stamp that survives the next write. Several acts that feel durable
 * are not: an un-watch is a label *removal* nothing writes back
 * (`src/watchLabels.ts`), a config edit is a file write with no row behind it, and
 * an undone validation reading leaves a check `unrun`, which is indistinguishable
 * from one nobody ever ran. Those are `ui`, and calling them otherwise would be a
 * ledger row that is permanently zero with nothing saying why.
 */
const EVENT_SOURCE = {
  'plan.view': 'ui',
  'plan.expand': 'ui',
  'plan.edit': 'record',
  'plan.accept': 'record',
  // The replan route flips the plan's status and settles what hung off it; no row
  // records that a person sent it back, so the call site is the only witness.
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
  // `lubbdubb.config.json` is rewritten in place; nothing records that it was.
  'config.edit': 'ui',
  'upgrade.view': 'ui',
  'upgrade.accept': 'record',
  // Declining puts the intent back to idle, which is the state it was in before.
  'upgrade.reject': 'ui',
  'pet.view': 'ui',
  'pet.edit': 'record',
} as const satisfies Record<UsageEvent, UsageEventSource>;

/**
 * The `ui`-sourced subset, and the whole of what a call site may log.
 *
 * Passing a `record` event is a compile error, so the double count is unreachable
 * rather than a rule somebody has to keep.
 */
export type UiUsageEvent = {
  [E in UsageEvent]: (typeof EVENT_SOURCE)[E] extends 'ui' ? E : never;
}[UsageEvent];

/** Whether a table already holds this act, or the call site is the only witness. */
export function usageEventSource(event: UsageEvent): UsageEventSource {
  return EVENT_SOURCE[event];
}

/**
 * What each event means, in the operator's words.
 *
 * A `Record` over the union — `CAUSE_COPY`'s discipline — so an event with no
 * label does not compile, and the panel never restates a name the server owns.
 */
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

/**
 * Where the cockpit was when something happened — a closed vocabulary, and the
 * second half of {@link UiUsageEvent}'s privacy boundary.
 *
 * It is a **place**, never a URL, never a title, never a ref. That is not a
 * scrubbing pass bolted on after the fact: there is nowhere in the parameter list
 * to put an identifier, so none can be recorded by a call site in a hurry, and it
 * is what lets the aggregate cross to the pool at all.
 *
 * The keys are the cockpit's own layout — `web/src/cockpit/place.ts`'s tabs,
 * panels and one-rung-in pages, folded to one name per *surface*. The vivarium is
 * one key whether it is reached as a tab or as a panel, because an operator who
 * opened it opened the same thing either way.
 *
 * **It stays local to the fleet.** The digest is keyed on subject and verb, which
 * are vocabularies the harness owns; this one a redesign moves, and a cross-fleet
 * series keyed on it would break at a release rather than at a change of
 * behaviour.
 *
 * → `docs/spec/34-usage-metrics.md#surface-reach`
 */
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
] as const;

export type PlaceKey = (typeof PLACE_KEYS)[number];

/**
 * How a place was arrived at, and the column that makes a quiet surface
 * diagnosable.
 *
 * `never-linked` is a verdict about the harness's own navigation rather than
 * about the operator, and it can only be told from `linked-never-visited` if a
 * visit records how it was arrived at: `linked` is a control inside the cockpit
 * that carried somebody there, `direct` is an address — a typed URL, a reload, a
 * bookmark, a link somebody was sent.
 */
export type UsageArrival = 'linked' | 'direct';

/**
 * What each subject is called, in the operator's words.
 *
 * A `Record` over the union like {@link USAGE_COPY}, so a subject added to
 * {@link VERBS_BY_SUBJECT} without a label does not compile — which is what makes
 * "a new subject is a row plus its label" true rather than aspirational.
 *
 * The **subject**, never the screen it is worked on: `pr` is the pull request
 * wherever it lives, so the label survives a redesign that moves the control.
 */
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

/**
 * What each verb is called. The same discipline one axis over, and the reason the
 * panel can draw a subject's breakdown without restating a vocabulary the server
 * owns.
 */
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
