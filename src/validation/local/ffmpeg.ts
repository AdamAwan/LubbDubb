import { join } from 'node:path';
import type { ExtraMcpServer } from '../../types.js';
import { FFMPEG_REVISION, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_VERSION, recorderOffered } from './policy.js';

// → docs/spec/32-local-validation.md#the-recording

interface Host {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  exists: (path: string) => boolean;
}

function playwrightCacheDir(host: Host): string {
  const set = host.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set !== undefined && set !== '' && set !== '0') return set;
  if (host.platform === 'win32')
    return join(host.env.LOCALAPPDATA ?? join(host.home, 'AppData', 'Local'), 'ms-playwright');
  if (host.platform === 'darwin') return join(host.home, 'Library', 'Caches', 'ms-playwright');
  return join(host.env.XDG_CACHE_HOME ?? join(host.home, '.cache'), 'ms-playwright');
}

export function ffmpegPreflight(browser: ExtraMcpServer | null, host: Host): string | null {
  if (!recorderOffered(browser)) return null;
  if (!(browser?.args ?? []).includes(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`)) return null;
  const dir = join(playwrightCacheDir(host), `ffmpeg-${FFMPEG_REVISION}`);
  if (host.exists(dir)) return null;
  return (
    `Validation runs will not be recorded: Playwright's ffmpeg-${FFMPEG_REVISION} is not installed at ${dir}. ` +
    `Install it with \`npx -y playwright@${PLAYWRIGHT_VERSION} install ffmpeg\` — a bare ` +
    `\`npx playwright install ffmpeg\` can fetch a different revision, which does not count.`
  );
}
