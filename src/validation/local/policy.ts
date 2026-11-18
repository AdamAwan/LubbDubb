import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtraMcpServer } from '../../types.js';

// → docs/spec/32-local-validation.md

interface BundledPlaywright {
  mcpCli: string;
  coreCli: string;
  ffmpegRevision: string;
}

let bundled: BundledPlaywright | undefined;

export function bundledPlaywright(): BundledPlaywright {
  if (bundled !== undefined) return bundled;
  const mcpPackage = fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'));
  const mcp = JSON.parse(readFileSync(mcpPackage, 'utf8')) as { bin: Record<string, string> };
  const corePackage = createRequire(mcpPackage).resolve('playwright-core/package.json');
  const core = dirname(corePackage);
  const { browsers } = JSON.parse(readFileSync(join(core, 'browsers.json'), 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const ffmpeg = browsers.find((browser) => browser.name === 'ffmpeg');
  if (ffmpeg === undefined) throw new Error(`No ffmpeg entry in ${join(core, 'browsers.json')}`);
  bundled = {
    mcpCli: join(dirname(mcpPackage), mcp.bin['playwright-mcp'] ?? 'cli.js'),
    coreCli: join(core, 'cli.js'),
    ffmpegRevision: ffmpeg.revision,
  };
  return bundled;
}

export interface LocalValidationPolicy {
  instruction: string;
  browser: ExtraMcpServer | null;
}

export const PLAYWRIGHT_MCP_TOKEN = '{playwrightMcp}';

export const DEFAULT_LOCAL_VALIDATION: LocalValidationPolicy = {
  instruction: '',
  browser: {
    key: 'browser',
    command: process.execPath,
    args: [
      PLAYWRIGHT_MCP_TOKEN,
      '--output-dir',
      '{outputDir}',
      '--user-data-dir',
      '{profileDir}',
      '--caps',
      'devtools',
    ],
  },
};

export function substituteBrowserArgs(
  server: ExtraMcpServer,
  paths: { outputDir: string; profileDir: string },
): ExtraMcpServer {
  const values: Record<string, () => string> = {
    outputDir: () => paths.outputDir,
    profileDir: () => paths.profileDir,
    playwrightMcp: () => bundledPlaywright().mcpCli,
  };
  return {
    ...server,
    args: server.args.map((arg) =>
      Object.entries(values).reduce(
        (acc, [token, value]) => (acc.includes(`{${token}}`) ? acc.split(`{${token}}`).join(value()) : acc),
        arg,
      ),
    ),
  };
}
