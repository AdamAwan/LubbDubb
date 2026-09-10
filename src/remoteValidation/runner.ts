import { exec } from 'node:child_process';

// → docs/spec/36-remote-validation.md#the-runner-contract

/**
 * What the parameters of a run are, whichever of the three commands is being invoked. Every one of
 * them rides in the spawn env: a command is **never** assembled from them, and the command itself
 * comes only from committed project config.
 */
export interface RunnerRequest {
  environment: string;
  /** The project's own command, verbatim from `validate.browser`. */
  command: string;
  /** The suite's own name for this place, where the environment declares one. */
  profile: string | null;
  /** `resolveTenant(...).value` — never a `tenantEnv`'s variable name, and never invented. */
  tenant: string | null;
  selectors: readonly string[];
  reportDir: string | null;
}

/** One area the deployed runner says it offers, and how many tests it holds where it counted them. */
interface SelectorOffer {
  selector: string;
  tests: number | null;
}

export interface SelectorListing {
  /** What the runner offers. **Null means it could not say** — never an empty offering. */
  offers: SelectorOffer[] | null;
  /** Why it could not say, in the words an operator is told. Null where it answered. */
  detail: string | null;
}

export interface RunnerOutcome {
  /** What the command printed, first line. Null where the invocation answered nothing at all. */
  said: string | null;
  /** Why it could not be carried out. Null where it ran — **an exit code is never a row outcome**. */
  detail: string | null;
}

/**
 * `validate.browser.listSelectors`, `validate.browser.runner` and `validate.browser.publishArtefacts`
 * — three live shell commands against a real environment, behind one injectable seam. A test without
 * the fake drives a browser against somebody's acceptance environment and passes while doing it.
 */
export interface RemoteRunner {
  listSelectors(request: RunnerRequest): Promise<SelectorListing>;
  run(request: RunnerRequest): Promise<RunnerOutcome>;
  publishArtefacts(request: RunnerRequest): Promise<RunnerOutcome>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** The one character `LUBBDUBB_SELECTORS` is joined on, and the one an area may therefore not hold. */
const SELECTOR_DELIMITER = ',';

/**
 * The parameters of a run, as the spawn env alone. Exported because it is the one place they are
 * written, and the one place a test can read what a real spawn would carry without spawning one.
 */
export function runnerEnv(request: RunnerRequest): Record<string, string> {
  const env: Record<string, string> = { LUBBDUBB_ENVIRONMENT: request.environment };
  if (request.profile !== null) env['LUBBDUBB_PROFILE'] = request.profile;
  if (request.tenant !== null) env['LUBBDUBB_TENANT'] = request.tenant;
  if (request.selectors.length > 0) env['LUBBDUBB_SELECTORS'] = request.selectors.join(SELECTOR_DELIMITER);
  if (request.reportDir !== null) env['LUBBDUBB_REPORT_DIR'] = request.reportDir;
  return env;
}

/**
 * Longer than any area anybody names, and the length at which a line stops being a name and starts
 * being prose. It is a refusal threshold, never a truncation.
 */
const MAX_SELECTOR_LENGTH = 120;

/**
 * Why this area can never reach a runner, in the words an operator is told. Null where it can.
 *
 * The selectors of a run reach the command as one comma-joined variable, and nothing else in this
 * design forbids a comma in an area — so an area holding one is silently split by the project into
 * selectors that do not exist, and the rows block for a reason neither side can see. Areas are
 * operator-authored free text, so `Reports, exports` is an ordinary thing to type.
 */
export function selectorFault(area: string): string | null {
  if (!area.includes(SELECTOR_DELIMITER)) return null;
  return (
    `this check's area \`${area}\` holds a \`${SELECTOR_DELIMITER}\`, which is the character the run's ` +
    'selectors are joined on in `LUBBDUBB_SELECTORS`. A runner reading that variable would be handed ' +
    'two selectors that do not exist rather than this one that does, so nothing here can be run until ' +
    'the area is reworded without it.'
  );
}

/**
 * What a listing came back as. A JSON array of `{selector, tests}` where the runner counts, a JSON
 * array of names where it does not, or one name per line. A selector **names an area, never a file
 * path**, and nothing here reasons about tags: the harness passes the selector it is told.
 *
 * A suite's own config prints ahead of its report — a dotenv banner is the common case — so the JSON
 * form is **sought** in the output rather than required at byte 0. Seeking the first `{` is not
 * enough: a banner holds one. What is sought is a balanced JSON *array*, tried at each `[`.
 *
 * And a line-form listing that does not look like a listing is **refused**, not read: a banner read
 * as one name per line yields offers no check can match, and every row then blocks naming a renamed
 * area against a runner that offered exactly the right ones. That is this arm's own stated danger
 * one step out — an empty listing read as an answer is every selector matching zero, and a garbage
 * listing read as an answer is the same shape. Refusing is legible where guessing is not.
 */
export function parseSelectorListing(stdout: string): SelectorListing {
  const text = stdout.trim();
  if (text === '')
    return {
      offers: null,
      detail:
        'the listing printed nothing. Nothing was learned about which selectors this runner offers, ' +
        'so no check row can be verified against it.',
    };
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { offers: null, detail: 'the listing began a JSON array and did not parse as one.' };
    }
    if (!Array.isArray(parsed)) return { offers: null, detail: 'the listing was not a list of selectors.' };
    return { offers: offersOf(parsed), detail: null };
  }
  const embedded = embeddedJsonArray(text);
  if (embedded !== null) return { offers: offersOf(embedded), detail: null };
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const prose = lines.find((line) => !looksLikeSelector(line));
  if (prose !== undefined)
    return {
      offers: null,
      detail:
        `the listing is not a list of selectors — it holds \`${prose.slice(0, 80)}\`, which is output about ` +
        'the run rather than an area name. Nothing was learned about which selectors this runner offers, ' +
        'because a banner read as one name per line offers areas that do not exist.',
    };
  return { offers: lines.map((selector) => ({ selector, tests: null })), detail: null };
}

/** A line that is an area name, rather than a banner, a tip or a path the suite printed beside one. */
function looksLikeSelector(line: string): boolean {
  return line.length <= MAX_SELECTOR_LENGTH && !line.includes('{') && !line.includes('}') && !line.includes('//');
}

/**
 * The first balanced JSON array in the output that parses. Tried at each `[` rather than at the
 * first, because a banner's own brackets parse as nothing and must not stop the search.
 */
function embeddedJsonArray(text: string): unknown[] | null {
  for (let at = text.indexOf('['); at !== -1; at = text.indexOf('[', at + 1)) {
    const end = balancedEnd(text, at);
    if (end === null) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(at, end));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/** Where the array opening at `from` closes, string literals and their escapes respected. */
function balancedEnd(text: string, from: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = from; at < text.length; at += 1) {
    const ch = text[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return at + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function offersOf(entries: readonly unknown[]): SelectorOffer[] {
  const offers: SelectorOffer[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      offers.push({ selector: entry.trim(), tests: null });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const selector = record['selector'];
    if (typeof selector !== 'string' || selector.trim() === '') continue;
    const tests = record['tests'];
    offers.push({ selector: selector.trim(), tests: typeof tests === 'number' && tests >= 0 ? tests : null });
  }
  return offers;
}

export class CommandRemoteRunner implements RemoteRunner {
  constructor(
    private readonly repoRoot: string,
    /** `remoteValidation.runTimeoutMs` — the kill for a **runner** invocation, and for nothing else. */
    private readonly runTimeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async listSelectors(request: RunnerRequest): Promise<SelectorListing> {
    const said = await this.spawn(request, this.timeoutMs);
    if (said.failed !== null) return { offers: null, detail: said.failed };
    return parseSelectorListing(said.stdout);
  }

  /**
   * The one invocation `remoteValidation.runTimeoutMs` is the kill for: 30 seconds is the wrong
   * number for a browser suite, and every other command in this design keeps the ordinary one.
   *
   * **The exit code is never read.** One invocation carries many rows and one code, so inferring
   * anything from it is guaranteed to be wrong for some row — what a run answers is where its report
   * landed, and only a kill leaves it having answered nothing.
   */
  async run(request: RunnerRequest): Promise<RunnerOutcome> {
    const said = await this.spawn(request, this.runTimeoutMs);
    if (said.killed !== null) return { said: null, detail: said.killed };
    return { said: said.stdout.trim() === '' ? null : said.stdout, detail: null };
  }

  async publishArtefacts(request: RunnerRequest): Promise<RunnerOutcome> {
    const said = await this.spawn(request, this.timeoutMs);
    if (said.failed !== null) return { said: null, detail: said.failed };
    return { said: firstLine(said.stdout), detail: null };
  }

  /**
   * The command is the project's own, verbatim; the parameters reach it as environment only. A kill
   * **answers nothing** rather than answering emptily — an empty listing read as an answer is every
   * selector matching zero, which is the shape that makes a mismatch read as a clean pass.
   */
  private spawn(
    request: RunnerRequest,
    timeoutMs: number,
  ): Promise<{ stdout: string; killed: string | null; failed: string | null }> {
    return new Promise((resolve) => {
      exec(
        request.command,
        {
          cwd: this.repoRoot,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ...runnerEnv(request) },
        },
        (err, stdout, stderr) => {
          if (err === null) return resolve({ stdout, killed: null, failed: null });
          const failure = err as ExecFailure;
          if (failure.killed === true || (failure.signal !== null && failure.signal !== undefined)) {
            const killed = `the command was killed after ${failure.signal ?? 'timeout'}`;
            return resolve({ stdout, killed, failed: killed });
          }
          resolve({
            stdout,
            killed: null,
            failed: `the command exited ${String(failure.code ?? 'unknown')}: ${firstLine(stderr) ?? failure.message}`,
          });
        },
      );
    });
  }
}

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
