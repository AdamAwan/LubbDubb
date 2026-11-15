import type { CiPolicyDescription } from '../ci/describeCiPolicy.js';
import type { ConfigChange } from '../config/configApply.js';
import type { PromptTemplateDescription } from '../dispatcher/promptTemplates.js';
import type { RunningConfigGroup } from '../server/runningConfig.js';
import type { SetupReading } from '../setup/reading.js';
import type { SetupResolution } from '../setup/resolve.js';
import type { RuntimeHealthReading } from '../types.js';

export interface PromptsPayload {
  dir: string | null;
  templates: PromptTemplateDescription[];
}

export type SetupPayload = SetupReading;

export type SetupResolvePayload = SetupResolution;

export interface RunningConfigPayload {
  groups: RunningConfigGroup[];
  file: string;
  projectFile: string | null;
  text: string;
  revision: string;
  pending: readonly ConfigChange[];
  canRestart: boolean;
}

export interface ConfigPreviewPayload {
  ok: true;
  text: string;
  changes: readonly ConfigChange[];
}

export interface ConfigSavePayload {
  ok: true;
  revision: string;
  changes: readonly ConfigChange[];
  pending: readonly ConfigChange[];
}

export interface HealthPayload {
  ok: true;
  runtime: RuntimeHealthReading;
}

export interface CiPolicyPayload {
  policy: CiPolicyDescription;
}

export interface McpChannelPayload {
  running: boolean;
  credentialPath: string;
  tools: { name: string; description: string }[];
}

/** → docs/spec/11-mcp-tools.md#the-plugin */
export type PluginStatusPayload = {
  bundle: { marketplaceDir: string; version: string } | null;
  skills: string[];
  legacySkill: boolean;
} & (
  | { state: 'unknown'; reason: string }
  | { state: 'missing'; installed: null }
  | { state: 'stale' | 'current'; installed: string }
);

export interface PluginInstallPayload {
  ok: boolean;
  steps: { label: string; ok: boolean; detail: string | null }[];
  status: PluginStatusPayload;
}
