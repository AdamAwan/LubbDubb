import type { JSX } from 'react';
import { toneColor, type StatusTone } from '../vocabulary.js';

/**
 * The floor's icon set, drawn here rather than imported.
 *
 * These are original marks in an industrial-HUD idiom — a deliberate choice, not
 * an incidental one. The game this treatment nods at owns its art outright and
 * licenses none of it for redistribution, so nothing here may be traced from it;
 * what carries the reference is the *vocabulary* (a bay, an inserter, a
 * roboport), which is nobody's property.
 *
 * One sheet mounted once at the root, referenced by `<use>` everywhere else, so
 * the geometry is paid for a single time however many bays are on screen.
 */
export type IconName =
  | 'assembler'
  | 'bot'
  | 'blueprint'
  | 'alert'
  | 'gear'
  | 'flask'
  | 'chest'
  | 'battery'
  | 'inserter'
  | 'belt'
  | 'lamp'
  | 'rocket'
  // The Goal Floor's stages. Each is a machine that exists on the floor and
  // nowhere else, so they are added rather than borrowed: an ore patch drawn as
  // a flask would say "issue" where the point is "the thing being mined".
  | 'patch'
  | 'drill'
  | 'furnace'
  | 'pr'
  | 'satellite'
  | 'doc'
  | 'signal';

/** One icon, inheriting `currentColor` and sized by CSS. */
export function Icon({ name, className = '', title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg className={`fx-ic ${className}`} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <use href={`#fx-i-${name}`} />
    </svg>
  );
}

/**
 * An entity's status lamp — the indicator the game puts on the lower-left of every
 * machine.
 *
 * Two of them because the floor is two media: the belt's crates are HTML and the
 * bays and Goal Floor machines are SVG, where an `<i>` parses as an unknown
 * element and draws nothing. What is *not* duplicated is the mapping — both read
 * `toneColor`, so the fill and the caption beside it cannot drift, which is the
 * whole reason a lamp is a second renderer of a tone rather than a second source.
 *
 * `data-tone` is on both so the flag is one thing to assert whichever medium drew
 * it. `aria-hidden` because the word carries the accessible reading; a lamp
 * announcing "green" would say the same thing twice and less clearly.
 */
export function Lamp({ tone }: { tone: StatusTone }): JSX.Element {
  return <i className="fx-lamp" data-tone={tone} style={{ color: toneColor(tone) }} aria-hidden="true" />;
}

/**
 * The same lamp on the SVG half of the floor. Square, because the game's is.
 *
 * The tone goes on as `color` and the fill reads `currentColor` so the glow — a
 * `drop-shadow` in the medium with no `box-shadow` — is the same value as the
 * fill, exactly as the HTML lamp's is.
 */
export function LampMark({ x, y, tone }: { x: number; y: number; tone: StatusTone }): JSX.Element {
  return (
    <rect
      className="fx-lamp-mark"
      data-tone={tone}
      style={{ color: toneColor(tone) }}
      x={x}
      y={y}
      width="7"
      height="7"
      fill="currentColor"
      stroke="var(--border-lo)"
      strokeWidth="1"
    />
  );
}

export function SpriteSheet(): JSX.Element {
  return (
    <svg width="0" height="0" className="fx-sprites" aria-hidden="true" focusable="false">
      <defs>
        <symbol id="fx-i-assembler" viewBox="0 0 24 24">
          <rect
            x="3.5"
            y="7"
            width="17"
            height="13.5"
            rx="2"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <circle cx="12" cy="13.75" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="12" cy="13.75" r="1.3" fill="currentColor" />
          <path
            d="M12 7V4.2M8.6 4.2h6.8M6.5 20.5v2M17.5 20.5v2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </symbol>
        <symbol id="fx-i-bot" viewBox="0 0 24 24">
          <path d="M3 6.2h5M16 6.2h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path
            d="M8.6 9.6 5.5 6.4M15.4 9.6l3.1-3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <rect
            x="7.8"
            y="9.4"
            width="8.4"
            height="8"
            rx="1.8"
            fill="currentColor"
            fillOpacity=".18"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M10 17.4v3M14 17.4v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </symbol>
        <symbol id="fx-i-blueprint" viewBox="0 0 24 24">
          <rect
            x="3.5"
            y="4.5"
            width="17"
            height="15"
            rx="1.5"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M9 4.5v15M15 4.5v15M3.5 9.5h17M3.5 14.5h17"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            opacity=".6"
          />
          <path
            d="M6.5 19.5v2.2M17.5 19.5v2.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </symbol>
        <symbol id="fx-i-alert" viewBox="0 0 24 24">
          <path
            d="M12 3.6 22 20.6H2z"
            fill="currentColor"
            fillOpacity=".18"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M12 9.6v5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="17.9" r="1.15" fill="currentColor" />
        </symbol>
        <symbol id="fx-i-gear" viewBox="0 0 24 24">
          <path
            d="M12 2.8v3M12 18.2v3M21.2 12h-3M5.8 12h-3M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1M18.5 18.5l-2.1-2.1M7.6 7.6 5.5 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="12" cy="12" r="5" fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        </symbol>
        <symbol id="fx-i-flask" viewBox="0 0 24 24">
          <path
            d="M9.8 3.6v6.1L4.9 18.6a2 2 0 0 0 1.75 3h10.7a2 2 0 0 0 1.75-3l-4.9-8.9V3.6z"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M8.2 3.6h7.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M7.1 15.4h9.8" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".7" />
        </symbol>
        <symbol id="fx-i-chest" viewBox="0 0 24 24">
          <rect
            x="3"
            y="7"
            width="18"
            height="13"
            rx="1.5"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M3 11.5h18" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <rect x="10.2" y="9.6" width="3.6" height="4.2" rx="0.8" fill="currentColor" />
          <path d="M6 7V5.2h12V7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </symbol>
        <symbol id="fx-i-battery" viewBox="0 0 24 24">
          <rect
            x="4.8"
            y="5.4"
            width="14.4"
            height="15.2"
            rx="1.6"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M8.6 5.4V3.4h2.2v2M13.2 5.4V3.4h2.2v2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M13 8.6l-4 5h3.1l-1 4.4 4.2-5.6h-3.1z" fill="currentColor" />
        </symbol>
        <symbol id="fx-i-inserter" viewBox="0 0 24 24">
          <rect
            x="7.5"
            y="17.5"
            width="9"
            height="4"
            rx="1"
            fill="currentColor"
            fillOpacity=".2"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M12 17.5 8.4 8.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <circle
            cx="7.6"
            cy="6"
            r="2.6"
            fill="currentColor"
            fillOpacity=".25"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </symbol>
        <symbol id="fx-i-belt" viewBox="0 0 24 24">
          <rect
            x="2.5"
            y="6.5"
            width="19"
            height="11"
            rx="1.5"
            fill="currentColor"
            fillOpacity=".14"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M7 9.5 10.5 12 7 14.5M12.5 9.5 16 12l-3.5 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="fx-i-lamp" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="10.5"
            r="5.5"
            fill="currentColor"
            fillOpacity=".2"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M8.5 17.5h7l-1 4h-5z"
            fill="currentColor"
            fillOpacity=".25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M12 1.8v2.4M3.6 10.5H1.4M22.6 10.5h-2.2M5.6 4.4 4 2.9M18.4 4.4 20 2.9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </symbol>
        <symbol id="fx-i-rocket" viewBox="0 0 24 24">
          <path
            d="M12 2c3.2 3 4.8 7 4.8 11.2L12 18l-4.8-4.8C7.2 9 8.8 5 12 2z"
            fill="currentColor"
            fillOpacity=".18"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="9.4" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M7.2 12.4 4.4 15.6l2.9.6M16.8 12.4l2.8 3.2-2.9.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="fx-i-patch" viewBox="0 0 24 24">
          <path
            d="M3 19h18l-3.5-7H6.5L3 19Z"
            fill="currentColor"
            fillOpacity=".14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="9" cy="15.5" r="1.3" fill="currentColor" />
          <circle cx="13.5" cy="16.5" r="1.6" fill="currentColor" />
          <circle cx="16" cy="14" r="1.1" fill="currentColor" />
        </symbol>
        <symbol id="fx-i-drill" viewBox="0 0 24 24">
          <rect
            x="6"
            y="3"
            width="12"
            height="6"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M12 9v8M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M10 17h4l-2 3z" fill="currentColor" />
        </symbol>
        <symbol id="fx-i-furnace" viewBox="0 0 24 24">
          <path
            d="M4 20V8l8-4 8 4v12z"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9 20v-5h6v5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </symbol>
        <symbol id="fx-i-pr" viewBox="0 0 24 24">
          <circle cx="7" cy="6" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="7" cy="18" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="17" cy="18" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7 8.4v7.2M17 15.6V9a2.6 2.6 0 0 0-2.6-2.6H10" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </symbol>
        <symbol id="fx-i-satellite" viewBox="0 0 24 24">
          <rect
            x="9"
            y="9"
            width="6"
            height="6"
            fill="currentColor"
            fillOpacity=".18"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M3 6h5v5H3zM16 13h5v5h-5z" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 9.5 9.5 10M15 13.5l1-.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </symbol>
        <symbol id="fx-i-doc" viewBox="0 0 24 24">
          <path
            d="M6 3h8l4 4v14H6z"
            fill="currentColor"
            fillOpacity=".14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9 12h6M9 16h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </symbol>
        <symbol id="fx-i-signal" viewBox="0 0 24 24">
          <rect
            x="7"
            y="3"
            width="10"
            height="12"
            fill="currentColor"
            fillOpacity=".14"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <circle cx="12" cy="7" r="1.6" fill="currentColor" />
          <circle cx="12" cy="11.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M12 15v6M8 21h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </symbol>
      </defs>
    </svg>
  );
}
