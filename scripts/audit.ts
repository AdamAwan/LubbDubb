import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

class AuditError extends Error {}

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

export function readTree(path: string, includeDev: boolean): readonly Dep[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('packages' in parsed)) {
    throw new AuditError(`${path}: no "packages" — lockfileVersion 2 or later is required`);
  }
  const { packages } = parsed as Lockfile;
  const seen = new Map<string, Dep>();
  for (const [installPath, entry] of Object.entries(packages)) {
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

const invoked = process.argv[1];
if (invoked !== undefined && realpathSync(invoked) === fileURLToPath(import.meta.url)) {
  await main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`audit: could not complete the check — ${message}\n`);
    process.exitCode = 1;
  });
}
