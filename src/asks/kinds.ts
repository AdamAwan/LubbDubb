import type { AskKind } from './askRow.js';

// → docs/spec/17-cockpit.md#the-queue-rail--needs-you

/** The word the kind is named by, wherever an ask is drawn — the cockpit, and the card `ask_next` hands Claude Code. */
export const KIND_LABEL: Record<AskKind, string> = {
  config: 'Config',
  config_gap: 'Config gap',
  recovery: 'Recovery',
  escalation: 'Escalation',
  permission: 'Permission',
  plan: 'Plan',
  reply: 'Reply',
  merge: 'Merge',
  describe: 'Describe',
  description_wrong: 'Description',
  description_note: 'Description note',
  shortfall: 'Shortfall',
  intake: 'Intake',
  sitting: 'Before planning',
  profile: 'Profile',
  placement: 'Backlog',
  bench: 'Bench',
  close_out: 'Close-out',
  validate: 'Run checks',
  validation_plan: 'Checks',
  watch: 'Watch',
  unwatched: 'Unseen stories',
  burn: 'Runaway',
  limit: 'Usage limit',
  supply: 'Runway',
  dispatch: 'Refused',
  assigned: 'Assigned',
  assign: 'Assign',
  upgrade: 'Upgrade',
  project_pull: 'Auto-pull off',
};

/**
 * The hue a kind wears, and it answers *what the ask is* — not who is stopped.
 *
 * Red is something wrong: a restart that orphaned runs, an agent that hit a
 * question it cannot get past. Amber is a gate rather than a fault — nothing
 * broke, something is simply waiting on a yes, an allowance window or a look at
 * the spend. Blue is informative: a plan, a profile, a piece of work only a
 * person can do, all of which want reading rather than repair. Green is the step
 * *after* a delivery — a goal landed and this is what follows it.
 *
 * **Who is stopped is weight, not hue** (see {@link Row}). The rail used to spend
 * its whole palette on that one bit, which left every ask on the bench reading as
 * an alarm; it is now carried by the solid/soft split within each hue, by the
 * `Blocking` sub-heading and by the sort order — three statements of it, none of
 * them costing the operator the ability to tell a delivered goal from a fault at
 * a glance.
 *
 * Total over {@link AskKind}, like {@link KIND_LABEL}, so a new kind fails the
 * typecheck here rather than drawing in whatever the last rule in the sheet said.
 *
 * @public shared with the needs band, which dresses the same ask in the same tone, and with `ask_next`'s card
 */
export const KIND_TONE: Record<AskKind, 'red' | 'amber' | 'blue' | 'green'> = {
  config: 'red',
  config_gap: 'amber',
  recovery: 'red',
  escalation: 'red',
  permission: 'amber',
  plan: 'blue',
  reply: 'amber',
  merge: 'amber',
  describe: 'blue',
  description_wrong: 'amber',
  description_note: 'blue',
  shortfall: 'blue',
  intake: 'blue',
  sitting: 'blue',
  profile: 'blue',
  placement: 'amber',
  bench: 'blue',
  close_out: 'green',
  validate: 'green',
  validation_plan: 'green',
  watch: 'amber',
  unwatched: 'amber',
  burn: 'amber',
  limit: 'amber',
  supply: 'amber',
  dispatch: 'red',
  assigned: 'blue',
  assign: 'blue',
  upgrade: 'amber',
  project_pull: 'amber',
};

/**
 * The glyph drawn before the word, a second reading of the same thing rather
 * than a replacement for it — the tag still spells the kind out, so a symbol
 * nobody has learnt yet costs nothing and needs no legend.
 *
 * Text-presentation BMP glyphs only. A character with an emoji variant (`✔`,
 * `☑`, `🏳`) is rendered by the platform's colour font on some machines and the
 * text font on others, which puts a full-colour sticker in a monospace tag on
 * exactly the operator's machine nobody tested on.
 *
 * @public shared with the needs band, the ask panel and `ask_next`'s card, which name the ask the same
 */
export const KIND_SYMBOL: Record<AskKind, string> = {
  config: '\u2699',
  config_gap: '\u2296',
  recovery: '\u21ba',
  escalation: '?',
  permission: '\u2298',
  plan: '\u25c7',
  reply: '\u21b5',
  merge: '\u2295',
  describe: '\u270e',
  description_wrong: '\u2260',
  description_note: '\u00b6',
  shortfall: '\u2717',
  intake: '\u25cc',
  sitting: '\u270d',
  profile: '\u2299',
  placement: '\u25a3',
  bench: '\u25c6',
  close_out: '\u2691',
  validate: '\u2713',
  validation_plan: '\u25c8',
  watch: '\u25ce',
  unwatched: '\u25cb',
  burn: '\u25b2',
  limit: '\u2016',
  supply: '\u25bd',
  dispatch: '\u22a0',
  assigned: '\u2913',
  assign: '\u2192',
  upgrade: '\u2191',
  project_pull: '\u21a5',
};
