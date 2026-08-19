/**
 * The colour an operator gave a tracker state, and how a state word finds it.
 *
 * Trackers report their own vocabulary with their own punctuation — Azure DevOps
 * says `In Review`, a board renamed once says `in-review`, and an operator
 * picking a colour is naming the state they read on the row rather than the
 * string the API returned. So the key is folded to letters and digits on both
 * sides of the lookup: a map written once keeps working when the tracker changes
 * the casing or the space, which is the kind of drift nothing would report.
 *
 * A malformed value resolves to `null` rather than reaching a `style` attribute.
 * The config route refuses one on the way in, but the map also arrives from a
 * hand-edited file, and half a colour is not worth a broken chip.
 */

/** `#rrggbb`, the one form the picker writes and the only one read back. */
const HEX = /^#[0-9a-f]{6}$/i;

/** Whether a value is a colour this can draw. The config form's validator too. */
export function isStateColour(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** The lookup key: letters and digits only, lowercased. */
export function stateColourKey(state: string): string {
  return state.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The operator's colour for a state, or null where there is none to draw. */
export function stateColour(colours: Readonly<Record<string, string>>, state: string): string | null {
  const want = stateColourKey(state);
  for (const [key, value] of Object.entries(colours)) {
    if (stateColourKey(key) === want && isStateColour(value)) return value;
  }
  return null;
}
