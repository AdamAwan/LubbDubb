import type { PluginCli, PluginCliResult } from './desk.js';

// → docs/spec/11-mcp-tools.md#the-plugin

/** Answers `claude plugin list --json` from `installed`, records every call, and fails what `refuse` names. */
export class FakePluginCli implements PluginCli {
  readonly calls: string[][] = [];
  installed: { id: string; version: string; scope: string }[] = [];
  refuse = new Map<string, PluginCliResult>();
  /** What `claude mcp get lubbdubb` prints; empty is a registration that is not there. */
  registered = '';

  run(args: string[]): Promise<PluginCliResult> {
    this.calls.push(args);
    const refused = this.refuse.get(args.slice(0, 2).join(' '));
    if (refused !== undefined) return Promise.resolve(refused);
    if (args[0] === 'plugin' && args[1] === 'list')
      return Promise.resolve({ code: 0, stdout: JSON.stringify(this.installed), stderr: '' });
    if (args[0] === 'mcp' && args[1] === 'get')
      return Promise.resolve(
        this.registered === ''
          ? { code: 1, stdout: '', stderr: `No MCP server named "${args[2] ?? ''}"` }
          : { code: 0, stdout: this.registered, stderr: '' },
      );
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
}
