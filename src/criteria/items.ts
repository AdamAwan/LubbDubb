// → docs/spec/20-validation.md#satisfies-and-the-goals-criteria

const MARKER = /^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/;

/**
 * A criteria version as the list of criteria it states: one per non-blank line, list markers
 * stripped. Keyed on the text, as a part's acceptance is, so a reworded criterion is a new one.
 */
export function criteriaItems(text: string | null | undefined): string[] {
  if (!text) return [];
  const items = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(MARKER, '').trim())
    .filter((line) => line !== '');
  return [...new Set(items)];
}
