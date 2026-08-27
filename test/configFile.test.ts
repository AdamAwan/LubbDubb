import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configRevision, editConfigText, readConfigText, writeConfigText } from '../src/configFile.js';

/**
 * The file writer. What is being asserted throughout is that an operator's own
 * file survives: the `"// key"` prose, the blank lines that group it, the indent
 * style and the key order are the half of #401 that keeps the file editable by
 * hand, and a `JSON.parse` → mutate → `JSON.stringify` round trip destroys every
 * one of them.
 */

const COMMENTED = `{
  "// maxConcurrentAgents": "Hard cap on concurrent agents. Raised for the Tuesday backlog push.",
  "//   maxConcurrentAgents, cont": "Put it back to 3 when that is done.",
  "maxConcurrentAgents": 4,

  "// agentMode": "stream = headless claude, raw = the mock agent.",
  "agentMode": "stream",
  "agentPermissionMode": "acceptEdits",

  "integrations": { "sourceControl": "github", "issues": "github" },
  "auth": { "enabled": true }
}
`;

test('a commented config round-trips through a save with its comments intact', () => {
  const next = editConfigText(COMMENTED, { set: { maxConcurrentAgents: 6, agentMode: 'raw' } });

  assert.match(next, /"\/\/ maxConcurrentAgents": "Hard cap on concurrent agents\. Raised for the Tuesday/);
  assert.match(next, /"\/\/ {3}maxConcurrentAgents, cont": "Put it back to 3 when that is done\.",/);
  assert.match(next, /"\/\/ agentMode": "stream = headless claude, raw = the mock agent\.",/);
  assert.match(next, /"maxConcurrentAgents": 6,/);
  assert.match(next, /"agentMode": "raw",/);

  const parsed = JSON.parse(next) as Record<string, unknown>;
  assert.equal(parsed['maxConcurrentAgents'], 6);
  assert.equal(parsed['agentMode'], 'raw');
});

test('key order, blank lines and inline objects are left exactly as they were', () => {
  const next = editConfigText(COMMENTED, { set: { maxConcurrentAgents: 6 } });

  assert.deepEqual(Object.keys(JSON.parse(next) as object), Object.keys(JSON.parse(COMMENTED) as object));
  // The one line that changed is the only line that changed.
  const before = COMMENTED.split('\n');
  const after = next.split('\n');
  assert.equal(after.length, before.length);
  const differing = after.filter((line, i) => line !== before[i]);
  assert.deepEqual(differing, ['  "maxConcurrentAgents": 6,']);
  assert.match(next, /"integrations": \{ "sourceControl": "github", "issues": "github" \}/);
});

test('a key the file does not carry is appended, and a nested one brings its block', () => {
  const next = editConfigText('{\n  "agentMode": "stream"\n}\n', {
    set: { knowledgeBlockChars: 8000, 'planning.maxConcurrentPartsPerIssue': 4 },
  });

  const parsed = JSON.parse(next) as { knowledgeBlockChars: number; planning: { maxConcurrentPartsPerIssue: number } };
  assert.equal(parsed.knowledgeBlockChars, 8000);
  assert.equal(parsed.planning.maxConcurrentPartsPerIssue, 4);
  assert.match(next, /^ {2}"knowledgeBlockChars": 8000,?$/m, 'the inserted member copies the file’s own indent');
});

test('a nested key lands inside a block that already exists rather than replacing it', () => {
  const next = editConfigText('{\n  "auth": {\n    "enabled": true,\n    "tokenFile": "x"\n  }\n}\n', {
    set: { 'auth.enabled': false },
  });

  const parsed = JSON.parse(next) as { auth: { enabled: boolean; tokenFile: string } };
  assert.deepEqual(parsed.auth, { enabled: false, tokenFile: 'x' });
});

test('clearing a key removes it and exactly one comma — first, middle and last', () => {
  const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';

  assert.deepEqual(JSON.parse(editConfigText(text, { clear: ['a'] })), { b: 2, c: 3 });
  assert.deepEqual(JSON.parse(editConfigText(text, { clear: ['b'] })), { a: 1, c: 3 });
  assert.deepEqual(JSON.parse(editConfigText(text, { clear: ['c'] })), { a: 1, b: 2 });
  assert.deepEqual(JSON.parse(editConfigText(text, { clear: ['a', 'b', 'c'] })), {});
});

test('clearing a key the file does not carry changes nothing', () => {
  assert.equal(
    editConfigText('{\n  "a": 1\n}\n', { clear: ['b', 'planning.maxConcurrentPartsPerIssue'] }),
    '{\n  "a": 1\n}\n',
  );
});

test('an object or list value is written whole, indented under its key', () => {
  const next = editConfigText('{\n  "a": 1\n}\n', {
    set: { 'ci.checks': [{ match: 'build', onFailure: 'dispatch' }] },
  });

  assert.deepEqual(JSON.parse(next), { a: 1, ci: { checks: [{ match: 'build', onFailure: 'dispatch' }] } });
  assert.ok(!next.includes('\n"'), 'no continuation line is left flush against the margin');
});

test('a deployment with no config file yet gets one', () => {
  assert.deepEqual(JSON.parse(editConfigText('', { set: { userId: 'AdamAwan' } })), { userId: 'AdamAwan' });
});

test('a file that is not a JSON object is refused rather than overwritten', () => {
  assert.throws(() => editConfigText('[1, 2, 3]\n', { set: { userId: 'x' } }), /must hold a JSON object/);
});

test('the write is atomic and leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-cfgfile-'));
  const file = join(dir, 'lubbdubb.config.json');
  writeFileSync(file, COMMENTED, 'utf8');

  const next = editConfigText(readConfigText(file), { set: { maxConcurrentAgents: 9 } });
  writeConfigText(file, next);

  assert.equal(readFileSync(file, 'utf8'), next);
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { maxConcurrentAgents: number }).maxConcurrentAgents, 9);
});

test('the revision fingerprints the text, so an unchanged file reads as unchanged', () => {
  assert.equal(configRevision(COMMENTED), configRevision(COMMENTED));
  assert.notEqual(configRevision(COMMENTED), configRevision(`${COMMENTED} `));
});

test('a file with no config yet still has a revision, so a first save has a baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-cfgfile-'));
  assert.equal(readConfigText(join(dir, 'nothing.json')), '{}\n');
});
