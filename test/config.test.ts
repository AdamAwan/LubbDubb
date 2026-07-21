import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig returns sane defaults with no overrides', () => {
  const cfg = loadConfig();
  assert.equal(cfg.dispatcher, 'rule');
  assert.equal(cfg.maxConcurrentAgents, 3);
  assert.equal(cfg.autoSend.enabled, false);
  assert.equal(cfg.autoSend.confidenceThreshold, 0.85);
  assert.deepEqual(cfg.autoSend.allowedActions, ['reply_on_pr']);
});

test('explicit overrides win over defaults', () => {
  const cfg = loadConfig({ dispatcher: 'claude', maxConcurrentAgents: 7 });
  assert.equal(cfg.dispatcher, 'claude');
  assert.equal(cfg.maxConcurrentAgents, 7);
});

test('autoSend is deep-merged: a partial override keeps the other defaults', () => {
  const cfg = loadConfig({ autoSend: { enabled: true } as never });
  assert.equal(cfg.autoSend.enabled, true, 'the overridden field applies');
  assert.equal(cfg.autoSend.confidenceThreshold, 0.85, 'untouched fields keep their defaults');
  assert.deepEqual(cfg.autoSend.allowedActions, ['reply_on_pr']);
});

test('PORT and LUBBDUBB_DB env vars are honored', () => {
  const prevPort = process.env.PORT;
  const prevDb = process.env.LUBBDUBB_DB;
  try {
    process.env.PORT = '9999';
    process.env.LUBBDUBB_DB = '/tmp/some.sqlite';
    const cfg = loadConfig();
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.dbPath, '/tmp/some.sqlite');
  } finally {
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevDb === undefined) delete process.env.LUBBDUBB_DB;
    else process.env.LUBBDUBB_DB = prevDb;
  }
});

test('an explicit override beats an env var for the same key', () => {
  const prev = process.env.PORT;
  try {
    process.env.PORT = '9999';
    const cfg = loadConfig({ port: 1234 });
    assert.equal(cfg.port, 1234);
  } finally {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  }
});

test('a relative claudeArg that points at a real file is resolved to an absolute path', () => {
  const cfg = loadConfig({ claudeArgs: ['scripts/mock-agent.sh', '--flag'] });
  assert.ok(cfg.claudeArgs[0]!.startsWith('/'), 'existing script path is made absolute');
  assert.ok(cfg.claudeArgs[0]!.endsWith('scripts/mock-agent.sh'));
  assert.equal(cfg.claudeArgs[1], '--flag', 'a non-file arg is left untouched');
});
