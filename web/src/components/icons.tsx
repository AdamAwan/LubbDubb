import type { JSX } from 'react';

/**
 * The cockpit's line icons, drawn from one 16-square grid.
 *
 * Inline `<path>` data rather than a font or a sprite sheet: an icon font is a
 * network request that fails to a box glyph, and a sprite `<use>` needs a symbol
 * mounted somewhere above every consumer — which on a page the console mounts in
 * fragments is one more thing that can be absent. Everything here is `fill: none`
 * on `currentColor`, so an icon takes the colour of whatever it sits in and needs
 * no token of its own; that is what lets one glyph ride a chip, a toggle and a
 * red danger control without a variant per surface.
 *
 * **An icon never appears without its label.** They are recognition aids for
 * somebody who already knows the control, not the name of it — the goal header's
 * groups say what they are in words, and stripping a label to leave the glyph
 * turns a legible row into a quiz. → docs/spec/17-cockpit.md#the-headers-controls
 *
 * Circles are written as arc pairs rather than `<circle>` so one element type
 * draws every glyph.
 */
const PATHS = {
  /** Elapsed time — the run's own state. */
  clock: ['M14 8a6 6 0 1 1-12 0 6 6 0 1 1 12 0', 'M8 4.4V8l2.6 1.6'],
  /** Running: the harness is scheduling for this goal. */
  play: ['M4.6 2.8 12.6 8l-8 5.2V2.8Z'],
  /** Settled by a verdict. */
  check: ['M2.8 8.4 6.2 11.8 13.2 4.6'],
  /** Terminal: ending the run. */
  stop: ['M13.9 8a5.9 5.9 0 1 1-11.8 0 5.9 5.9 0 1 1 11.8 0', 'M4.2 4.2l7.6 7.6'],
  /** Words the operator writes — an instruction. */
  pen: ['M11.2 2.3 13.7 4.8 5.6 12.9 2.4 13.6l.7-3.2 8.1-8.1Z', 'M10 3.5 12.5 6'],
  /** Watching: the harness may pick this goal up. */
  eye: ['M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8Z', 'M9.9 8a1.9 1.9 0 1 1-3.8 0 1.9 1.9 0 1 1 3.8 0'],
  /** Queue order — this goal takes the next free slots. */
  bolt: ['M8.8 1.5 3.5 9h3.6l-.9 5.5L12.5 7H8.9l-.1-5.5Z'],
  /** Depth: which model profile the goal's work runs on. */
  layers: ['M8 1.8 14 5 8 8.2 2 5l6-3.2Z', 'M2.4 8.2 8 11.2l5.6-3', 'M2.4 11.2 8 14.2l5.6-3'],
  /** A conversation started elsewhere. */
  chat: ['M14 9.2A2.3 2.3 0 0 1 11.7 11.5H5.2L2 14V4.3A2.3 2.3 0 0 1 4.3 2h7.4A2.3 2.3 0 0 1 14 4.3v4.9Z'],
  /** The tracker's own page for this item. */
  ticket: [
    'M8.2 2.2H3.4A1.4 1.4 0 0 0 2 3.6v9A1.4 1.4 0 0 0 3.4 14h9a1.4 1.4 0 0 0 1.4-1.4V7.8',
    'M9.8 2.2H14v4.2',
    'M14 2.2 7.4 8.8',
  ],
  /** A defect — the item type, and the control that files a new one. */
  bug: [
    'M4.6 8.4a3.4 3.4 0 0 1 6.8 0v1.4a3.4 3.4 0 0 1-6.8 0Z',
    'M5.8 3.2 4.6 5M10.2 3.2 11.4 5',
    'M4.6 7.6H2.2M11.4 7.6h2.4M4.6 10.8H2.6M11.4 10.8h2',
  ],
  /** A judgement passed on the work — the appraisal. */
  scale: ['M8 2.2v11.6M4 5.4h8', 'M2 9.4 4 5.4l2 4a2 2 0 0 1-4 0ZM10 9.4l2-4 2 4a2 2 0 0 1-4 0Z'],
  /** The harness's own reading, as against the operator's. */
  robot: [
    'M4.6 5h6.8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4.6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
    'M8 2.2V5',
    'M6 8.6v1M10 8.6v1',
  ],
  /**
   * The fleet's own reading of a diff — spectacles: somebody sat down and read
   * this. Deliberately not {@link PATHS.eye}, which already means *watching*
   * (the harness may pick this up); reading a diff and watching an item are
   * different claims and cannot share a glyph.
   */
  review: [
    'M7 9.4a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 1 1 5.2 0',
    'M14.2 9.4a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 1 1 5.2 0',
    'M7 9.1c.35-.9 1.65-.9 2 0',
    'M1.8 8.6 3.5 5.2M14.2 8.6 12.5 5.2',
  ],
  /** Validation: the checks a goal has to clear. */
  flask: ['M6.4 1.9v4L2.8 12a1.6 1.6 0 0 0 1.4 2.4h7.6A1.6 1.6 0 0 0 13.2 12L9.6 5.9v-4', 'M5.4 1.9h5.2M4.4 9.6h7.2'],
} as const satisfies Record<string, readonly string[]>;

/**
 * One glyph, sized in `px` and inheriting its colour.
 *
 * `aria-hidden`, always: every consumer draws the icon beside its own label, so
 * an accessible name here would be that label read twice.
 */
export function Icon({ name, size = 13 }: { name: keyof typeof PATHS; size?: number }): JSX.Element {
  return (
    <svg
      className="cn-ic"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
