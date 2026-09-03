/**
 * Taking the caller's own task out of the claim it raised
 * (`docs/spec/27-obstacles.md#the-intake`).
 *
 * An agent working `pr:512` writes down what it saw: *"test X is flaky and nothing
 * to do with PR 512."* Every word of it is true, and it is the wrong sentence —
 * because it was written to whoever is reading PR 512, and PR 512 is the one place
 * this claim will never be needed again.
 *
 * It costs twice, and the second cost is the expensive one. The claim is not a
 * statement about the repository, so an agent that meets it in a prompt next month
 * has to work out whose task it was and whether any of it still applies. And the
 * ref is **inside the claim key**, so no other agent's wording can equal it or
 * contain it: the claim most in need of being found again is the one `claimsMatch`
 * can never find, and every wall hit on a different goal files a fresh singleton.
 *
 * **A mechanical edit and never a semantic one.** The only thing removed is a ref
 * the harness can prove redundant, because it holds it — resolved from the
 * caller's own credential. Nothing here judges whether prose is "about the
 * repository", ranks a claim's wording, or rewrites a sentence it merely dislikes:
 * that is a classifier, it would be wrong in a way no test could see, and the agent
 * would have no way to tell that what it filed is not what it said.
 *
 * Pure — no I/O, no clock, no store.
 */

/** What a strip did, so the caller can say so rather than doing it quietly. */
interface FramedClaim {
  /** The claim with the caller's own ref out of it, or the claim unchanged. */
  claim: string;
  /** The ref that was removed, or null when the claim never named it. */
  removed: string | null;
}

/**
 * The function words a fragment may be made **entirely** of and still carry no
 * assertion.
 *
 * This is what lets the tidy-up be provable rather than a judgement: *"and nothing
 * to do with"* left behind by a removed ref is a fragment of nothing but these, so
 * dropping it removes no claim — where *"and the retry loop"* keeps a noun and is
 * therefore left exactly where the agent put it, dangling or not. A closed set, and
 * deliberately a small one: every word added to it is a word the harness may delete
 * from somebody's sentence.
 */
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

/**
 * Every spelling of one ref an agent actually types: the harness's own colon form,
 * the tracker's, and the bare number a person would write.
 *
 * Anchored on the number so `pr:512` never matches `pr:5120`, and built per call
 * because the number is the caller's. The bare `#512` form is included and the
 * bare `512` form deliberately is not: a number on its own is as likely to be a
 * port, a status code or a line as it is to be this task.
 */
function mentions(kind: 'issue' | 'pr', number: string): RegExp {
  const words = kind === 'pr' ? 'pull request|pull-request|pr' : 'issue|ticket|work item|work-item';
  return new RegExp(String.raw`(?:\b(?:${words})\b[\s:#-]*|#)${number}\b(?::[a-z]+)?`, 'gi');
}

/**
 * Take the caller's own origin out of the claim, and say whether anything moved.
 *
 * The claim is returned unchanged whenever the edit would leave nothing behind —
 * a claim that was only its own ref is a claim the harness cannot improve, and an
 * empty one is a row nobody can read. Filing has never been what puts a sentence in
 * front of the fleet, so a badly framed row costs almost nothing; a row that was
 * never filed costs the whole purpose.
 */
export function stripOwnFrame(claim: string, originRef: string | null): FramedClaim {
  const parsed = originRef === null ? null : /^(issue|pr):(\d+)/.exec(originRef.toLowerCase());
  if (parsed === null) return { claim, removed: null };
  const [, kind, number] = parsed as unknown as [string, 'issue' | 'pr', string];
  const stripped = tidy(claim.replace(mentions(kind, number), ' '));
  if (stripped === '' || stripped === tidy(claim)) return { claim, removed: null };
  return { claim: stripped, removed: `${kind}:${number}` };
}

/**
 * What a removed ref leaves behind: doubled spaces, a comma against a full stop,
 * and — where the whole tail of the sentence was the ref's own clause — a fragment
 * of function words with nothing left to say.
 *
 * The fragment rule is the only one here that removes more than whitespace, and it
 * is held to {@link FUNCTION_WORDS} for that reason: a tail carrying any word that
 * is not on that list is a tail carrying an assertion, and it stays.
 */
function tidy(text: string): string {
  let out = text.replace(/[ \t]+/g, ' ').replace(/ ([,.;:!?])/g, '$1');
  // A trailing clause the ref was the whole content of — ", and nothing to do with"
  // — split on the separator the agent themselves wrote.
  const tail = /[,;—–-]\s*([^,;—–-]*?)\s*([.!?]?)$/.exec(out);
  if (tail !== null) {
    const words = tail[1]!.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0 && words.every((word) => FUNCTION_WORDS.has(word))) {
      out = `${out.slice(0, tail.index)}${tail[2] ?? ''}`;
    }
  }
  // A sentence that now ends on the preposition its ref was the object of — "and
  // nothing to do with". One word at a time and only while every word taken is a
  // function word, so the trim stops the moment it reaches something that asserts
  // anything: a loop is what makes the stopping condition the words rather than an
  // arbitrary count of them.
  for (;;) {
    const dangling = /(^|\s)(\w+)\s*([.!?]?)$/.exec(out);
    if (dangling === null) break;
    if (!FUNCTION_WORDS.has(dangling[2]!.toLowerCase())) break;
    const rest = out.slice(0, dangling.index);
    // Never down to nothing: a claim that was only its own frame is one the
    // harness cannot improve, and `stripOwnFrame` files it as written.
    if (rest.trim() === '') break;
    out = `${rest}${dangling[3] ?? ''}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}
