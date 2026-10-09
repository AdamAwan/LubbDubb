import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '../src/agents/resolveCommand.js';

function makeExecutable(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  return p;
}

const posixOnly = { skip: process.platform === 'win32' };
const windowsOnly = { skip: process.platform !== 'win32' };

const NPM_EXE_SHIM = '@ECHO off\r\nGOTO start\r\n:start\r\n"%dp0%\\node_modules\\pkg\\bin\\my-agent.exe"   %*\r\n';

test('resolves a bare command against PATH to an absolute path', posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = makeExecutable(dir, 'my-agent');
  const got = resolveExecutable('my-agent', { PATH: dir });
  assert.equal(got, bin);
});

test('throws a clear error when a bare command is not on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  assert.throws(() => resolveExecutable('definitely-missing', { PATH: dir }), /was not found on PATH/);
});

test('an explicit absolute path is checked and returned as-is', posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = makeExecutable(dir, 'agent');
  assert.equal(resolveExecutable(bin, { PATH: '' }), bin);
});

test('throws when an explicit path does not exist', () => {
  assert.throws(() => resolveExecutable('/no/such/agent/binary', {}), /not found or not executable/);
});

test('a non-executable file on PATH is skipped', posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const p = join(dir, 'plain');
  writeFileSync(p, 'data');
  chmodSync(p, 0o644);
  assert.throws(() => resolveExecutable('plain', { PATH: dir }), /was not found on PATH/);
});

test('resolves a bare command via PATHEXT on Windows', windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = join(dir, 'my-agent.exe');
  writeFileSync(bin, 'MZ');
  const got = resolveExecutable('my-agent', { PATH: dir, PATHEXT: '.EXE;.CMD' });
  assert.equal(got.toLowerCase(), bin.toLowerCase());
});

test('resolves against a Windows-cased `Path` entry', windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = join(dir, 'my-agent.exe');
  writeFileSync(bin, 'MZ');
  const got = resolveExecutable('my-agent', { Path: dir, PATHEXT: '.EXE;.CMD' });
  assert.equal(got.toLowerCase(), bin.toLowerCase());
});

test('reads a Windows-cased `Pathext` for the extension list', windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const bin = join(dir, 'my-agent.zzz');
  writeFileSync(bin, 'MZ');
  const got = resolveExecutable('my-agent', { Path: dir, Pathext: '.ZZZ' });
  assert.equal(got.toLowerCase(), bin.toLowerCase());
});

test('an extensionless file on PATH is never chosen on Windows', windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  writeFileSync(join(dir, 'my-agent'), '#!/bin/sh\n');
  const bin = join(dir, 'my-agent.exe');
  writeFileSync(bin, 'MZ');
  assert.equal(resolveExecutable('my-agent', { PATH: dir, PATHEXT: '.EXE;.CMD' }).toLowerCase(), bin.toLowerCase());

  const bare = mkdtempSync(join(tmpdir(), 'resolve-'));
  writeFileSync(join(bare, 'my-agent'), '#!/bin/sh\n');
  assert.throws(() => resolveExecutable('my-agent', { PATH: bare, PATHEXT: '.EXE;.CMD' }), /was not found on PATH/);
});

test('an npm shim on PATH resolves to the exe it launches', windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  writeFileSync(join(dir, 'my-agent'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'my-agent.cmd'), NPM_EXE_SHIM);
  mkdirSync(join(dir, 'node_modules', 'pkg', 'bin'), { recursive: true });
  const exe = join(dir, 'node_modules', 'pkg', 'bin', 'my-agent.exe');
  writeFileSync(exe, 'MZ');
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  assert.equal(resolveExecutable('my-agent', env).toLowerCase(), exe.toLowerCase());
  assert.equal(resolveExecutable(join(dir, 'my-agent'), env).toLowerCase(), exe.toLowerCase());
});

test('a cmd that does not launch an existing exe is returned as found', windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const shim = join(dir, 'my-agent.cmd');
  writeFileSync(shim, NPM_EXE_SHIM);
  assert.equal(resolveExecutable('my-agent', { PATH: dir, PATHEXT: '.EXE;.CMD' }).toLowerCase(), shim.toLowerCase());
});

test('a node-script shim is not followed to the node.exe beside it', windowsOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const shim = join(dir, 'my-agent.cmd');
  writeFileSync(
    shim,
    '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n' +
      '"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*\r\n',
  );
  writeFileSync(join(dir, 'node.exe'), 'MZ');
  assert.equal(resolveExecutable('my-agent', { PATH: dir, PATHEXT: '.EXE;.CMD' }).toLowerCase(), shim.toLowerCase());
});

test('ignores a lower-cased `path` on POSIX', posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  makeExecutable(dir, 'my-agent');
  assert.throws(() => resolveExecutable('my-agent', { path: dir }), /was not found on PATH/);
});
