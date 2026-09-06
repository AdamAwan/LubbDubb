import { secretRefusal } from '../pool/secrets.js';
import type { ReviewAnchor, ReviewPack, ReviewRange } from '../types.js';

// → docs/spec/31-review-packs.md

interface Line {
  where: string;
  text: string;
}

export function packSecretRefusal(pack: ReviewPack): string | null {
  for (const line of packLines(pack)) {
    const reason = secretRefusal(line.text);
    if (reason !== null) return `${line.where} — ${reason}`;
  }
  return null;
}

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

function codeLines(at: string, range: ReviewRange, code: readonly string[]): Line[] {
  return code.map((text, i) => ({ where: `${at}: ${range.path}:${range.start + i}`, text }));
}
