import { join } from 'node:path';
import type { ExtraMcpServer } from '../../types.js';
import { recorderOffered } from '../recording.js';
import { FFMPEG_REVISION, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_VERSION } from './policy.js';

// → docs/spec/32-local-validation.md#the-recording

interface Host {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  exists: (path: string) => boolean;
}

function playwrightCacheDir(host: Host): string | null {
  const set = host.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set === '0') return null;
  if (set) return set;
  if (host.platform === 'win32')
    return join(host.env.LOCALAPPDATA || join(host.home, 'AppData', 'Local'), 'ms-playwright');
  if (host.platform === 'darwin') return join(host.home, 'Library', 'Caches', 'ms-playwright');
  return join(host.env.XDG_CACHE_HOME || join(host.home, '.cache'), 'ms-playwright');
}

export function ffmpegPreflight(browser: ExtraMcpServer | null, host: Host): string | null {
  if (browser === null || !recorderOffered(browser)) return null;
  if (!browser.args.includes(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`)) return null;
  const cache = playwrightCacheDir(host);
  if (cache === null) return null;
  const dir = join(cache, `ffmpeg-${FFMPEG_REVISION}`);
  if (host.exists(dir)) return null;
  return (
    `Validation runs will not be recorded: Playwright's ffmpeg-${FFMPEG_REVISION} is not installed at ${dir}. ` +
    `Install it with \`npx -y playwright@${PLAYWRIGHT_VERSION} install ffmpeg\` — a bare ` +
    `\`npx playwright install ffmpeg\` can fetch a different revision, which does not count.`
  );
}
