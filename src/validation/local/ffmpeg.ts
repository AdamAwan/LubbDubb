import { join } from 'node:path';
import type { ExtraMcpServer } from '../../types.js';
import { recorderOffered } from '../recording.js';
import { bundledPlaywright, PLAYWRIGHT_MCP_TOKEN } from './policy.js';

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
  if (browser === null || !browser.args.includes(PLAYWRIGHT_MCP_TOKEN)) return null;
  const bundled = bundledPlaywright();
  if (typeof bundled === 'string')
    return `The browser cannot start: the bundled @playwright/mcp is not usable — ${bundled}. Run \`npm ci\`.`;
  if (!recorderOffered(browser)) return null;
  const cache = playwrightCacheDir(host);
  if (cache === null) return null;
  const { coreCli, ffmpegRevision } = bundled;
  const dir = join(cache, `ffmpeg-${ffmpegRevision}`);
  if (host.exists(dir)) return null;
  return (
    `Validation runs will not be recorded: Playwright's ffmpeg-${ffmpegRevision} is not installed at ${dir}. ` +
    `Install it with \`node ${coreCli} install ffmpeg\` — the Playwright bundled with LubbDubb, which ` +
    `\`npm ci\` runs for you unless install scripts were skipped or its download was blocked.`
  );
}
