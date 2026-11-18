import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ffmpegPreflight } from '../src/validation/local/ffmpeg.js';
import { bundledPlaywright, DEFAULT_LOCAL_VALIDATION, substituteBrowserArgs } from '../src/validation/local/policy.js';
import { recorderOffered, recordingStatus } from '../src/validation/recording.js';
import type { ExtraMcpServer, Task } from '../src/types.js';

// → docs/spec/32-local-validation.md#the-recording

const browser = (args: string[]): ExtraMcpServer => ({ key: 'browser', command: 'npx', args });
const { coreCli, ffmpegRevision: FFMPEG_REVISION, mcpCli } = bundledPlaywright();

test('the default browser is the bundled @playwright/mcp, run by this node, and offers the recorder', () => {
  const server = DEFAULT_LOCAL_VALIDATION.browser as ExtraMcpServer;
  assert.ok(!server.args.some((arg) => arg.includes('@playwright/mcp@')));
  const launched = substituteBrowserArgs(server, { outputDir: '/out', profileDir: '/profile' });
  assert.equal(launched.command, process.execPath);
  assert.equal(launched.args[0], mcpCli);
  assert.ok(existsSync(mcpCli), 'the entry point is installed by npm ci');
  assert.ok(!launched.args.some((arg) => /\{\w+\}/.test(arg)), 'no token is left standing');
  assert.equal(recorderOffered(server), true);
});

test('a project names the bundled server by token, beside its own flags', () => {
  const own = {
    ...browser(['{playwrightMcp}', '--timeout-navigation', '15000', '--caps', 'devtools']),
    command: '{node}',
  };
  const launched = substituteBrowserArgs(own, { outputDir: '/out', profileDir: '/profile' });
  assert.equal(launched.command, process.execPath);
  const inCommand = substituteBrowserArgs(
    { ...own, command: '{outputDir}/run' },
    { outputDir: '/o', profileDir: '/p' },
  );
  assert.equal(inCommand.command, '/o/run', 'tokens are filled in command too');
  assert.deepEqual(launched.args, [mcpCli, '--timeout-navigation', '15000', '--caps', 'devtools']);
  const unknown = substituteBrowserArgs(browser(['{toString}', '{nope}']), { outputDir: '/o', profileDir: '/p' });
  assert.deepEqual(unknown.args, ['{toString}', '{nope}'], 'only the browser tokens are substituted');
});

test('the ffmpeg revision is read off the bundled Playwright, not kept by hand', () => {
  assert.match(FFMPEG_REVISION, /^\d+$/);
  assert.ok(existsSync(coreCli));
});

test('the recorder is on offer only where devtools is among the caps', () => {
  assert.equal(recorderOffered(null), false);
  assert.equal(recorderOffered(browser(['@playwright/mcp@1'])), false);
  assert.equal(recorderOffered(browser(['--caps', 'vision'])), false);
  assert.equal(recorderOffered(browser(['--caps', 'vision,devtools'])), true);
  assert.equal(recorderOffered(browser(['--caps=devtools'])), true);
});

test('a video is kept; none is missing only where the agent was launched with the recorder', () => {
  const launched = (servers: ExtraMcpServer[] | null) => ({ mcpServers: servers }) as Task;
  const recorder = DEFAULT_LOCAL_VALIDATION.browser as ExtraMcpServer;
  assert.equal(recordingStatus(launched([recorder]), true, false), 'kept');
  assert.equal(recordingStatus(launched([recorder]), true, true), 'kept', 'a blocked run that recorded still kept it');
  assert.equal(recordingStatus(launched([recorder]), false, false), 'missing');
  assert.equal(recordingStatus(launched([browser(['--caps', 'vision'])]), false, false), 'not_offered');
  assert.equal(recordingStatus(launched(null), false, false), 'not_offered');
});

test('what the harness cannot know is null, never missing', () => {
  const recorder = { mcpServers: [DEFAULT_LOCAL_VALIDATION.browser] } as Task;
  assert.equal(recordingStatus(recorder, null, false), null, 'the directory could not be read');
  assert.equal(recordingStatus(recorder, false, true), null, 'a blocked run may never have started recording');
  assert.equal(recordingStatus(null, false, false), null, 'no task to read the offer off');
});

const host = (present: string[]) => ({
  env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' },
  platform: 'linux' as const,
  home: '/home/me',
  exists: (path: string) => present.includes(path),
});

test('the preflight names the bundled install command when the matching ffmpeg is absent', () => {
  const message = ffmpegPreflight(DEFAULT_LOCAL_VALIDATION.browser, host([]));
  assert.ok(message !== null);
  assert.ok(message.includes(`node ${coreCli} install ffmpeg`));
  assert.ok(message.includes(`ffmpeg-${FFMPEG_REVISION}`));
});

test('the preflight is quiet where ffmpeg is there, or where it cannot know the revision', () => {
  assert.equal(
    ffmpegPreflight(DEFAULT_LOCAL_VALIDATION.browser, host([join('/pw', `ffmpeg-${FFMPEG_REVISION}`)])),
    null,
  );
  assert.equal(ffmpegPreflight(browser(['@playwright/mcp@0.0.1', '--caps', 'devtools']), host([])), null);
  assert.ok(ffmpegPreflight(browser(['{playwrightMcp}', '--caps', 'devtools']), host([])) !== null);
  assert.equal(ffmpegPreflight(browser(['{playwrightMcp}']), host([])), null, 'no recorder on offer');
  const mentioned = browser(['@playwright/mcp@0.0.40', '--note={playwrightMcp}', '--caps', 'devtools']);
  assert.equal(ffmpegPreflight(mentioned, host([])), null, 'only the token as the entry point counts');
  assert.equal(ffmpegPreflight(null, host([])), null);
  const inNodeModules = { ...host([]), env: { PLAYWRIGHT_BROWSERS_PATH: '0' } };
  assert.equal(ffmpegPreflight(DEFAULT_LOCAL_VALIDATION.browser, inNodeModules), null);
});

test('the cache is found where Playwright puts it on each platform', () => {
  const look = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string => {
    let asked = '';
    ffmpegPreflight(DEFAULT_LOCAL_VALIDATION.browser, {
      env,
      platform,
      home: '/h',
      exists: (path) => {
        asked = path;
        return true;
      },
    });
    return asked;
  };
  assert.equal(
    look('linux', { XDG_CACHE_HOME: '' }),
    join('/h', '.cache', 'ms-playwright', `ffmpeg-${FFMPEG_REVISION}`),
  );
  assert.equal(look('linux', {}), join('/h', '.cache', 'ms-playwright', `ffmpeg-${FFMPEG_REVISION}`));
  assert.equal(look('darwin', {}), join('/h', 'Library', 'Caches', 'ms-playwright', `ffmpeg-${FFMPEG_REVISION}`));
  assert.equal(look('win32', { LOCALAPPDATA: 'C:/L' }), join('C:/L', 'ms-playwright', `ffmpeg-${FFMPEG_REVISION}`));
});
