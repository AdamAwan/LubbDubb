import type { ObstacleKeyKind } from '../types.js';

// → docs/spec/27-obstacles.md

export interface KeyCandidate {
  kind: ObstacleKeyKind;
  value: string;
}

export interface GatedKey extends KeyCandidate {
  binds: boolean;
}

export interface ObstacleWorld {
  readonly checks: readonly string[];
  readonly dispatchChecks: readonly string[];
  hasPath(path: string): boolean;
  readonly branchPaths: readonly string[];
}

const FAILING =
  /\b(fail(?:s|ed|ing|ure)?|flak(?:e|ey|y|ing)|red|broken|breaks?|hang(?:s|ing)?|timing out|times? out|timeouts?|wedged|stuck|erroring)\b/i;

const PATH_TOKEN = /(?:^|[\s`'"(])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=[\s`'".,;:)]|$)/g;

const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/;

const CMD_TOKEN = /\b((?:npm|npx|node|git|tsc|docker|make|pnpm|yarn)(?:\s+[A-Za-z0-9:._/-]+){1,3})/;

export function extractKeys(input: {
  what: string;
  evidence: string;
  world: ObstacleWorld;
  declared?: readonly KeyCandidate[];
}): KeyCandidate[] {
  const text = `${input.what}\n${input.evidence}`;
  const out: KeyCandidate[] = [...(input.declared ?? [])];

  for (const check of input.world.checks) {
    if (check !== '' && text.toLowerCase().includes(check.toLowerCase())) out.push({ kind: 'check', value: check });
  }
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

export function gateKeys(candidates: readonly KeyCandidate[], world: ObstacleWorld): GatedKey[] {
  const checks = new Set(world.checks.map((c) => c.toLowerCase()));
  const dispatched = new Set(world.dispatchChecks.map((c) => c.toLowerCase()));
  const branch = new Set(world.branchPaths.map((p) => p.toLowerCase()));

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
      case 'signature':
      case 'cmd':
        gated.push({ kind: candidate.kind, value, binds: false });
        break;
    }
  }

  const viaCheck = gated.some((key) => key.kind === 'check' && key.binds);
  return gated.map(({ file: _file, ...key }) => ({
    ...key,
    binds: key.binds || (viaCheck && (key.kind === 'test' || key.kind === 'path')),
  }));
}

function testFile(value: string): string | null {
  const file = value.split(/[\s>#]|::/)[0] ?? '';
  return TEST_FILE.test(file) ? file : null;
}

function dedupe<T extends KeyCandidate>(keys: readonly T[]): T[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = `${key.kind}:${key.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
