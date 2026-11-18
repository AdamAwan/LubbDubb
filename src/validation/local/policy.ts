import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../../dispatcher/promptTemplates.js';
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
  const mcp = JSON.parse(readFileSync(mcpPackage, 'utf8')) as { bin: { 'playwright-mcp': string } };
  const core = dirname(createRequire(mcpPackage).resolve('playwright-core/package.json'));
  const browsersJson = join(core, 'browsers.json');
  const { browsers } = JSON.parse(readFileSync(browsersJson, 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const ffmpeg = browsers.find((browser) => browser.name === 'ffmpeg');
  if (ffmpeg === undefined) throw new Error(`No ffmpeg entry in ${browsersJson}`);
  bundled = {
    mcpCli: join(dirname(mcpPackage), mcp.bin['playwright-mcp']),
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
  const render = (text: string): string =>
    renderTemplate(text, {
      ...paths,
      node: process.execPath,
      playwrightMcp: text.includes(PLAYWRIGHT_MCP_TOKEN) ? bundledPlaywright().mcpCli : undefined,
    });
  return { ...server, command: render(server.command), args: server.args.map(render) };
}
