import { secretRefusal } from '../pool/secrets.js';
import type { ReviewAnchor, ReviewPack, ReviewRange } from '../types.js';

/**
 * The last control before a pack leaves the machine, and **it matters more here
 * than it does for a claim.**
 *
 * The pool's backstop was written for one English sentence. A pack embeds the code
 * its anchors point at, so pointing that same check at a pack aims it at the place
 * a secret actually hides: a token in a test fixture, an internal hostname in a
 * config default, a key in the counter the checker read off the tree. So it runs
 * over **every embedded line** — anchor code, counter code, notes, claims, the
 * author's prose — and not only the sentences.
 *
 * Same shape as the pool's, deliberately: it **refuses and never rewrites**. A
 * scrub is refused for the reason `src/pool/secrets.ts` gives — its output looks
 * sanitised, so nobody reads it carefully again — and refusing is loud: the pack
 * stays local and the row says which line stopped it. It will refuse a legitimate
 * share sometimes, which is the correct direction to fail in.
 *
 * **The reason names the place and never the line's text.** A refusal is drawn in
 * the cockpit and recorded in a row; echoing the match would be this control
 * creating the exposure it exists to stop.
 *
 * → `docs/spec/31-review-packs.md#sharing-a-pack`,
 *   `docs/spec/28-cross-fleet-pool.md#data-classification`
 */

/** One thing that would leave with the pack, and how to name where it is. */
interface Line {
  where: string;
  text: string;
}

/**
 * Why this pack may not be published, naming the line, or null when nothing
 * structured matched. The first match wins: a share is refused whole, so a second
 * reason would be a second thing to read before doing the one thing there is to do.
 */
export function packSecretRefusal(pack: ReviewPack): string | null {
  for (const line of packLines(pack)) {
    const reason = secretRefusal(line.text);
    if (reason !== null) return `${line.where} — ${reason}`;
  }
  return null;
}

/** Everything the document would carry, each with the words that locate it. */
function packLines(pack: ReviewPack): Line[] {
  const out: Line[] = [
    { where: 'the headline', text: pack.headline },
    { where: 'the summary', text: pack.summary },
    { where: 'the colophon’s "what is fake"', text: pack.fake },
  ];
  pack.ideas.forEach((idea, i) => {
    const at = `idea ${i + 1} (${idea.id})`;
    out.push(
      { where: `${at}: its claim`, text: idea.claim },
      { where: `${at}: its title`, text: idea.title },
      { where: `${at}: its cue`, text: idea.cue ?? '' },
    );
    idea.anchors.forEach((anchor, step) => {
      out.push(...anchorLines(`${at}, step ${step + 1}`, anchor));
    });
    idea.claims.forEach((claim, c) => {
      const on = `${at}, claim ${c + 1}`;
      out.push(
        { where: `${on}`, text: claim.text },
        { where: `${on}: the checker’s evidence`, text: claim.evidence ?? '' },
      );
      const finding = claim.finding;
      if (finding === null) return;
      out.push(
        { where: `${on}: the finding’s headline`, text: finding.headline },
        { where: `${on}: the finding’s body`, text: finding.body },
      );
      if (finding.counter !== null) {
        out.push({ where: `${on}: the counter’s caption`, text: finding.counter.caption });
        out.push(...codeLines(`${on}: the counter`, finding.counter.range, finding.counter.code));
      }
    });
  });
  return out;
}

function anchorLines(at: string, anchor: ReviewAnchor): Line[] {
  return [
    { where: `${at}: its gist`, text: anchor.gist },
    { where: `${at}: its caption`, text: anchor.caption ?? '' },
    { where: `${at}: its note`, text: anchor.note?.text ?? '' },
    ...codeLines(at, anchor.range, anchor.code),
  ];
}

/**
 * The embedded code, one entry per line, named by the file and the line number it
 * stood at — which is what makes the refusal actionable rather than a fact about
 * the pack. A hunk whose lines carry diff prefixes still numbers from the range's
 * start: the number is where to look, not an assertion about the diff's arithmetic.
 */
function codeLines(at: string, range: ReviewRange, code: readonly string[]): Line[] {
  return code.map((text, i) => ({ where: `${at}: ${range.path}:${range.start + i}`, text }));
}
