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
  const { bin } = JSON.parse(readFileSync(mcpPackage, 'utf8')) as { bin?: string | Record<string, string> };
  const cli = typeof bin === 'string' ? bin : bin?.['playwright-mcp'];
  if (cli === undefined) throw new Error(`No playwright-mcp bin in ${mcpPackage}`);
  const core = dirname(createRequire(mcpPackage).resolve('playwright-core/package.json'));
  const browsersJson = join(core, 'browsers.json');
  const { browsers } = JSON.parse(readFileSync(browsersJson, 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const ffmpeg = browsers.find((browser) => browser.name === 'ffmpeg');
  if (ffmpeg === undefined) throw new Error(`No ffmpeg entry in ${browsersJson}`);
  bundled = {
    mcpCli: join(dirname(mcpPackage), cli),
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
    command: '{node}',
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
    node: () => process.execPath,
    playwrightMcp: () => bundledPlaywright().mcpCli,
  };
  const render = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? values[name]!() : whole));
  return { ...server, command: render(server.command), args: server.args.map(render) };
}
