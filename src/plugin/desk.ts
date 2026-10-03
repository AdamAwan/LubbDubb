import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveExecutable } from '../agents/resolveCommand.js';
import type { ErrorRecorder } from '../errorLog.js';
import { MCP_SERVER_ID } from '../mcp/names.js';
import type { PluginInstallPayload, PluginStatusPayload } from '../wire.js';
import { firstLine } from '../primitives.js';
import { ASSISTANT_ID, MANAGED_MARKER, PLUGIN_ID, writePluginBundle, type PluginBundle } from './bundle.js';

// → docs/spec/11-mcp-tools.md#the-plugin

export interface PluginCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface PluginCli {
  run(args: string[]): Promise<PluginCliResult>;
}

const CLI_TIMEOUT_MS = 120_000;
const STATUS_TTL_MS = 60_000;

export class ClaudePluginCli implements PluginCli {
  constructor(private readonly command: string) {}

  run(args: string[]): Promise<PluginCliResult> {
    return new Promise((resolve) => {
      let executable: string;
      try {
        executable = resolveExecutable(this.command);
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: (err as Error).message });
        return;
      }
      // A .cmd shim runs through cmd.exe, which splits an unquoted path with a space in it.
      const shell = /\.(cmd|bat)$/i.test(executable);
      execFile(
        shell ? quoted(executable) : executable,
        shell ? args.map(quoted) : args,
        { timeout: CLI_TIMEOUT_MS, windowsHide: true, shell },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
          resolve({ code, stdout, stderr: stderr || (err?.message ?? '') });
        },
      );
    });
  }
}

function quoted(arg: string): string {
  return `"${arg.replaceAll('"', '""')}"`;
}

interface PluginDeskOptions {
  cli: PluginCli;
  legacySkillPath: string;
  outDir: string;
  credentialPath: string;
  harnessRoot: string | null;
  errors: ErrorRecorder;
}

interface Installed {
  plugin: string | null;
  assistant: string | null;
}
type Listed = { ok: true; installed: Installed } | { ok: false; reason: string };

export class PluginDesk {
  private bundle: PluginBundle | null = null;
  private config: { url: string; tokenFile: string } | null = null;
  private cached: { status: PluginStatusPayload; at: number } | null = null;
  private installing: Promise<PluginInstallPayload> | null = null;

  constructor(private readonly opts: PluginDeskOptions) {}

  publish(where: { url: string; tokenFile: string }): PluginBundle | null {
    this.cached = null;
    try {
      this.bundle = writePluginBundle({
        ...where,
        outDir: this.opts.outDir,
        credentialPath: this.opts.credentialPath,
        harnessRoot: this.opts.harnessRoot,
      });
      this.config = where;
    } catch (err) {
      this.bundle = null;
      this.opts.errors.record({
        source: 'boot',
        message: `Could not write the LubbDubb plugin to ${this.opts.outDir}`,
        detail: (err as Error).message,
      });
    }
    return this.bundle;
  }

  async status(): Promise<PluginStatusPayload> {
    if (this.cached === null || Date.now() - this.cached.at > STATUS_TTL_MS)
      this.cached = { status: await this.read(), at: Date.now() };
    return this.cached.status;
  }

  async refresh(): Promise<PluginInstallPayload | null> {
    this.cached = null;
    return (await this.status()).state === 'stale' ? this.install() : null;
  }

  install(): Promise<PluginInstallPayload> {
    this.installing ??= this.settle().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async settle(): Promise<PluginInstallPayload> {
    const steps = await this.attempt();
    this.cached = null;
    const ok = steps.every((s) => s.ok);
    if (!ok)
      this.opts.errors.record({
        source: 'agent',
        message: 'The LubbDubb plugin install did not finish cleanly',
        detail: steps
          .filter((s) => !s.ok)
          .map((s) => `${s.label}: ${s.detail ?? ''}`)
          .join('\n'),
      });
    return { ok, steps, status: await this.status() };
  }

  private async read(): Promise<PluginStatusPayload> {
    const bundle =
      this.bundle === null ? null : { marketplaceDir: this.bundle.marketplaceDir, version: this.bundle.version };
    const base = { bundle, skills: this.bundle?.skills ?? [], legacySkill: this.legacySkillPresent() };
    if (this.bundle === null)
      return { ...base, state: 'unknown', reason: 'the plugin was not written at boot — see the error log' };
    const listed = await this.listed();
    if (!listed.ok) return { ...base, state: 'unknown', reason: listed.reason };
    const { plugin, assistant } = listed.installed;
    if (plugin === null || assistant === null) return { ...base, state: 'missing', installed: null };
    const { version } = this.bundle;
    const behind = [plugin, assistant].find((v) => v !== version);
    return behind === undefined
      ? { ...base, state: 'current', installed: version }
      : { ...base, state: 'stale', installed: behind };
  }

  private async listed(): Promise<Listed> {
    const result = await this.opts.cli.run(['plugin', 'list', '--json']);
    if (result.code !== 0) return { ok: false, reason: failure('claude plugin list', result) };
    try {
      return { ok: true, installed: installedVersions(result.stdout) };
    } catch (err) {
      return { ok: false, reason: `could not read claude plugin list: ${(err as Error).message}` };
    }
  }

  private async attempt(): Promise<PluginInstallPayload['steps']> {
    const { bundle, config } = this;
    if (bundle === null || config === null)
      return [{ label: 'write the plugin', ok: false, detail: 'it was not written at boot — see the error log' }];
    const steps: PluginInstallPayload['steps'] = [];
    const step = async (label: string, args: string[]): Promise<boolean> => {
      const result = await this.opts.cli.run(args);
      const ok = result.code === 0;
      steps.push({ label, ok, detail: ok ? null : failure(`claude ${args.slice(0, 3).join(' ')}`, result) });
      return ok;
    };

    if (
      !(await step('add the marketplace', ['plugin', 'marketplace', 'add', bundle.marketplaceDir, '--scope', 'user']))
    )
      return steps;
    const listed = await this.listed();
    if (!listed.ok) return [...steps, { label: 'read what is installed', ok: false, detail: listed.reason }];
    const placings = [
      {
        key: 'plugin' as const,
        id: PLUGIN_ID,
        what: 'the plugin',
        config: ['--config', `url=${config.url}`, '--config', `tokenFile=${config.tokenFile}`],
      },
      { key: 'assistant' as const, id: ASSISTANT_ID, what: 'the PR assistant', config: [] },
    ];
    for (const placing of placings) {
      const placed =
        listed.installed[placing.key] === null
          ? await step(`install ${placing.what}`, [
              'plugin',
              'install',
              placing.id,
              '--scope',
              'user',
              '--json',
              ...placing.config,
            ])
          : await step(`update ${placing.what}`, ['plugin', 'update', placing.id, '--scope', 'user']);
      if (!placed) return steps;
    }

    steps.push(this.removeLegacySkill());
    const registered = await this.opts.cli.run(['mcp', 'get', MCP_SERVER_ID]);
    if (registered.code === 0 && /bridge\.mjs\s+--desktop/.test(registered.stdout))
      await step('remove the old MCP registration', ['mcp', 'remove', '--scope', 'user', MCP_SERVER_ID]);
    return steps;
  }

  private legacySkillPresent(): boolean {
    if (!existsSync(this.opts.legacySkillPath)) return false;
    try {
      return readFileSync(this.opts.legacySkillPath, 'utf8').includes(MANAGED_MARKER);
    } catch (err) {
      this.opts.errors.record({
        source: 'agent',
        message: `Could not read ${this.opts.legacySkillPath} to tell whether it is the old /lubbdubb skill`,
        detail: (err as Error).message,
      });
      return false;
    }
  }

  private removeLegacySkill(): PluginInstallPayload['steps'][number] {
    const label = 'remove the old /lubbdubb skill';
    if (!this.legacySkillPresent()) return { label, ok: true, detail: null };
    try {
      rmSync(this.opts.legacySkillPath);
      const dir = dirname(this.opts.legacySkillPath);
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
      return { label, ok: true, detail: null };
    } catch (err) {
      return { label, ok: false, detail: (err as Error).message };
    }
  }
}

function installedVersions(stdout: string): Installed {
  const rows = JSON.parse(stdout) as { id?: string; version?: string; scope?: string }[];
  if (!Array.isArray(rows)) throw new Error('expected a list');
  const version = (id: string): string | null => {
    const row = rows.find((r) => r.id === id && r.scope === 'user');
    return row === undefined ? null : (row.version ?? '');
  };
  return { plugin: version(PLUGIN_ID), assistant: version(ASSISTANT_ID) };
}

function failure(what: string, result: PluginCliResult): string {
  const line = firstLine(result.stderr) ?? firstLine(result.stdout);
  return `${what} exited ${result.code ?? 'without a code'}${line ? `: ${line}` : ''}`;
}
