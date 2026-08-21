import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '../src/agents/resolveCommand.js';

function makeExecutable(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  return p;
}

test('resolves a bare command against PATH to an absolute path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = makeExecutable(dir, 'my-agent');
  const got = resolveExecutable('my-agent', { PATH: dir });
  assert.equal(got, bin);
});

test('throws a clear error when a bare command is not on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  assert.throws(() => resolveExecutable('definitely-missing', { PATH: dir }), /was not found on PATH/);
});

test('an explicit absolute path is checked and returned as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = makeExecutable(dir, 'agent');
  assert.equal(resolveExecutable(bin, { PATH: '' }), bin);
});

test('throws when an explicit path does not exist', () => {
  assert.throws(() => resolveExecutable('/no/such/agent/binary', {}), /not found or not executable/);
});

test('a non-executable file on PATH is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const p = join(dir, 'plain');
  writeFileSync(p, 'data');
  chmodSync(p, 0o644);
  assert.throws(() => resolveExecutable('plain', { PATH: dir }), /was not found on PATH/);
});

// Windows resolves a bare command via PATHEXT — `claude` must find `claude.exe`.
test('resolves a bare command via PATHEXT on Windows', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = join(dir, 'my-agent.exe');
  writeFileSync(bin, 'MZ');
  const got = resolveExecutable('my-agent', { PATH: dir, PATHEXT: '.EXE;.CMD' });
  // PATHEXT casing is preserved verbatim (`.EXE`); Windows' case-insensitive FS still matches.
  assert.equal(got.toLowerCase(), bin.toLowerCase());
});

// A native Windows launcher (pwsh -> npm -> cmd -> node) reports the variable as
// `Path`, and every caller hands `resolveExecutable` a spread copy of
// `process.env` — a plain object, so `env.PATH` is undefined and the PATH walk
// finds nothing. Launched from Git Bash the same variable arrives as `PATH`, which
// is why this only ever broke on the shell the operator actually starts from.
test('resolves against a Windows-cased `Path` entry', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = join(dir, 'my-agent.exe');
  writeFileSync(bin, 'MZ');
  const got = resolveExecutable('my-agent', { Path: dir, PATHEXT: '.EXE;.CMD' });
  assert.equal(got.toLowerCase(), bin.toLowerCase());
});

// Same hazard one level down: PATHEXT is upper-cased by Windows itself today, so a
// lower-cased one would silently fall back to the default list and miss `.PS1`.
test('reads a Windows-cased `Pathext` for the extension list', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = join(dir, 'my-agent.zzz');
  writeFileSync(bin, 'MZ');
  const got = resolveExecutable('my-agent', { Path: dir, Pathext: '.ZZZ' });
  assert.equal(got.toLowerCase(), bin.toLowerCase());
});

// POSIX env vars are genuinely case-sensitive — a lower-cased `path` must not be
// mistaken for PATH there.
test('ignores a lower-cased `path` on POSIX', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  makeExecutable(dir, 'my-agent');
  assert.throws(() => resolveExecutable('my-agent', { path: dir }), /was not found on PATH/);
});
