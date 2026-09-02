import type { ObstacleKeyKind } from '../types.js';

/**
 * Where a key comes from: extraction, validation and grounding.
 *
 * **Not from an agent filling in a form.** An agent that has to classify its own
 * observation is an agent that classifies it wrongly, and a design that depends on
 * agents being disciplined about a schema is a design that fails quietly on the day
 * they are not. So the key is extracted from what the agent wrote plus the dispatch
 * it came from, and then put through three gates.
 *
 * The gates fail in one direction only. **A key that does not resolve is dropped
 * and the claim is kept** — never refused: a refusal an agent cannot satisfy is a
 * report that was never filed, and that is the one loss this store cannot recover
 * from.
 *
 * Pure — no I/O, no clock, no store. What the world holds arrives as
 * {@link ObstacleWorld}, so the gates can be tested without one.
 * → `docs/spec/32-obstacles.md#where-a-key-comes-from`
 */

/** A key before any gate has looked at it. */
export interface KeyCandidate {
  kind: ObstacleKeyKind;
  value: string;
}

/** A key that has been through all three gates. */
export interface GatedKey extends KeyCandidate {
  /**
   * Whether it may resolve an obstacle. False for `signature` and `cmd`, which
   * never bind, and false for a key that validated but is outside what the harness
   * knows about this dispatch — *plausible* error is what grounding catches, and a
   * plausible wrong key is a silent wrong merge arriving through the back door.
   */
  binds: boolean;
}

/**
 * What the gates are run against: what the harness is reporting, and what it knows
 * about *this* dispatch.
 *
 * Two sets rather than one because validation and grounding ask different
 * questions. Validation asks whether a key names anything real at all — a check
 * some provider is reporting, a path in the tree. Grounding asks whether it is
 * consistent with the dispatch the report came from. A key that passes the first
 * and fails the second is recorded as a suggestion rather than dropped, because it
 * is not nonsense, only unplaced.
 */
export interface ObstacleWorld {
  /** Every check name the provider is reporting anywhere, plus this dispatch's own. */
  readonly checks: readonly string[];
  /** The checks *this dispatch* is about — `Task.ciChecks`. The grounding set. */
  readonly dispatchChecks: readonly string[];
  /** Whether a repository path exists in the tree. */
  hasPath(path: string): boolean;
  /** The files this dispatch's branch has touched. The grounding set for paths. */
  readonly branchPaths: readonly string[];
}

/**
 * Words that say the sentence is about something *failing*, which is what lets a
 * dispatch's own checks be read into a report that never names one.
 *
 * *"there's a flakey test"* on a dispatch about `test (windows)` yields
 * `check:test (windows)`, and it is the dispatch rather than the prose that
 * supplies the name — which is the whole of why extraction beats a form. Closed and
 * small, like every other word list in this repository.
 */
const FAILING =
  /\b(fail(?:s|ed|ing|ure)?|flak(?:e|ey|y|ing)|red|broken|breaks?|hang(?:s|ing)?|timing out|times? out|timeouts?|wedged|stuck|erroring)\b/i;

/** A path-shaped token: a slash, and no wildcards or placeholders. */
const PATH_TOKEN = /(?:^|[\s`'"(])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=[\s`'".,;:)]|$)/g;

/** A test file, which is the half of a test key the tree can be asked about. */
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/;

/** A command an agent reports having run: the repository's own runners. */
const CMD_TOKEN = /\b((?:npm|npx|node|git|tsc|docker|make|pnpm|yarn)(?:\s+[A-Za-z0-9:._/-]+){1,3})/;

/**
 * Everything the harness can read out of one report.
 *
 * Deliberately generous: a candidate costs nothing, because every one of them is
 * then checked against the world and dropped if it names nothing. What it must not
 * do is *invent* — every value here is a substring of what the agent wrote or a
 * name the dispatch already carried.
 */
export function extractKeys(input: {
  what: string;
  evidence: string;
  world: ObstacleWorld;
  /** Keys the agent named itself. They go through the same three gates. */
  declared?: readonly KeyCandidate[];
}): KeyCandidate[] {
  const text = `${input.what}\n${input.evidence}`;
  const out: KeyCandidate[] = [...(input.declared ?? [])];

  // A check the report names outright, in the provider's own spelling. Exact and
  // never a prefix — a check name is a provider identifier, and a prefix match puts
  // another job's history in front of an agent under a name it reads as its own.
  for (const check of input.world.checks) {
    if (check !== '' && text.toLowerCase().includes(check.toLowerCase())) out.push({ kind: 'check', value: check });
  }
  // The dispatch's own checks, where the report is about something failing and
  // named none of them itself. This is the *"there's a flakey test"* case, and the
  // reason the key is extracted rather than asked for.
  if (FAILING.test(text)) {
    for (const check of input.world.dispatchChecks) out.push({ kind: 'check', value: check });
  }
  for (const match of text.matchAll(PATH_TOKEN)) {
    const value = match[1]!;
    out.push({ kind: TEST_FILE.test(value) ? 'test' : 'path', value });
  }
  const signature = errorSignature(input.evidence);
  if (signature !== null) out.push({ kind: 'signature', value: signature });
  const cmd = CMD_TOKEN.exec(text);
  if (cmd !== null) out.push({ kind: 'cmd', value: cmd[1]!.trim() });

  return dedupe(out);
}

/**
 * The normalised first line of an error: paths relativised, hex, numbers and
 * timestamps blanked, lowercased.
 *
 * It is checked against nothing and it never binds, which is the whole point —
 * what is being normalised is somebody else's output and outside this
 * repository's control. A runner image changes its error prefix and one obstacle
 * silently becomes two, or worse, two become one.
 * → `docs/spec/32-obstacles.md#signature-and-cmd-do-not-bind`
 */
function errorSignature(evidence: string): string | null {
  const line = evidence
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /\b(error|exception|failed|assert)/i.test(l));
  if (line === undefined) return null;
  const normalised = line
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t?[\d:.]*z?\b/g, '<t>')
    .replace(/(?:\/[\w.-]+)*\/([\w.-]+\.[a-z]+)/g, '$1')
    .replace(/\b0x[0-9a-f]+\b/g, '<x>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<x>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalised === '' ? null : normalised;
}

/**
 * The second and third gates, run together because a key only ever reaches one
 * verdict: dropped, suggesting, or binding.
 *
 * **Validated** against the world: a `check` must name a check the provider is
 * reporting or the dispatch is about, a `path` must exist in the tree, a `test`
 * must name a file that does. What fails is dropped and the claim is kept.
 *
 * **Grounded** against this dispatch: the checks it was dispatched about, the
 * files its branch touches. A key outside that set validated, so it is not
 * nonsense — it is recorded as a suggestion. Validation catches nonsense, not
 * plausible error, and a *plausible* wrong key is a silent wrong merge arriving
 * through the back door.
 *
 * **What grounds a `test` or a `path` is either half of what the harness knows.**
 * The branch's own files are one, and they are the wrong half for most honest
 * reports: an agent saying a test is not its doing is saying precisely that the
 * file is not in its diff. The other half is the dispatch's checks — a report
 * carrying a *grounded* check key names the check the harness dispatched it about,
 * and the file named beside that check is that check's own reporting rather than a
 * file the agent thought of. Neither half present is a suggestion, which is what
 * keeps a path an agent merely mentioned from binding.
 */
export function gateKeys(candidates: readonly KeyCandidate[], world: ObstacleWorld): GatedKey[] {
  const checks = new Set(world.checks.map((c) => c.toLowerCase()));
  const dispatched = new Set(world.dispatchChecks.map((c) => c.toLowerCase()));
  const branch = new Set(world.branchPaths.map((p) => p.toLowerCase()));

  // First pass: validate, and ground everything a second key cannot help.
  const gated: (GatedKey & { file?: string })[] = [];
  for (const candidate of dedupe(candidates)) {
    const value = candidate.value.trim();
    if (value === '') continue;
    switch (candidate.kind) {
      case 'check': {
        if (!checks.has(value.toLowerCase())) continue;
        gated.push({ kind: 'check', value, binds: dispatched.has(value.toLowerCase()) });
        break;
      }
      case 'test': {
        // The file half is what the tree can be asked about; a test key with no
        // file in it is a sentence, and this store's whole premise is that identity
        // is not one.
        const file = testFile(value);
        if (file === null || !world.hasPath(file)) continue;
        gated.push({ kind: 'test', value, binds: branch.has(file.toLowerCase()), file });
        break;
      }
      case 'path': {
        if (!world.hasPath(value)) continue;
        gated.push({ kind: 'path', value, binds: branch.has(value.toLowerCase()), file: value });
        break;
      }
      // Suggestion-only, and not because they cannot be checked *today*: the rows
      // record how often a signature suggestion was confirmed, and a signature
      // right for a quarter is promoted by a change that says so. Starting bound
      // and demoting later is not the same move — the bad merges it makes in the
      // meantime are invisible.
      case 'signature':
      case 'cmd':
        gated.push({ kind: candidate.kind, value, binds: false });
        break;
    }
  }

  // Second pass: the other half of grounding. A grounded check is the harness's
  // own statement that this dispatch is about that check, so what the report names
  // beside it is that check's reporting.
  const viaCheck = gated.some((key) => key.kind === 'check' && key.binds);
  return gated.map(({ file: _file, ...key }) => ({
    ...key,
    binds: key.binds || (viaCheck && (key.kind === 'test' || key.kind === 'path')),
  }));
}

/** The file half of a test key, or null when it has none. */
function testFile(value: string): string | null {
  const file = value.split(/[\s>#]|::/)[0] ?? '';
  return TEST_FILE.test(file) ? file : null;
}

/** One key per (kind, value), first spelling wins. */
function dedupe<T extends KeyCandidate>(keys: readonly T[]): T[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = `${key.kind}:${key.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
