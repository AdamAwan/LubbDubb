import type { IssueCreateInput } from '../sink/actionSink.js';

// → docs/spec/15-integrations.md, docs/spec/39-app-errors.md#the-key-on-the-ticket

/**
 * The lines a body-searching tracker carries a search key in: one a person can read, and a marker
 * that survives an edit of the visible text.
 */
function searchKeyBodyLines(key: string): string {
  return `Error key: \`${key}\` — every fleet on this project searches for it before filing; keep it here.\n<!-- lubbdubb:${key} -->`;
}

/** Whether a body carries the key whole — a search hit for a longer key that merely starts with it is not one. */
export function bodyCarriesKey(body: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![a-z0-9])`).test(body);
}

/** The body a body-searching tracker files: the caller's text, the cross-reference, then the key lines. */
export function issueBodyWithRefs(input: Pick<IssueCreateInput, 'body' | 'relatedTo' | 'searchKey'>): string {
  return [
    input.body,
    input.relatedTo === null ? null : `Related to #${input.relatedTo}.`,
    input.searchKey === undefined ? null : searchKeyBodyLines(input.searchKey),
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}
