/**
 * The dependency-advisory gate, read from OSV rather than from `npm audit`.
 *
 * `npm audit` posts the whole tree to the registry's `/-/npm/v1/security/audits/quick`
 * endpoint, which npm's own output says is being retired, and which began answering
 * GitHub's runners `400 Invalid package tree` while every local run of the same npm,
 * over the same lockfile, returned zero. The message names `package-lock.json` and is
 * wrong about it — `npm install --package-lock-only` reproduces the committed file byte
 * for byte. It is the registry's words, relayed. So the gate was failing on a remote
 * whose behaviour we do not control and cannot reproduce, for a tree that is clean, and
 * the fix is not to rebuild anything: it is to stop asking that endpoint.
 *
 * OSV is queried directly instead. It is the same corpus GitHub publishes GHSAs into,
 * addressed by a documented batch API, so there is no scanner binary to pin and nothing
 * between us and the data.
 *
 * Two rules the security of this file rests on, both of which npm got right and are easy
 * to lose in a rewrite:
 *
 * - **A check that could not run fails.** Every network error, every unreadable severity,
 *   every advisory OSV knows an id for but will not describe, exits non-zero. A gate that
 *   goes green when it learned nothing is worse than no gate, because it is trusted.
 * - **The lockfile is the tree.** `npm ci` installs exactly what `package-lock.json` says,
 *   so auditing the file audits the artefact. `dev: true` marks a package nothing outside
 *   the toolchain can reach, which is what `--omit=dev` meant; `devOptional` is reachable
 *   from both and counts as runtime.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** GHSA's own scale, ordered. Anything at or above `high` fails the gate. */
const RANK = ['low', 'moderate', 'high', 'critical'] as const;
type Severity = (typeof RANK)[number];

const GATE: Severity = 'high';

const BATCH = 200;
const ATTEMPTS = 3;
const RETRY_MS = 1_000;

interface LockPackage {
  readonly version?: string;
  readonly name?: string;
  readonly dev?: boolean;
  readonly link?: boolean;
}

interface Lockfile {
  readonly packages: Readonly<Record<string, LockPackage>>;
}

interface Dep {
  readonly name: string;
  readonly version: string;
  readonly dev: boolean;
}

interface Finding {
  readonly dep: Dep;
  readonly id: string;
  readonly severity: Severity;
  readonly summary: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Anything that stops us learning the answer is fatal — never a skipped package. */
class AuditError extends Error {}

/**
 * Retries only the shape of failure that is worth retrying: a transport error, or a 5xx.
 * A 4xx is the server saying the request is wrong, which repeating cannot mend — that was
 * the failure mode this file exists to stop swallowing.
 */
async function post(url: string, body: unknown): Promise<unknown> {
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await sleep(RETRY_MS * attempt);
      continue;
    }
    if (response.ok) return response.json();
    last = `HTTP ${response.status} ${await response.text()}`;
    if (response.status < 500) break;
    await sleep(RETRY_MS * attempt);
  }
  throw new AuditError(`${url}: ${last}`);
}

/**
 * The lockfile keys every package by install path, so one name appears once per distinct
 * version in the tree. Deduplicating by name@version keeps the query small without losing
 * a version: two paths on one version are one question.
 */
export function readTree(path: string, includeDev: boolean): readonly Dep[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('packages' in parsed)) {
    throw new AuditError(`${path}: no "packages" — lockfileVersion 2 or later is required`);
  }
  const { packages } = parsed as Lockfile;
  const seen = new Map<string, Dep>();
  for (const [installPath, entry] of Object.entries(packages)) {
    // A registry dependency is exactly an entry installed under `node_modules/`. That
    // rules out the root project and any workspace package — local code OSV has never
    // heard of — and it is what makes the name below safe to take from the path: an
    // entry with no such segment would otherwise be queried under its whole path, which
    // matches nothing and reports clean.
    const marker = installPath.lastIndexOf('node_modules/');
    if (marker === -1 || entry.link === true) continue;
    const { version } = entry;
    if (version === undefined) continue;
    const dev = entry.dev === true;
    if (dev && !includeDev) continue;
    const name = entry.name ?? installPath.slice(marker + 'node_modules/'.length);
    if (name === '') continue;
    seen.set(`${name}@${version}`, { name, version, dev });
  }
  return [...seen.values()];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** OSV returns ids in batch and nothing else, so severity costs one lookup per hit. */
async function idsFor(deps: readonly Dep[]): Promise<ReadonlyMap<Dep, readonly string[]>> {
  const hits = new Map<Dep, readonly string[]>();
  for (let i = 0; i < deps.length; i += BATCH) {
    const chunk = deps.slice(i, i + BATCH);
    const answer = await post('https://api.osv.dev/v1/querybatch', {
      queries: chunk.map((dep) => ({ package: { name: dep.name, ecosystem: 'npm' }, version: dep.version })),
    });
    if (!isRecord(answer) || !Array.isArray(answer['results']) || answer['results'].length !== chunk.length) {
      throw new AuditError('querybatch answered with a shape we cannot read');
    }
    answer['results'].forEach((result: unknown, n: number) => {
      if (!isRecord(result) || !Array.isArray(result['vulns'])) return;
      const ids = result['vulns']
        .map((vuln: unknown) => (isRecord(vuln) && typeof vuln['id'] === 'string' ? vuln['id'] : undefined))
        .filter((id): id is string => id !== undefined);
      const dep = chunk[n];
      if (dep !== undefined && ids.length > 0) hits.set(dep, ids);
    });
  }
  return hits;
}

/**
 * A severity we cannot read is not a severity we may dismiss, so an advisory that
 * declines to name one is fatal rather than filtered out. Withdrawn advisories are the
 * one exclusion, because OSV keeps them addressable after retracting them.
 */
async function describe(dep: Dep, id: string): Promise<Finding | undefined> {
  const response = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`);
  if (!response.ok) throw new AuditError(`${id}: HTTP ${response.status}`);
  const vuln: unknown = await response.json();
  if (!isRecord(vuln)) throw new AuditError(`${id}: unreadable`);
  if (typeof vuln['withdrawn'] === 'string') return undefined;
  const specific = vuln['database_specific'];
  const raw = isRecord(specific) && typeof specific['severity'] === 'string' ? specific['severity'].toLowerCase() : '';
  const severity = RANK.find((level) => level === raw);
  if (severity === undefined) throw new AuditError(`${id}: no severity we can read (${raw || 'absent'})`);
  const summary = typeof vuln['summary'] === 'string' ? vuln['summary'] : id;
  return { dep, id, severity, summary };
}

async function main(): Promise<void> {
  const includeDev = process.argv.includes('--all');
  const scope = includeDev ? 'whole tree' : 'runtime dependencies';
  const deps = readTree('package-lock.json', includeDev);

  const hits = await idsFor(deps);
  const findings: Finding[] = [];
  for (const [dep, ids] of hits) {
    for (const id of ids) {
      const finding = await describe(dep, id);
      if (finding !== undefined) findings.push(finding);
    }
  }

  const gated = findings.filter((finding) => RANK.indexOf(finding.severity) >= RANK.indexOf(GATE));
  const order = (finding: Finding): number => -RANK.indexOf(finding.severity);
  for (const finding of [...findings].sort((a, b) => order(a) - order(b))) {
    const tag = finding.dep.dev ? ' (dev)' : '';
    process.stdout.write(
      `${finding.severity.padEnd(8)} ${finding.dep.name}@${finding.dep.version}${tag}  ${finding.id}  ${finding.summary}\n`,
    );
  }

  const counted = `${deps.length} package${deps.length === 1 ? '' : 's'} (${scope})`;
  if (gated.length > 0) {
    process.stdout.write(
      `\n${gated.length} advisor${gated.length === 1 ? 'y' : 'ies'} at ${GATE} or above in ${counted}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const below = findings.length > 0 ? `, ${findings.length} below ${GATE}` : '';
  process.stdout.write(`found 0 vulnerabilities at ${GATE} or above in ${counted}${below}\n`);
}

/**
 * Run only when invoked as the command, never on import: `readTree` is unit-tested, and a
 * module that audits the network the moment it is imported would put the test suite on OSV.
 */
const invoked = process.argv[1];
if (invoked !== undefined && realpathSync(invoked) === fileURLToPath(import.meta.url)) {
  await main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // A gate that goes green because it could not ask is the failure this file exists to avoid.
    process.stderr.write(`audit: could not complete the check — ${message}\n`);
    process.exitCode = 1;
  });
}
