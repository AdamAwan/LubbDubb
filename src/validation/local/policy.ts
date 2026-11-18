import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from '../../primitives.js';
import type { ExtraMcpServer } from '../../types.js';

// → docs/spec/32-local-validation.md

export interface BundledPlaywright {
  mcpCli: string;
  coreCli: string;
  ffmpegRevision: string | null;
}

let bundled: BundledPlaywright | undefined;

export function bundledPlaywright(): BundledPlaywright | string {
  if (bundled !== undefined) return bundled;
  try {
    bundled = readBundledPlaywright();
    return bundled;
  } catch (err) {
    return failure(err);
  }
}

function readBundledPlaywright(): BundledPlaywright {
  const mcpPackage = fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'));
  const { bin } = JSON.parse(readFileSync(mcpPackage, 'utf8')) as { bin?: string | Record<string, string> };
  const cli = typeof bin === 'string' ? bin : bin?.['playwright-mcp'];
  if (!cli) throw new Error(`No playwright-mcp bin in ${mcpPackage}`);
  const playwrightPackage = createRequire(mcpPackage).resolve('playwright/package.json');
  const core = dirname(createRequire(playwrightPackage).resolve('playwright-core/package.json'));
  const browsersJson = join(core, 'browsers.json');
  const { browsers } = JSON.parse(readFileSync(browsersJson, 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  return {
    mcpCli: join(dirname(mcpPackage), cli),
    coreCli: join(core, 'cli.js'),
    ffmpegRevision: browsers.find((browser) => browser.name === 'ffmpeg')?.revision ?? null,
  };
}

export interface LocalValidationPolicy {
  auto: boolean;
  instruction: string;
  setup: string;
  browser: ExtraMcpServer | null;
}

const PLAYWRIGHT_MCP_TOKEN = '{playwrightMcp}';

export const DEFAULT_LOCAL_VALIDATION: LocalValidationPolicy = {
  auto: false,
  instruction: '',
  setup: '',
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

export function usesBundledServer(server: ExtraMcpServer): boolean {
  return [server.command, ...server.args].some((part) => part.includes(PLAYWRIGHT_MCP_TOKEN));
}

export function substituteBrowserArgs(
  server: ExtraMcpServer,
  paths: { outputDir: string; profileDir: string },
  bundle: () => BundledPlaywright | string = bundledPlaywright,
): ExtraMcpServer {
  const values: Record<string, () => string | undefined> = {
    outputDir: () => paths.outputDir,
    profileDir: () => paths.profileDir,
    node: () => process.execPath,
    playwrightMcp: () => {
      const found = bundle();
      return typeof found === 'string' ? undefined : found.mcpCli;
    },
  };
  const render = (text: string): string =>
    text.replace(
      /\{(\w+)\}/g,
      (whole, name: string) => (Object.hasOwn(values, name) ? values[name]!() : undefined) ?? whole,
    );
  return { ...server, command: render(server.command), args: server.args.map(render) };
}
