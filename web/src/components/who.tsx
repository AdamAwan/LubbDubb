import type { JSX } from 'react';

/**
 * Who asked, as a mark small enough to sit in a column.
 *
 * A pull request somebody handed you and one the harness opened for itself are
 * two different obligations, and until now the rack said so in one word in the
 * state column — which is a reading you have to take row by row. A mark in a
 * fixed slot is a reading you take down the column: a person's initials against
 * a hollow diamond, at a glance, before any row is read.
 *
 * **The name is the tracker's, never the cockpit's.** `PullRequest.author` is
 * what the provider reported — a GitHub login, an Azure display name, or an
 * address where the display name was empty ([15](docs/spec/15-integrations.md)) —
 * so the initials are of a person who exists on the board the operator is looking
 * at. Nothing here invents one: a provider that reported no author draws the
 * same hollow mark the harness's own rows wear, because *we were not told who*
 * and *nobody asked* are both honestly "no person here", and inventing a letter
 * for the first is the mark stating a fact it does not have.
 */
export function Who({ name }: { name: string | null }): JSX.Element {
  // Hollow, dashed, and out of the accessibility tree on the harness's own rows:
  // it is the *absence* of a person, which the band the row sits under already
  // says in words, and announcing "◇" on every fleet row would be a screen reader
  // reading the column's punctuation.
  if (name === null) {
    return (
      <span className="cn-who cn-who-none" title="The harness opened this" aria-hidden="true">
        ◇
      </span>
    );
  }
  const mark = initials(name);
  // A name with no letter in it keeps the name and loses the initials, rather
  // than drawing an empty disc that reads as a mark that failed to load.
  if (mark === null) {
    return (
      <span className="cn-who cn-who-none" role="img" aria-label={name} title={name}>
        ◇
      </span>
    );
  }
  // The label is the whole name, never the initials: `PR` is two letters that
  // mean nothing said out loud, and the mark's entire job is to stand in for a
  // name the row has room for nowhere else.
  return (
    <span className="cn-who cn-who-person" role="img" aria-label={name} title={name}>
      {mark}
    </span>
  );
}

/**
 * A person's initials, from whatever shape the provider calls them by.
 *
 * The three shapes are real and arrive from the same field: `adamawan` (a GitHub
 * login), `Priya Raman` (an Azure display name), `priya.raman@corp.example` (an
 * Azure unique name, where the display name was empty). So the domain goes first,
 * the local part is split on every separator a login or a name uses, and a
 * one-word name gives up two letters rather than one — `adamawan` as `A` is a
 * column of rows that all start with the same letter, which is a mark that
 * distinguishes nobody.
 *
 * Null rather than an empty string where there is no letter to take, so the
 * caller has to decide what a nameless row draws instead of rendering an empty
 * circle that reads as a mark that failed to load.
 */
export function initials(name: string): string | null {
  const local = (name.trim().split('@')[0] ?? '').trim();
  const words = local.split(/[\s._+\-/\\]+/).filter((word) => word !== '');
  const first = words[0];
  if (first === undefined) return null;
  const last = words[words.length - 1] ?? first;
  // Two words give one letter each; one word gives its first two. Taken by code
  // point rather than by index, so a name that opens with an astral character
  // yields that character and not half of it.
  const taken = words.length > 1 ? [...first].slice(0, 1).concat([...last].slice(0, 1)) : [...first].slice(0, 2);
  const kept = taken.filter((char) => /[\p{L}\p{N}]/u.test(char)).join('');
  return kept === '' ? null : kept.toUpperCase();
}
