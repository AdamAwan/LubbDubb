import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfigFromText } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ConfigSavePayload, RunningConfigPayload } from '../src/wire.js';

/**
 * `GET`/`POST /api/config` — the route the config form is.
 *
 * Every test here points `configFile` at a temp file. Without that a save
 * rewrites the `lubbdubb.config.json` of whatever checkout the suite is running
 * in, which is the developer's own.
 */

/**
 * The file a fixture starts from — the source of both the harness's config and
 * the form's. Rendered from one record so an `extra` cannot leave a duplicate
 * key in the file, which JSON.parse resolves silently and an edit does not.
 */
function configText(dir: string, extra: Record<string, unknown> = {}): string {
  const merged: Record<string, unknown> = {
    maxConcurrentAgents: 4,
    agentMode: 'raw',
    labelPrefix: '',
    dbPath: ':memory:',
    heartbeatIntervalMs: 999999,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    auth: { enabled: false, tokenFile: join(dir, 'token') },
    ...extra,
  };
  const members = Object.entries(merged).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return [
    '{',
    '  "// maxConcurrentAgents": "Raised for the backlog push. Put it back to 3 after.",',
    `${members.join(',\n')}`,
    '}',
    '',
  ].join('\n');
}

/**
 * A harness whose running config *is* the file's, the way `main.ts` builds one.
 *
 * That matters more than it looks: a system built from explicit overrides the
 * file does not carry would read every one of them as a pending restart the
 * moment anything reloaded, which is a property of the fixture and not of the
 * code under test.
 */
function fixture(
  extra: Record<string, unknown> = {},
  project?: Record<string, unknown>,
): { system: System; file: string; projectFile: string; text: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-cfgroute-'));
  const file = join(dir, 'lubbdubb.config.json');
  // The team's layer lives at `repoRoot`, so a fixture that wants one points the
  // harness at the temp dir. Injected either way: without it the route reads the
  // `lubbdubb.project.json` of whatever checkout the suite is running in, which is
  // `configFile`'s hazard with a second file.
  const projectFile = join(dir, 'lubbdubb.project.json');
  if (project) writeFileSync(projectFile, JSON.stringify(project), 'utf8');
  // A relative tokenFile would mint into the checkout the suite is running in.
  const text = configText(dir, project ? { repoRoot: dir, ...extra } : extra).replace(
    '"TOKENFILE"',
    JSON.stringify(join(dir, 'token')),
  );
  assert.doesNotMatch(text, /"TOKENFILE"/);
  writeFileSync(file, text, 'utf8');
  const system = buildSystem(loadConfigFromText(text, file), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    configFile: file,
    projectConfigFile: projectFile,
  });
  return { system, file, projectFile, text, dir };
}

/** The bearer this app is running with, for the one fixture that has auth on. */
async function tokenOf(system: System): Promise<string> {
  const { app, cockpitUrl } = await buildApp(system);
  await app.close();
  const token = cockpitUrl?.split('#t=')[1];
  assert.ok(token, 'an app with auth on hands back a tokenised cockpit URL');
  return token;
}

function headers(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function save(
  system: System,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: ConfigSavePayload & { error?: string } }> {
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/config', payload: body, headers: headers(token) });
    return { status: res.statusCode, body: res.json() as ConfigSavePayload & { error?: string } };
  } finally {
    await app.close();
  }
}

async function read(system: System, token?: string): Promise<RunningConfigPayload> {
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: headers(token) });
    return res.json() as RunningConfigPayload;
  } finally {
    await app.close();
  }
}

test('GET /api/config names the file it writes and what is waiting for a restart', async () => {
  const { system, file } = fixture();

  const payload = await read(system);

  assert.equal(payload.file, file);
  assert.ok(payload.revision.length > 0, 'a baseline a save can be refused against');
  assert.deepEqual(payload.pending, []);
  const cap = payload.groups.flatMap((group) => group.entries).find((entry) => entry.path === 'maxConcurrentAgents');
  assert.deepEqual(
    { type: cap?.type, live: cap?.live, access: cap?.access, isDefault: cap?.isDefault },
    { type: 'number', live: true, access: 'plain', isDefault: false },
  );

  system.store.close();
});

test('a save writes the file, applies the live key now, and holds the rest for a restart', async () => {
  const { system, file } = fixture();
  const { revision } = await read(system);

  const res = await save(system, { baseline: revision, set: { maxConcurrentAgents: 6, agentMode: 'pty' } });

  assert.equal(res.status, 200);
  assert.equal(system.runtimeControl.cap, 6, 'the live cap moved without a restart');
  assert.deepEqual(res.body.changes.map((change) => `${change.path}:${change.applied ? 'now' : 'restart'}`).sort(), [
    'agentMode:restart',
    'maxConcurrentAgents:now',
  ]);
  assert.deepEqual(
    res.body.pending.map((change) => change.path),
    ['agentMode'],
  );

  const saved = readFileSync(file, 'utf8');
  assert.match(saved, /"maxConcurrentAgents": 6,/);
  assert.match(saved, /"agentMode": "pty",/);
  assert.match(saved, /"\/\/ maxConcurrentAgents": "Raised for the backlog push/, 'the comment survived the save');
  assert.notEqual(res.body.revision, revision, 'the baseline moved with the file');

  system.store.close();
});

test('a reset clears the key rather than writing the default back', async () => {
  const { system, file } = fixture();
  const { revision } = await read(system);

  const res = await save(system, { baseline: revision, clear: ['maxConcurrentAgents'] });

  assert.equal(res.status, 200);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')) as object, 'maxConcurrentAgents'), false);
  assert.equal(system.runtimeControl.cap, 3, 'and the harness fell back to the built-in default');

  system.store.close();
});

test('a save whose baseline has moved is refused rather than allowed to clobber it', async () => {
  const { system, file, text } = fixture();
  const { revision } = await read(system);
  // Somebody else — an editor, or Claude — writes the file in between.
  writeFileSync(file, text.replace('"agentMode": "raw"', '"agentMode": "stream"'), 'utf8');

  const res = await save(system, { baseline: revision, set: { maxConcurrentAgents: 9 } });

  assert.equal(res.status, 409);
  assert.match(res.body.error ?? '', /changed since this was loaded — reload before saving/);
  assert.match(readFileSync(file, 'utf8'), /"agentMode": "stream"/, 'the other write stands');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /"maxConcurrentAgents": 9/);

  system.store.close();
});

test('a save that would not boot is refused with the loader’s own message', async () => {
  // Auth has to be *on* for this fixture to load at all, which is the point of the
  // refusal being tested: the pair is what is refused, not either half.
  const { system, dir } = fixture({ host: '0.0.0.0', auth: { enabled: true, tokenFile: 'TOKENFILE' } });
  assert.ok(dir);
  const token = await tokenOf(system);
  const { revision } = await read(system, token);

  const res = await save(system, { baseline: revision, set: { 'auth.enabled': false } }, token);

  assert.equal(res.status, 400);
  assert.match(res.body.error ?? '', /reachable off this machine and auth\.enabled is false/);

  system.store.close();
});

test('a save the loader’s own validators reject is refused too, before the file moves', async () => {
  const { system, file, text } = fixture();
  const { revision } = await read(system);

  const res = await save(system, {
    baseline: revision,
    set: { 'ci.checks': [{ match: 'build', onFailure: 'shrug' }] },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error ?? '', /onFailure|shrug/i);
  assert.equal(readFileSync(file, 'utf8'), text, 'the file is untouched');

  system.store.close();
});

test('a value of the wrong type is refused by name, before anything is written', async () => {
  const { system, file, text } = fixture();
  const { revision } = await read(system);

  const res = await save(system, { baseline: revision, set: { maxConcurrentAgents: '6' } });

  assert.equal(res.status, 400);
  assert.match(res.body.error ?? '', /maxConcurrentAgents must be a number/);
  assert.equal(readFileSync(file, 'utf8'), text, 'the file is untouched');

  system.store.close();
});

test('a field the form must not offer is refused: unknown, file-only, or set by the environment', async () => {
  const { system } = fixture();
  const { revision } = await read(system);

  const unknown = await save(system, { baseline: revision, set: { nonsense: 1 } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error ?? '', /nonsense is not a configurable field/);

  const fileOnly = await save(system, { baseline: revision, set: { whitelistedApprovals: [] } });
  assert.equal(fileOnly.status, 400);
  assert.match(fileOnly.body.error ?? '', /whitelistedApprovals is edited in the file, not here/);

  const before = process.env['PORT'];
  process.env['PORT'] = '4310';
  try {
    const env = await save(system, { baseline: revision, set: { port: 4400 } });
    assert.equal(env.status, 400);
    assert.match(env.body.error ?? '', /port is set by PORT in this harness's environment, which beats the file/);
  } finally {
    if (before === undefined) delete process.env['PORT'];
    else process.env['PORT'] = before;
  }

  system.store.close();
});

async function preview(
  system: System,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  body: { text?: string; changes?: { path: string; applied: boolean }[]; error?: string };
}> {
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/config/preview', payload: body });
    return { status: res.statusCode, body: res.json() as never };
  } finally {
    await app.close();
  }
}

test('the preview answers the bytes that would be written, and writes nothing', async () => {
  const { system, file, text } = fixture();
  const { revision } = await read(system);

  const res = await preview(system, { baseline: revision, set: { maxConcurrentAgents: 6, agentMode: 'pty' } });

  assert.equal(res.status, 200);
  assert.match(res.body.text ?? '', /"maxConcurrentAgents": 6,/);
  assert.match(res.body.text ?? '', /"\/\/ maxConcurrentAgents": "Raised for the backlog push/, 'comments survive');
  assert.deepEqual(
    (res.body.changes ?? []).map((change) => `${change.path}:${change.applied ? 'now' : 'restart'}`).sort(),
    ['agentMode:restart', 'maxConcurrentAgents:now'],
  );
  assert.equal(readFileSync(file, 'utf8'), text, 'the file is untouched');
  assert.equal(system.runtimeControl.cap, 4, 'and nothing was applied');

  system.store.close();
});

test('the preview refuses exactly what the save would refuse, so it cannot promise more', async () => {
  const { system } = fixture();
  const { revision } = await read(system);

  const stale = await preview(system, { baseline: 'nonsense', set: { maxConcurrentAgents: 6 } });
  assert.equal(stale.status, 409);

  const typed = await preview(system, { baseline: revision, set: { maxConcurrentAgents: '6' } });
  assert.equal(typed.status, 400);
  assert.match(typed.body.error ?? '', /maxConcurrentAgents must be a number/);

  system.store.close();
});

test('the raw arm writes the whole file, and the loader refuses one that would not boot', async () => {
  const { system, file } = fixture();
  const { revision } = await read(system);
  const { app } = await buildApp(system);
  try {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/config/raw',
      payload: { baseline: revision, text: '{ "autoSend": { "enabled": true } }' },
    });
    assert.equal(bad.statusCode, 400);
    assert.match((bad.json() as { error: string }).error, /autoSend/, 'a removed key is refused by name');

    const good = await app.inject({
      method: 'POST',
      url: '/api/config/raw',
      payload: { baseline: revision, text: '{\n  "dbPath": ":memory:",\n  "maxConcurrentAgents": 7\n}\n' },
    });
    assert.equal(good.statusCode, 200);
    assert.equal(system.runtimeControl.cap, 7, 'a hand-written file applies its live keys like any other save');
    assert.match(readFileSync(file, 'utf8'), /"maxConcurrentAgents": 7/);
  } finally {
    await app.close();
  }

  system.store.close();
});

test('a save that names no field is refused rather than rewriting the file for nothing', async () => {
  const { system } = fixture();
  const { revision } = await read(system);

  const res = await save(system, { baseline: revision });

  assert.equal(res.status, 400);
  assert.match(res.body.error ?? '', /nothing to save/);

  system.store.close();
});

/**
 * Two files, and only one of them is the one this route writes. A row that drew
 * the team's value as a built-in default would send an operator looking for a key
 * their own file does not have — and would promise a reset that goes somewhere
 * else than it goes.
 */
test('GET /api/config names the project’s file and marks what came from it', async () => {
  const { system, projectFile } = fixture({}, { defaultBranch: 'trunk', closedPrWindowMs: 1000 });

  const payload = await read(system);
  assert.equal(payload.projectFile, projectFile);

  const shown = payload.groups.flatMap((group) => group.entries);
  const branch = shown.find((entry) => entry.path === 'defaultBranch');
  assert.equal(branch?.value, 'trunk', 'the team’s value is what the harness runs on');
  assert.equal(branch?.isDefault, true, 'the operator did not choose it');
  assert.equal(branch?.fromProject, true, 'and the row says which file did');

  // The operator's own file still reads as theirs, over the same payload.
  const cap = shown.find((entry) => entry.path === 'maxConcurrentAgents');
  assert.equal(cap?.isDefault, false);
  assert.equal(cap?.fromProject, undefined);

  system.store.close();
});

test('a harness whose project carries no config says so rather than guessing', async () => {
  const { system } = fixture();
  const payload = await read(system);
  assert.equal(payload.projectFile, null);
  assert.equal(
    payload.groups.flatMap((group) => group.entries).filter((entry) => entry.fromProject !== undefined).length,
    0,
  );
  system.store.close();
});

/**
 * The operator's own file wins, and saving is how they take it — the point of two
 * layers rather than one. The write goes to `lubbdubb.config.json`; the project's
 * file is not touched, because it belongs to the team.
 */
test('a save overrides a project value locally and leaves the project’s file alone', async () => {
  const { system, file, projectFile } = fixture({}, { lessonBlockChars: 1000 });
  const before = readFileSync(projectFile, 'utf8');

  const shownFirst = (await read(system)).groups
    .flatMap((group) => group.entries)
    .find((entry) => entry.path === 'lessonBlockChars');
  assert.equal(shownFirst?.value, 1000, 'the team’s value is what the harness booted on');
  assert.equal(shownFirst?.isDefault, true);

  const revision = (await read(system)).revision;
  const saved = await save(system, { set: { lessonBlockChars: 2000 }, baseline: revision });
  assert.equal(saved.status, 200);

  assert.match(readFileSync(file, 'utf8'), /"lessonBlockChars": 2000/);
  assert.equal(readFileSync(projectFile, 'utf8'), before, 'the team’s file is read, never written');

  const shown = (await read(system)).groups
    .flatMap((group) => group.entries)
    .find((entry) => entry.path === 'lessonBlockChars');
  assert.equal(shown?.value, 2000, 'a live key, so the override is in force now');
  assert.equal(shown?.isDefault, false, 'this one is theirs');
  assert.equal(shown?.fromProject, true, 'and clearing it would leave the team’s value, not the built-in one');

  system.store.close();
});
