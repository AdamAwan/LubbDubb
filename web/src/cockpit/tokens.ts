// → docs/spec/17-cockpit.md#the-address-bar

import { DERIVED_TOKENS } from './tokenTints.js';

export type TokenKind = 'colour' | 'radius' | 'space' | 'metric' | 'font';

export type TokenGroup =
  | 'ground'
  | 'ink'
  | 'edges'
  | 'hues'
  | 'tints'
  | 'refs'
  | 'overlays'
  | 'terminal'
  | 'features'
  | 'shape'
  | 'type';

export interface ThemeToken {
  name: string;
  label: string;
  group: TokenGroup;
  kind: TokenKind;
  why: string;
}

export const TOKEN_GROUPS: Record<TokenGroup, { label: string; blurb: string; advanced: boolean }> = {
  ground: { label: 'Ground and panels', blurb: 'The surfaces everything else sits on.', advanced: false },
  ink: { label: 'Lettering', blurb: 'Text, and what carries on a filled ground.', advanced: false },
  edges: {
    label: 'Lines and edges',
    blurb: 'Borders, dividers and the hover states built from them.',
    advanced: false,
  },
  hues: { label: 'Hues', blurb: 'The six meanings colour carries, twice — once per family.', advanced: false },
  tints: {
    label: 'Tints',
    blurb: 'Grounds, borders and inks derived from a hue. Most follow the hue on their own.',
    advanced: true,
  },
  refs: { label: 'References', blurb: 'How a link to a goal or a pull request is drawn.', advanced: true },
  overlays: {
    label: 'Overlays',
    blurb: 'Scrims, shadows and the hover wash. Alpha is part of the value here.',
    advanced: true,
  },
  terminal: { label: 'Transcript', blurb: "An agent's output, and the four colours it can ask for.", advanced: true },
  features: {
    label: 'Feature ladder',
    blurb: 'Twelve hues that only have to read apart. The slot is persisted, so the useful edit is all twelve or none.',
    advanced: true,
  },
  shape: {
    label: 'Corners and density',
    blurb:
      'Square is the default: a rounded corner is a soft edge on an instrument. The two insets are the whole ramp a frame may pick from.',
    advanced: true,
  },
  type: {
    label: 'Typefaces and labels',
    blurb:
      'A face the machine lacks falls through to the next in the stack. The two label sizes are the whole ramp every uppercase caption reads through.',
    advanced: true,
  },
};

export const THEME_TOKENS: readonly ThemeToken[] = [
  { name: '--bg', label: 'Page ground', group: 'ground', kind: 'colour', why: 'Everything behind everything else' },
  {
    name: '--well',
    label: 'Recessed well',
    group: 'ground',
    kind: 'colour',
    why: 'An inset area: a code block, a transcript, an input',
  },
  {
    name: '--panel',
    label: 'Raised panel',
    group: 'ground',
    kind: 'colour',
    why: 'A card or a modal, lifted off the ground',
  },
  {
    name: '--panel-2',
    label: 'Panel inset face',
    group: 'ground',
    kind: 'colour',
    why: 'The slightly recessed face inside a card',
  },
  {
    name: '--cn-bg',
    label: 'Console ground',
    group: 'ground',
    kind: 'colour',
    why: 'The console shell behind the rail and the cards',
  },
  {
    name: '--cn-panel',
    label: 'Console panel',
    group: 'ground',
    kind: 'colour',
    why: 'A console card, the rail, the top bar',
  },
  {
    name: '--cn-panel-2',
    label: 'Console inset face',
    group: 'ground',
    kind: 'colour',
    why: "A console card's own recessed area",
  },
  { name: '--text', label: 'Body text', group: 'ink', kind: 'colour', why: 'Every word that is not dimmed' },
  { name: '--muted', label: 'Secondary text', group: 'ink', kind: 'colour', why: 'A caption, a unit, a timestamp' },
  {
    name: '--on-light',
    label: 'Ink on a light fill',
    group: 'ink',
    kind: 'colour',
    why: 'Lettering on a pale chip, where body text would vanish',
  },
  {
    name: '--on-warm',
    label: 'Ink on a warm fill',
    group: 'ink',
    kind: 'colour',
    why: 'Lettering on an amber or orange fill',
  },
  { name: '--cn-fg', label: 'Console text', group: 'ink', kind: 'colour', why: 'Console body lettering' },
  {
    name: '--cn-fg-dim',
    label: 'Console secondary text',
    group: 'ink',
    kind: 'colour',
    why: 'A console caption or a column heading',
  },
  {
    name: '--cn-fg-faint',
    label: 'Console faint text',
    group: 'ink',
    kind: 'colour',
    why: 'The quietest console lettering — a hint, a count',
  },
  {
    name: '--cn-on-accent',
    label: 'Ink on the accent',
    group: 'ink',
    kind: 'colour',
    why: 'A word on an accent-filled button',
  },
  {
    name: '--cn-on-red',
    label: 'Ink on red',
    group: 'ink',
    kind: 'colour',
    why: "The rail's count, and anything on a red fill",
  },
  { name: '--border', label: 'Border', group: 'edges', kind: 'colour', why: 'The line around a card or a control' },
  {
    name: '--border-hi',
    label: 'Bevel light edge',
    group: 'edges',
    kind: 'colour',
    why: 'The 1px top and left of an extruded control',
  },
  {
    name: '--border-lo',
    label: 'Bevel dark edge',
    group: 'edges',
    kind: 'colour',
    why: 'The 1px bottom and right of an extruded control',
  },
  { name: '--cn-line', label: 'Console line', group: 'edges', kind: 'colour', why: 'Every console border and divider' },
  {
    name: '--cn-line-soft',
    label: 'Console soft line',
    group: 'edges',
    kind: 'colour',
    why: 'A divider inside a card, quieter than its border',
  },
  {
    name: '--cn-line-hi',
    label: 'Console raised line',
    group: 'edges',
    kind: 'colour',
    why: "A hovered or pressed control's edge",
  },
  {
    name: '--cn-hover',
    label: 'Console hover ground',
    group: 'edges',
    kind: 'colour',
    why: 'What a console row or button fills with under the pointer',
  },
  {
    name: '--cn-track',
    label: 'Console empty track',
    group: 'edges',
    kind: 'colour',
    why: 'The unfilled part of a progress bar or a CI dot',
  },
  {
    name: '--cn-inert',
    label: 'Console inert grey',
    group: 'edges',
    kind: 'colour',
    why: 'A reading that is deliberately not a verdict',
  },
  { name: '--accent', label: 'Accent', group: 'hues', kind: 'colour', why: 'The one warm thing in the frame' },
  { name: '--blue', label: 'Blue', group: 'hues', kind: 'colour', why: 'A reference, a link, deliberation' },
  { name: '--green', label: 'Green', group: 'hues', kind: 'colour', why: 'Finished, passing, merged' },
  { name: '--amber', label: 'Amber', group: 'hues', kind: 'colour', why: 'Waiting, stalled, needs a look' },
  { name: '--red', label: 'Red', group: 'hues', kind: 'colour', why: 'Failed, blocked, asking for you' },
  { name: '--grey', label: 'Grey', group: 'hues', kind: 'colour', why: 'Present but not a verdict' },
  { name: '--violet', label: 'Violet', group: 'hues', kind: 'colour', why: 'A job, and the container kind of ticket' },
  {
    name: '--cn-accent',
    label: 'Console accent',
    group: 'hues',
    kind: 'colour',
    why: "The console's primary — live, watched, selected",
  },
  { name: '--cn-red', label: 'Console red', group: 'hues', kind: 'colour', why: 'A console failure or an escalation' },
  { name: '--cn-amber', label: 'Console amber', group: 'hues', kind: 'colour', why: 'A console warning or a stall' },
  { name: '--cn-green', label: 'Console green', group: 'hues', kind: 'colour', why: 'A console success' },
  { name: '--cn-violet', label: 'Console violet', group: 'hues', kind: 'colour', why: 'A desk agent, a container' },
  ...DERIVED_TOKENS,
  {
    name: '--term-fg',
    label: 'Transcript text',
    group: 'terminal',
    kind: 'colour',
    why: "An agent's output, before any colour code",
  },
  {
    name: '--term-fg-dim',
    label: 'Transcript dim text',
    group: 'terminal',
    kind: 'colour',
    why: "A transcript's own headings and origins",
  },
  { name: '--ansi-cyan', label: 'ANSI cyan', group: 'terminal', kind: 'colour', why: 'What an agent prints as cyan' },
  { name: '--ansi-gray', label: 'ANSI grey', group: 'terminal', kind: 'colour', why: 'What an agent prints as grey' },
  {
    name: '--ansi-red',
    label: 'ANSI red',
    group: 'terminal',
    kind: 'colour',
    why: 'What an agent prints as red, and a failed tool block',
  },
  {
    name: '--ansi-green',
    label: 'ANSI green',
    group: 'terminal',
    kind: 'colour',
    why: 'What an agent prints as green',
  },
  {
    name: '--feat-0',
    label: 'Feature 0',
    group: 'features',
    kind: 'colour',
    why: 'The first slot on the feature ladder',
  },
  {
    name: '--feat-1',
    label: 'Feature 1',
    group: 'features',
    kind: 'colour',
    why: 'The second slot on the feature ladder',
  },
  {
    name: '--feat-2',
    label: 'Feature 2',
    group: 'features',
    kind: 'colour',
    why: 'The third slot on the feature ladder',
  },
  {
    name: '--feat-3',
    label: 'Feature 3',
    group: 'features',
    kind: 'colour',
    why: 'The fourth slot on the feature ladder',
  },
  {
    name: '--feat-4',
    label: 'Feature 4',
    group: 'features',
    kind: 'colour',
    why: 'The fifth slot on the feature ladder',
  },
  {
    name: '--feat-5',
    label: 'Feature 5',
    group: 'features',
    kind: 'colour',
    why: 'The sixth slot on the feature ladder',
  },
  {
    name: '--feat-6',
    label: 'Feature 6',
    group: 'features',
    kind: 'colour',
    why: 'The seventh slot on the feature ladder',
  },
  {
    name: '--feat-7',
    label: 'Feature 7',
    group: 'features',
    kind: 'colour',
    why: 'The eighth slot on the feature ladder',
  },
  {
    name: '--feat-8',
    label: 'Feature 8',
    group: 'features',
    kind: 'colour',
    why: 'The ninth slot on the feature ladder',
  },
  {
    name: '--feat-9',
    label: 'Feature 9',
    group: 'features',
    kind: 'colour',
    why: 'The tenth slot on the feature ladder',
  },
  {
    name: '--feat-10',
    label: 'Feature 10',
    group: 'features',
    kind: 'colour',
    why: 'The eleventh slot on the feature ladder',
  },
  {
    name: '--feat-11',
    label: 'Feature 11',
    group: 'features',
    kind: 'colour',
    why: 'The twelfth slot on the feature ladder',
  },
  { name: '--r-sm', label: 'Small radius', group: 'shape', kind: 'radius', why: 'A chip, a badge, an input' },
  { name: '--r-md', label: 'Medium radius', group: 'shape', kind: 'radius', why: 'A button, a card' },
  { name: '--r-lg', label: 'Large radius', group: 'shape', kind: 'radius', why: 'A modal, a panel' },
  { name: '--r-pill', label: 'Pill radius', group: 'shape', kind: 'radius', why: 'A fully rounded chip' },
  { name: '--cn-r', label: 'Console radius', group: 'shape', kind: 'radius', why: 'A console card' },
  {
    name: '--cn-r-sm',
    label: 'Console small radius',
    group: 'shape',
    kind: 'radius',
    why: 'A console chip or control',
  },
  {
    name: '--pad',
    label: 'Frame inset',
    group: 'shape',
    kind: 'space',
    why: 'How much room a card gives its contents',
  },
  { name: '--font-ui', label: 'Interface face', group: 'type', kind: 'font', why: 'Every word that is not code' },
  {
    name: '--label-size',
    label: 'Label size',
    group: 'type',
    kind: 'metric',
    why: 'Every uppercase caption over a block',
  },
  {
    name: '--label-size-sm',
    label: 'Label size, dense',
    group: 'type',
    kind: 'metric',
    why: 'The same, in a column head or a tile',
  },
  {
    name: '--label-track',
    label: 'Label tracking',
    group: 'type',
    kind: 'metric',
    why: 'How far apart a label sets its letters',
  },
  {
    name: '--label-weight',
    label: 'Label weight',
    group: 'type',
    kind: 'metric',
    why: 'How much a label holds against the prose under it',
  },
  {
    name: '--font-mono',
    label: 'Monospace face',
    group: 'type',
    kind: 'font',
    why: 'Code, ids, config keys, transcripts',
  },
  {
    name: '--font-display',
    label: 'Display face',
    group: 'type',
    kind: 'font',
    why: 'Headings and figures — condensed and mechanical',
  },
  { name: '--cn-mono', label: 'Console monospace face', group: 'type', kind: 'font', why: 'Console ids and figures' },
  { name: '--cn-ui', label: 'Console interface face', group: 'type', kind: 'font', why: "The console's own lettering" },
];
