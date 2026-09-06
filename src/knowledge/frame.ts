// → docs/spec/27-obstacles.md

interface FramedClaim {
  claim: string;
  removed: string | null;
}

const FUNCTION_WORDS = new Set([
  'a',
  'about',
  'affecting',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'for',
  'from',
  'here',
  'in',
  'is',
  'it',
  'nothing',
  'of',
  'on',
  'only',
  'or',
  'related',
  'seen',
  'so',
  'the',
  'this',
  'to',
  'under',
  'unrelated',
  'was',
  'were',
  'when',
  'while',
  'with',
  'within',
]);

function mentions(kind: 'issue' | 'pr', number: string): RegExp {
  const words = kind === 'pr' ? 'pull request|pull-request|pr' : 'issue|ticket|work item|work-item';
  return new RegExp(String.raw`(?:\b(?:${words})\b[\s:#-]*|#)${number}\b(?::[a-z]+)?`, 'gi');
}

export function stripOwnFrame(claim: string, originRef: string | null): FramedClaim {
  const parsed = originRef === null ? null : /^(issue|pr):(\d+)/.exec(originRef.toLowerCase());
  if (parsed === null) return { claim, removed: null };
  const [, kind, number] = parsed as unknown as [string, 'issue' | 'pr', string];
  const stripped = tidy(claim.replace(mentions(kind, number), ' '));
  if (stripped === '' || stripped === tidy(claim)) return { claim, removed: null };
  return { claim: stripped, removed: `${kind}:${number}` };
}

function tidy(text: string): string {
  let out = text.replace(/[ \t]+/g, ' ').replace(/ ([,.;:!?])/g, '$1');
  const tail = /[,;—–-]\s*([^,;—–-]*?)\s*([.!?]?)$/.exec(out);
  if (tail !== null) {
    const words = tail[1]!.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0 && words.every((word) => FUNCTION_WORDS.has(word))) {
      out = `${out.slice(0, tail.index)}${tail[2] ?? ''}`;
    }
  }
  for (;;) {
    const dangling = /(^|\s)(\w+)\s*([.!?]?)$/.exec(out);
    if (dangling === null) break;
    if (!FUNCTION_WORDS.has(dangling[2]!.toLowerCase())) break;
    const rest = out.slice(0, dangling.index);
    if (rest.trim() === '') break;
    out = `${rest}${dangling[3] ?? ''}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}
