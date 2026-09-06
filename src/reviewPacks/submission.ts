import { nanoid } from 'nanoid';
import { REVIEW_PACK_SCHEMA } from '../store/reviewPacks.js';
import type {
  ReviewAnchor,
  ReviewAnchorMark,
  ReviewClaim,
  ReviewIdea,
  ReviewNote,
  ReviewPack,
  ReviewProvenance,
  ReviewRange,
  ScratchEntry,
} from '../types.js';
import { coverageRefusal, ownsTestHunk, PLUMBING_IDEA_ID, testsOnlyIdea, type DiffHunk } from './hunks.js';

// → docs/spec/31-review-packs.md

export interface Commission {
  prNumber: number;
  headSha: string;
  hunks: readonly DiffHunk[];
  entries: readonly ScratchEntry[];
  readRegion(range: ReviewRange): string[] | null;
}

const LIMITS = {
  headline: 100,
  summaryBullet: 100,
  title: 60,
  claim: 120,
  gist: 90,
  caption: 40,
  coverage: 60,
} as const;

export function assemblePack(
  commission: Commission,
  args: Record<string, unknown>,
): { ok: true; pack: ReviewPack } | { ok: false; error: string } {
  const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error: `Pack rejected: ${error}` });

  const headline = line(args.headline);
  if (headline === null) return refuse('headline is required — one plain sentence saying what the change does.');
  if (headline.length > LIMITS.headline) return refuse(overLimit('headline', LIMITS.headline, headline));
  const summary = text(args.summary);
  if (summary === null)
    return refuse(
      'summary is required — a short bulleted list, one line each, with the words that matter most in bold. ' +
        'Not a paragraph: the opening is the part every reader reads, and a block of prose is the part they skim.',
    );
  const long = summary.split('\n').find((l) => l.trim().length > LIMITS.summaryBullet);
  if (long !== undefined) return refuse(overLimit('a summary bullet', LIMITS.summaryBullet, long.trim()));
  const estimatedMinutes = args.estimatedMinutes;
  if (typeof estimatedMinutes !== 'number' || !Number.isFinite(estimatedMinutes) || estimatedMinutes < 0) {
    return refuse('estimatedMinutes must be a number — how long you expect the read to take.');
  }
  const fake = args.fake === undefined ? 'nothing' : line(args.fake);
  if (fake === null) return refuse('fake must be a sentence, or be left out to say "nothing".');
  if (!Array.isArray(args.ideas) || args.ideas.length === 0) {
    return refuse('ideas must be a non-empty list — a change with nothing in it to restate has no pack.');
  }

  const entryIds = new Set(commission.entries.map((e) => e.id));
  const entryAt = new Map(commission.entries.map((e) => [e.id, e.createdAt]));
  const ideas: ReviewIdea[] = [];
  const owned = new Map<string, string[]>();
  let plumbing = false;
  for (const [i, raw] of (args.ideas as unknown[]).entries()) {
    const at = `ideas[${i}]`;
    if (!isRecord(raw)) return refuse(`${at} must be an object.`);
    let id: string;
    if (raw.id === undefined) id = `idea_${nanoid(8)}`;
    else if (raw.id === PLUMBING_IDEA_ID) {
      if (plumbing) return refuse(`${at}.id: only one idea may be \`${PLUMBING_IDEA_ID}\`.`);
      plumbing = true;
      id = PLUMBING_IDEA_ID;
    } else {
      return refuse(
        `${at}.id: ids are minted by the harness; the one you may name is \`${PLUMBING_IDEA_ID}\`. Leave it out otherwise.`,
      );
    }
    const claim = line(raw.claim);
    if (claim === null) return refuse(`${at}.claim is required — one falsifiable sentence, for the checker.`);
    if (claim.length > LIMITS.claim) return refuse(overLimit(`${at}.claim`, LIMITS.claim, claim));
    const title = line(raw.title);
    if (title === null) return refuse(`${at}.title is required — the same thing said across a desk, for the person.`);
    if (title.length > LIMITS.title) return refuse(overLimit(`${at}.title`, LIMITS.title, title));
    if (!Array.isArray(raw.anchors) || raw.anchors.length === 0) {
      return refuse(
        `${at}.anchors must be a non-empty list — an idea is a claim plus a walk, and this one has no walk.`,
      );
    }
    const anchors: ReviewAnchor[] = [];
    const hunkIds: string[] = [];
    for (const [j, rawAnchor] of (raw.anchors as unknown[]).entries()) {
      const anchor = readAnchor(commission, rawAnchor, `${at}.anchors[${j}]`, entryIds, entryAt);
      if (!anchor.ok) return refuse(anchor.error);
      anchors.push(anchor.anchor);
      if (anchor.hunkId !== null) hunkIds.push(anchor.hunkId);
    }
    const claims: ReviewClaim[] = [];
    if (raw.claims !== undefined && !Array.isArray(raw.claims)) return refuse(`${at}.claims must be a list.`);
    for (const [j, rawClaim] of ((raw.claims ?? []) as unknown[]).entries()) {
      const claim = readClaim(rawClaim, `${at}.claims[${j}]`, entryIds);
      if (!claim.ok) return refuse(claim.error);
      claims.push(claim.claim);
    }
    const coverage: string[] = [];
    if (raw.coverage !== undefined && !Array.isArray(raw.coverage)) return refuse(`${at}.coverage must be a list.`);
    for (const [j, rawScenario] of ((raw.coverage ?? []) as unknown[]).entries()) {
      const scenario = line(rawScenario);
      if (scenario === null) {
        return refuse(`${at}.coverage[${j}] must be one short line naming a scenario the tests cover.`);
      }
      if (scenario.length > LIMITS.coverage) {
        return refuse(overLimit(`${at}.coverage[${j}]`, LIMITS.coverage, scenario));
      }
      coverage.push(scenario);
    }
    const dup = hunkIds.find((h, k) => hunkIds.indexOf(h) !== k);
    if (dup !== undefined) return refuse(`${at} anchors hunk ${dup} twice.`);
    if (id !== PLUMBING_IDEA_ID && testsOnlyIdea(commission.hunks, hunkIds)) {
      return refuse(
        `${at} ("${title}") owns nothing but test files, which makes it a tests section. Tests belong to the idea ` +
          'they exercise: give these hunks to it, and list what they cover as `coverage` lines under it.',
      );
    }
    if (id !== PLUMBING_IDEA_ID && ownsTestHunk(commission.hunks, hunkIds) && coverage.length === 0) {
      return refuse(
        `${at} ("${title}") owns the tests but lists no scenarios. Add \`coverage\`: one short line per case, ` +
          'named and not explained — it is the only place the reader is shown what the tests cover.',
      );
    }
    owned.set(id, hunkIds);
    ideas.push({ id, claim, title, cue: null, anchors, claims, coverage, attention: null });
  }

  const coverage = coverageRefusal(commission.hunks, owned);
  if (coverage !== null) return refuse(coverage);

  return {
    ok: true,
    pack: {
      schema: REVIEW_PACK_SCHEMA,
      prNumber: commission.prNumber,
      headSha: commission.headSha,
      headline,
      summary,
      estimatedMinutes,
      order: [],
      ideas,
      witnessed: commission.entries.length > 0,
      fake,
    },
  };
}

const AUTHOR_MARKS: readonly ReviewAnchorMark[] = ['key', 'disputed'];

function readAnchor(
  commission: Commission,
  raw: unknown,
  at: string,
  entryIds: ReadonlySet<string>,
  entryAt: ReadonlyMap<string, string>,
): { ok: true; anchor: ReviewAnchor; hunkId: string | null } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object.` };
  const gist = line(raw.gist);
  if (gist === null) return { ok: false, error: `${at}.gist is required — one line saying why the walk stops here.` };
  if (gist.length > LIMITS.gist) return { ok: false, error: overLimit(`${at}.gist`, LIMITS.gist, gist) };
  const caption = raw.caption === undefined || raw.caption === null ? null : line(raw.caption);
  if (caption === null && raw.caption !== undefined && raw.caption !== null) {
    return { ok: false, error: `${at}.caption must be one line, or be left out.` };
  }
  if (caption !== null && caption.length > LIMITS.caption) {
    return { ok: false, error: overLimit(`${at}.caption`, LIMITS.caption, caption) };
  }
  let mark: ReviewAnchorMark | null = null;
  if (raw.mark !== undefined && raw.mark !== null) {
    const found = AUTHOR_MARKS.find((m) => m === raw.mark);
    if (found === undefined) return { ok: false, error: `${at}.mark must be "key" or "disputed", or be left out.` };
    mark = found;
  }
  let note: ReviewNote | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    const read = readNote(raw.note, `${at}.note`, entryIds, entryAt);
    if (!read.ok) return read;
    note = read.note;
  }
  if (raw.kind === 'hunk') {
    const hunkId = line(raw.hunk);
    if (hunkId === null)
      return { ok: false, error: `${at}.hunk is required on a hunk anchor — the id from your prompt, e.g. "h3".` };
    const hunk = commission.hunks.find((h) => h.id === hunkId);
    if (!hunk)
      return { ok: false, error: `${at}.hunk: no such hunk ${hunkId} — the hunks are the ones listed in your prompt.` };
    return {
      ok: true,
      hunkId,
      anchor: { kind: 'hunk', range: hunk.range, code: hunk.code, gist, note, caption, mark },
    };
  }
  if (raw.kind === 'region') {
    const path = line(raw.path);
    if (path === null) return { ok: false, error: `${at}.path is required on a region anchor.` };
    const start = raw.start;
    const end = raw.end;
    if (!isLine(start) || !isLine(end) || end < start) {
      return { ok: false, error: `${at}: start and end must be 1-based line numbers with end >= start.` };
    }
    const range: ReviewRange = { path, start, end };
    const code = commission.readRegion(range);
    if (code === null) {
      return {
        ok: false,
        error: `${at}: ${path}:${start}-${end} is not in the tree at the head — check the path against your checkout and the range against the file's length.`,
      };
    }
    return { ok: true, hunkId: null, anchor: { kind: 'region', range, code, gist, note, caption, mark } };
  }
  return { ok: false, error: `${at}.kind must be "hunk" or "region".` };
}

function readNote(
  raw: unknown,
  at: string,
  entryIds: ReadonlySet<string>,
  entryAt: ReadonlyMap<string, string>,
): { ok: true; note: ReviewNote } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object with "by" and "text".` };
  const noteText = text(raw.text);
  if (noteText === null) return { ok: false, error: `${at}.text is required.` };
  if (raw.by === 'author') return { ok: true, note: { by: 'author', text: noteText } };
  if (raw.by === 'witness') {
    const entryId = line(raw.entryId);
    if (entryId === null || !entryIds.has(entryId)) {
      return {
        ok: false,
        error: `${at}.entryId must cite one of the witness log's entries (a scr_… id from your prompt); a witness note the log does not hold is an author note.`,
      };
    }
    return { ok: true, note: { by: 'witness', text: noteText, entryId, at: entryAt.get(entryId)! } };
  }
  return { ok: false, error: `${at}.by must be "witness" or "author".` };
}

function readClaim(
  raw: unknown,
  at: string,
  entryIds: ReadonlySet<string>,
): { ok: true; claim: ReviewClaim } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object with "text" and "provenance".` };
  const claimText = line(raw.text);
  if (claimText === null) return { ok: false, error: `${at}.text is required — one sentence that can be shown false.` };
  if (!isRecord(raw.provenance)) return { ok: false, error: `${at}.provenance is required — {kind, entryId?}.` };
  const kind = raw.provenance.kind;
  let provenance: ReviewProvenance;
  if (kind === 'inferred') provenance = { kind: 'inferred' };
  else if (kind === 'witnessed' || kind === 'disputed') {
    const entryId = line(raw.provenance.entryId);
    if (entryId === null || !entryIds.has(entryId)) {
      return {
        ok: false,
        error: `${at}.provenance.entryId must cite one of the witness log's entries (a scr_… id from your prompt) on a "${kind}" claim; a claim the log says nothing about is "inferred".`,
      };
    }
    provenance = { kind, entryId };
  } else return { ok: false, error: `${at}.provenance.kind must be "witnessed", "inferred" or "disputed".` };
  return { ok: true, claim: { text: claimText, provenance, verdict: null, evidence: null, finding: null } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function overLimit(at: string, max: number, value: string): string {
  return (
    `${at} is ${value.length} characters and the limit is ${max}. Say it in fewer words rather than abbreviating: ` +
    `the shortest plain wording, one idea, no clauses hung off dashes. Was: "${value}"`
  );
}

function line(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
