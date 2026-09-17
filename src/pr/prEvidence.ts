import { PLAINNESS, plainnessRefusal, readingEase, stripCode } from '../reviewPacks/plainness.js';
import type { DiffFacts } from './prDiff.js';
import { renderDiffFacts } from './prDiff.js';

// → docs/spec/07-pull-requests.md#the-four-questions-a-reviewer-has

export const PR_EVIDENCE = {
  entries: 4,
  entryChars: 140,
} as const;

/**
 * What the agent supplies for the four questions a reviewer has to answer for
 * themselves. Every field is a list of one-line entries, and every entry but a
 * `decided` one carries a coordinate — a path the diff touches, with a line if the
 * agent has one.
 */
export interface PrEvidence {
  satisfies: string[];
  decided: string[];
  oneWay: string[];
  unverified: string[];
  reach: string[];
}

export const EMPTY_EVIDENCE: PrEvidence = {
  satisfies: [],
  decided: [],
  oneWay: [],
  unverified: [],
  reach: [],
};

export interface EvidenceContext {
  /** The ask, as the plan recorded it. Empty for a pickup, which has no part. */
  criteria: string[];
  /** What the clone read off the diff, or null when it could not read one. */
  facts: DiffFacts | null;
}

interface FieldRule {
  key: keyof PrEvidence;
  heading: string;
  coordinate: boolean;
}

const FIELDS: readonly FieldRule[] = [
  { key: 'satisfies', heading: 'Asked for, and where it is met', coordinate: true },
  { key: 'oneWay', heading: 'Cannot be undone', coordinate: true },
  { key: 'unverified', heading: 'Not verified', coordinate: true },
  { key: 'reach', heading: 'How far it reaches', coordinate: true },
  { key: 'decided', heading: 'Decided, where the ask did not say', coordinate: false },
];

/**
 * Words that answer the reviewer's question for them.
 *
 * Every one is a verdict wearing the clothes of a fact, and each is the cheapest
 * thing to write when there is nothing to say. Refusing them is not a style rule: a
 * body that calls itself safe has spent the reviewer's attention telling them what
 * they came to decide.
 */
const REASSURANCE = [
  'safe',
  'simple',
  'simply',
  'straightforward',
  'minimal',
  'trivial',
  'trivially',
  'comprehensive',
  'comprehensively',
  'robust',
  'seamless',
  'thoroughly',
  'obviously',
  'clearly',
  'no impact',
  'no risk',
  'low risk',
  'should be fine',
  'fully tested',
  'well tested',
] as const;

const KNOWN_EXTENSION = /\.(?:tsx?|jsx?|json|md|sql|css|ya?ml|sh|toml)(?::\d+(?:-\d+)?)?$/;

const PATH_TOKEN = /^[\w@./-]+\.[A-Za-z][A-Za-z0-9]{0,5}(?::\d+(?:-\d+)?)?$/;

/** The path-looking tokens in an entry, each with its optional `:line` still on it. */
export function coordinates(entry: string): string[] {
  return entry
    .split(/[\s,;()[\]`"'<>]+/)
    .map((token) => token.replace(/[.,;:]+$/, ''))
    .filter((token) => PATH_TOKEN.test(token))
    .filter((token) => token.includes('/') || KNOWN_EXTENSION.test(token));
}

function pathOf(coordinate: string): string {
  return coordinate.replace(/:\d+(?:-\d+)?$/, '');
}

function namesAChangedFile(entry: string, files: readonly string[]): boolean {
  return coordinates(entry).some((coordinate) => {
    const path = pathOf(coordinate);
    return files.some((file) => file === path || file.endsWith(`/${path}`) || file.startsWith(`${path}/`));
  });
}

function reassurance(entry: string): string | null {
  const prose = stripCode(entry).toLowerCase();
  return REASSURANCE.find((word) => new RegExp(`\\b${word.replace(/[ ]/g, '[\\s-]')}\\b`).test(prose)) ?? null;
}

/**
 * What a pull request's evidence is refused for, or null if a reviewer could use it.
 *
 * The rules assert one thing between them: **every entry is a coordinate a reviewer
 * can check, not a conclusion they have to take.** A claim with a pointer is a place
 * to look, and one without is an opinion — so the shape is the whole of it, and none
 * of these arms reads a word of what the entry says about the change itself.
 *
 * Which fields are *owed* comes from the diff (`ctx.facts`), so a change that touches
 * no one-way surface is never asked about one. Facts of `null` is a clone that could
 * not read the diff, and every trigger resting on it fails open.
 */
export function evidenceRefusal(evidence: PrEvidence, ctx: EvidenceContext): string | null {
  const owed = fieldsOwed(ctx);

  for (const field of FIELDS) {
    const entries = evidence[field.key].map((e) => e.trim()).filter((e) => e !== '');
    const because = owed.get(field.key);
    if (entries.length === 0) {
      if (because === undefined) continue;
      return `\`${field.key}\` is empty and this change owes it: ${because}`;
    }

    const cap = field.key === 'satisfies' ? Math.max(ctx.criteria.length, PR_EVIDENCE.entries) : PR_EVIDENCE.entries;
    if (entries.length > cap) {
      return (
        `\`${field.key}\` has ${entries.length} entries and the limit is ${cap}. This is what a reviewer reads ` +
        `before the diff, so name the ones that would change their mind and leave the rest to the diff.`
      );
    }

    for (const entry of entries) {
      if (entry.length > PR_EVIDENCE.entryChars) {
        return (
          `a \`${field.key}\` entry runs ${entry.length} characters and the limit is ${PR_EVIDENCE.entryChars}. ` +
          `One line each. Was: "${entry}"`
        );
      }
      const word = reassurance(entry);
      if (word !== null) {
        return (
          `a \`${field.key}\` entry says "${word}", which answers the reviewer's question for them. Give them ` +
          `what they would need to decide it and let them decide it. Was: "${entry}"`
        );
      }
      const plain = plainnessRefusal(`a \`${field.key}\` entry`, entry);
      if (plain !== null) return plain;
    }

    const shape = shapeRefusal(field, entries, ctx);
    if (shape !== null) return shape;
  }

  const prose = FIELDS.flatMap((f) => evidence[f.key]);
  const { ease: score, hardest } = readingEase(prose);
  if (prose.length > 0 && score < PLAINNESS.readingEase) {
    return (
      `the evidence scores ${Math.round(score)} for reading ease and the floor is ${PLAINNESS.readingEase}, about ` +
      `a newspaper. A reviewer reads this to decide something. These read hardest:\n` +
      hardest.map((s) => `- "${s}"`).join('\n')
    );
  }
  return null;
}

function shapeRefusal(field: FieldRule, entries: readonly string[], ctx: EvidenceContext): string | null {
  if (field.key === 'satisfies' && ctx.criteria.length > 0 && entries.length !== ctx.criteria.length) {
    return (
      `\`satisfies\` has ${entries.length} entries and this part has ${ctx.criteria.length} acceptance criteria. ` +
      `One entry per criterion, in this order, each naming where it is met, or "not met: <why>" for one that is ` +
      `not:\n` +
      numbered(ctx.criteria)
    );
  }

  if (field.key === 'decided') {
    const loose = entries.find((e) => !/,\s+not\s+\S/.test(e));
    if (loose !== undefined) {
      return (
        `a \`decided\` entry does not say what it was decided against. Write it as "X, not Y": the fork is the ` +
        `whole of the information, and the road not taken is what a reviewer would argue with. Was: "${loose}"`
      );
    }
    return null;
  }

  if (!field.coordinate) return null;

  for (const entry of entries) {
    if (field.key === 'satisfies' && /^not met:\s*\S/i.test(entry)) continue;
    const found = coordinates(entry);
    if (found.length === 0) {
      return (
        `a \`${field.key}\` entry names no place in the code. Every entry carries a coordinate, ` +
        `\`path/to/file.ts:41\`, because a reviewer has to be able to go and disagree with it in one click. ` +
        `Was: "${entry}"`
      );
    }
    if (ctx.facts !== null && !namesAChangedFile(entry, ctx.facts.files)) {
      return (
        `a \`${field.key}\` entry names ${found.map((c) => `\`${c}\``).join(', ')}, and this pull request changes ` +
        `no such file. Point at a file in the diff. Was: "${entry}"`
      );
    }
  }
  return null;
}

function numbered(lines: readonly string[]): string {
  return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

/**
 * Which fields this change owes, and why, in the sentence the refusal quotes back.
 *
 * `reach` is owed by every code change, deliberately and alone: how far a change
 * carries if it is wrong is live on all of them, and it is the question this
 * codebase's own quiet failures are all instances of. The rest are owed only where
 * the diff shows the surface, so a change that touches nothing one-way is never
 * asked to invent a one-way door.
 */
function fieldsOwed(ctx: EvidenceContext): Map<keyof PrEvidence, string> {
  const owed = new Map<keyof PrEvidence, string>();
  if (ctx.criteria.length > 0) {
    owed.set(
      'satisfies',
      `this part has ${ctx.criteria.length} acceptance criteria, and where each is met is the first thing a ` +
        `reviewer checks:\n` +
        numbered(ctx.criteria),
    );
  }
  const facts = ctx.facts;
  if (facts === null) return owed;

  if (facts.oneWay.length > 0) {
    owed.set(
      'oneWay',
      `the diff touches ${facts.oneWay.map((t) => t.label).join('; ')}. Name what a revert would not take back.`,
    );
  }
  if (facts.codeChanged) {
    owed.set('reach', 'it changes code that runs. Name what runs it, and whether anything gates it.');
    if (!facts.testsChanged) {
      owed.set(
        'unverified',
        'it changes code and no test under `test/` changed with it. Name what nothing pins, and anything you ' +
          'left out on purpose.',
      );
    }
  }
  return owed;
}

/**
 * The evidence block, rendered by the harness between the agent's bullets and the
 * issue reference.
 *
 * The shape is the harness's so a reviewer learns where to look once, and a field
 * nobody filled says so rather than closing up: `_none named_` is the agent's answer
 * on the record, which an absent heading would not be.
 */
export function renderEvidence(input: {
  evidence: PrEvidence;
  criteria: string[];
  issueNumber: number;
  issueTitle: string;
  facts: DiffFacts | null;
}): string {
  const { evidence, criteria, facts } = input;
  const out: string[] = [];

  out.push('**Asked for**, as the plan recorded it');
  if (criteria.length > 0) {
    out.push(...criteria.map((c, i) => `${i + 1}. ${c} → ${evidence.satisfies[i] ?? '_none named_'}`));
  } else {
    out.push(`- #${input.issueNumber} ${input.issueTitle}`);
    out.push('- No acceptance criteria were recorded for this work.');
    out.push(...evidence.satisfies.map((e) => `- ${e}`));
  }

  for (const field of FIELDS) {
    if (field.key === 'satisfies') continue;
    const entries = evidence[field.key].map((e) => e.trim()).filter((e) => e !== '');
    out.push('', `**${field.heading}**`);
    out.push(...(entries.length > 0 ? entries.map((e) => `- ${e}`) : ['- _none named_']));
  }

  out.push('', '**The diff**, read off the clone rather than written by the author');
  out.push(...(facts === null ? ['- The clone could not read this diff.'] : renderDiffFacts(facts)));

  return out.join('\n');
}
