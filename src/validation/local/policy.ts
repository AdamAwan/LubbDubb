import type { ExtraMcpServer, RecordingStatus } from '../../types.js';

// → docs/spec/32-local-validation.md

export const PLAYWRIGHT_MCP_VERSION = '0.0.85';
export const PLAYWRIGHT_VERSION = '1.66.0-alpha-2026-11-09';
export const FFMPEG_REVISION = '1013';

export interface LocalValidationPolicy {
  instruction: string;
  browser: ExtraMcpServer | null;
}

export const DEFAULT_LOCAL_VALIDATION: LocalValidationPolicy = {
  instruction: '',
  browser: {
    key: 'browser',
    command: 'npx',
    args: [
      '-y',
      `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
      '--output-dir',
      '{outputDir}',
      '--user-data-dir',
      '{profileDir}',
      '--caps',
      'devtools',
    ],
  },
};

const TOKENS = ['outputDir', 'profileDir'] as const;

export function substituteBrowserArgs(
  server: ExtraMcpServer,
  paths: { outputDir: string; profileDir: string },
): ExtraMcpServer {
  return {
    ...server,
    args: server.args.map((arg) => TOKENS.reduce((acc, token) => acc.split(`{${token}}`).join(paths[token]), arg)),
  };
}

export function recorderOffered(server: ExtraMcpServer | null): boolean {
  if (server === null) return false;
  return server.args.some((arg, i) => {
    const caps = arg.startsWith('--caps=')
      ? arg.slice('--caps='.length)
      : arg === '--caps'
        ? server.args[i + 1]
        : undefined;
    return caps !== undefined && caps.split(',').some((cap) => cap.trim() === 'devtools');
  });
}

export function recordingStatus(offered: boolean, video: boolean): RecordingStatus {
  if (video) return 'kept';
  return offered ? 'missing' : 'not_offered';
}
