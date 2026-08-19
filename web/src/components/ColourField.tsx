/**
 * A colour, as two controls that agree: the platform's picker and the hex beside it.
 *
 * Both are needed, and for different people. The picker is how you *choose* a
 * colour — it brings the platform's eyedropper, its recent swatches and its
 * keyboard handling, none of which is worth reimplementing for a control opened
 * twice. The hex field is how you *carry* one: pasting a value from a palette, or
 * reading back what you have so you can put it in a message. A picker alone cannot
 * be pasted into and a text box alone cannot be sampled from a screenshot.
 *
 * Two mechanics live here rather than at the call sites, because both were got
 * wrong once already:
 *
 * - **`onInput`, not `onChange`.** Chrome fires `change` on a colour input only when
 *   the picker is dismissed, so a caller doing live preview on `onChange` gets no
 *   preview at all while the pointer is down.
 * - **Alpha survives the picker.** A colour input speaks `#rrggbb` and nothing else,
 *   so dragging one over an eight-digit value would silently make a scrim opaque.
 *   The alpha is cut off for the picker and put back on the way out.
 *
 * What is *not* here is what counts as valid. The two callers disagree — the theme
 * admits three-, four-, six- and eight-digit hex, and a tracker state colour is
 * `#rrggbb` only — so validity is the caller's answer and this only draws it. The
 * value is reported on every keystroke either way: a refused value is shown back
 * rather than swallowed, because losing what someone typed is worse than marking it.
 */

/** Cut any value down to the `#rrggbb` a colour input will accept. */
function pickerHex(value: string): string {
  const hex = value.startsWith('#') ? value.slice(1) : '';
  if (hex.length === 3 || hex.length === 4) return `#${[...hex.slice(0, 3)].map((c) => c + c).join('')}`;
  if (hex.length >= 6) return `#${hex.slice(0, 6)}`;
  return '#000000';
}

/** Put back the alpha the picker cannot express. */
function withAlphaOf(previous: string, picked: string): string {
  const hex = previous.startsWith('#') ? previous.slice(1) : '';
  if (hex.length === 8) return picked + hex.slice(6);
  if (hex.length === 4) return picked + hex[3]! + hex[3]!;
  return picked;
}

export function ColourField({
  value,
  label,
  valid,
  onChange,
}: {
  value: string;
  /** Names the colour for a screen reader — "Colour for In Review", "Panel inset face". */
  label: string;
  /** `false` marks the field refused. The grammar belongs to the caller. */
  valid?: boolean;
  onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <span className="cf">
      <input
        type="color"
        className="cf-col"
        aria-label={label}
        value={pickerHex(value)}
        onInput={(e) => onChange(withAlphaOf(value, e.currentTarget.value))}
      />
      <input
        type="text"
        className={`cf-hex${valid === false ? ' bad' : ''}`}
        aria-label={`${label}, as hex`}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}
