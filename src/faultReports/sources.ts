import { readdir, readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, relative } from 'node:path';
import { harnessBuild } from '../pool/harnessVersion.js';
import type { ErrorLogEntry } from '../types.js';
import type { FaultReport } from '../wire.js';
import { composeFaultReports, leakTerms } from './compose.js';
import { HARNESS_TREES, wordsOf } from './scrub.js';

// → docs/spec/18-observability.md#reporting-a-fault-to-lubbdubb

const READ_BATCH = 32;
const RUNTIME = `node ${process.versions.node.split('.')[0]} · ${process.platform}`;

export class FaultReporter {
  private vocabulary: Promise<ReadonlySet<string>> | null = null;

  constructor(
    private readonly root: string,
    private readonly config: unknown,
  ) {}

  async compose(entries: readonly ErrorLogEntry[], now: string): Promise<FaultReport[]> {
    this.vocabulary ??= harnessVocabulary(this.root).catch((err: unknown) => {
      this.vocabulary = null;
      throw err;
    });
    const [vocabulary, build] = await Promise.all([this.vocabulary, harnessBuild(this.root)]);
    const leaks = leakTerms(instanceTerms(this.config), vocabulary);
    return composeFaultReports(entries, { root: this.root, vocabulary, leaks, build, runtime: RUNTIME, now });
  }
}

async function harnessVocabulary(root: string): Promise<ReadonlySet<string>> {
  const words = new Set<string>(HARNESS_TREES);
  const src = join(root, 'src');
  const entries = await readdir(src, { recursive: true, withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  for (let i = 0; i < paths.length; i += READ_BATCH) {
    const texts = await Promise.all(
      paths.slice(i, i + READ_BATCH).map(async (path) => `${relative(src, path)}\n${await readFile(path, 'utf8')}`),
    );
    for (const w of texts.flatMap(wordsOf)) words.add(w.toLowerCase());
  }
  return words;
}

function instanceTerms(config: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        out.push(key);
        visit(inner);
      }
  };
  visit(config);
  out.push(hostname(), homedir());
  for (const key of ['USER', 'LOGNAME', 'HOSTNAME', 'PWD']) {
    const value = process.env[key];
    if (value) out.push(value);
  }
  return out;
}
