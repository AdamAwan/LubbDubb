import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ffmpegPreflight } from '../src/validation/local/ffmpeg.js';
import {
  DEFAULT_LOCAL_VALIDATION,
  FFMPEG_REVISION,
  PLAYWRIGHT_MCP_VERSION,
  PLAYWRIGHT_VERSION,
} from '../src/validation/local/policy.js';
import { recorderOffered, recordingStatus } from '../src/validation/recording.js';
import type { ExtraMcpServer, Task } from '../src/types.js';

// → docs/spec/32-local-validation.md#the-recording

const browser = (args: string[]): ExtraMcpServer => ({ key: 'browser', command: 'npx', args });

test('the default browser is pinned, never @latest, and offers the recorder', () => {
  const args = DEFAULT_LOCAL_VALIDATION.browser?.args ?? [];
  assert.ok(args.includes(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`));
  assert.ok(!args.some((arg) => arg.endsWith('@latest')));
  assert.equal(recorderOffered(DEFAULT_LOCAL_VALIDATION.browser), true);
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
  assert.equal(recordingStatus(launched([recorder]), true), 'kept');
  assert.equal(recordingStatus(launched([recorder]), false), 'missing');
  assert.equal(recordingStatus(launched([browser(['--caps', 'vision'])]), false), 'not_offered');
  assert.equal(recordingStatus(launched(null), false), 'not_offered');
  assert.equal(recordingStatus(null, false), 'not_offered');
});

const host = (present: string[]) => ({
  env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' },
  platform: 'linux' as const,
  home: '/home/me',
  exists: (path: string) => present.includes(path),
});

test('the preflight names the pinned install command when the matching ffmpeg is absent', () => {
  const message = ffmpegPreflight(DEFAULT_LOCAL_VALIDATION.browser, host([]));
  assert.ok(message !== null);
  assert.ok(message.includes(`npx -y playwright@${PLAYWRIGHT_VERSION} install ffmpeg`));
  assert.ok(message.includes(`ffmpeg-${FFMPEG_REVISION}`));
});

test('the preflight is quiet where ffmpeg is there, or where it cannot know the revision', () => {
  assert.equal(
    ffmpegPreflight(DEFAULT_LOCAL_VALIDATION.browser, host([join('/pw', `ffmpeg-${FFMPEG_REVISION}`)])),
    null,
  );
  assert.equal(ffmpegPreflight(browser(['@playwright/mcp@0.0.1', '--caps', 'devtools']), host([])), null);
  assert.equal(ffmpegPreflight(null, host([])), null);
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
  assert.equal(look('linux', {}), join('/h', '.cache', 'ms-playwright', `ffmpeg-${FFMPEG_REVISION}`));
  assert.equal(look('darwin', {}), join('/h', 'Library', 'Caches', 'ms-playwright', `ffmpeg-${FFMPEG_REVISION}`));
  assert.equal(look('win32', { LOCALAPPDATA: 'C:/L' }), join('C:/L', 'ms-playwright', `ffmpeg-${FFMPEG_REVISION}`));
});
