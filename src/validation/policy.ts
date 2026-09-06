import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// → docs/spec/20-validation.md

export interface ValidationPolicy {
  desktopClaimMinutes: number;
  desktopSocketPath: string;
  desktopCredentialPath: string;
  desktopSkillPath: string;
}

export const DEFAULT_VALIDATION: ValidationPolicy = {
  desktopClaimMinutes: 60,
  // TECHDEBT: under the OS tmpdir for the fleet socket's reason: POSIX caps a socket path
  // at about 104 characters, which a repo-relative path clears easily.
  desktopSocketPath:
    process.platform === 'win32' ? '\\\\.\\pipe\\lubbdubb-desktop' : join(tmpdir(), 'lubbdubb', 'mcp-desktop.sock'),
  desktopCredentialPath: join(homedir(), '.lubbdubb', 'desktop.json'),
  desktopSkillPath: join(homedir(), '.claude', 'skills', 'lubbdubb', 'SKILL.md'),
};
