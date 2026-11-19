import { readdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { wordsOf } from './scrub.js';

// → docs/spec/18-observability.md#reporting-a-fault-to-lubbdubb

let cached: { root: string; words: ReadonlySet<string> } | null = null;

export function harnessVocabulary(root: string): ReadonlySet<string> {
  if (cached?.root === root) return cached.words;
  const words = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) {
        for (const w of wordsOf(entry.name)) words.add(w.toLowerCase());
        for (const w of wordsOf(readFileSync(path, 'utf8'))) words.add(w.toLowerCase());
      }
    }
  };
  walk(join(root, 'src'));
  for (const w of ['src', 'dist', 'web', 'ts', 'js']) words.add(w);
  cached = { root, words };
  return words;
}

export function instanceTerms(config: unknown): string[] {
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
