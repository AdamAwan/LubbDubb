import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_ID } from '../mcp/names.js';

// → docs/spec/11-mcp-tools.md#the-plugin

const PLUGIN_NAME = 'lubbdubb';
const MARKETPLACE_NAME = 'lubbdubb';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

const SOURCE_DIR = fileURLToPath(new URL('../../plugin/', import.meta.url));
const BRIDGE_PATH = fileURLToPath(new URL('../mcp/bridge.mjs', import.meta.url));
const SHIPPED = ['hooks', 'skills', 'types'];
const MANIFEST = '.claude-plugin/plugin.json';
export const MANAGED_MARKER = 'Managed by LubbDubb';

export interface PluginBundleInput {
  outDir: string;
  harnessRoot: string | null;
  url: string;
  tokenFile: string;
  credentialPath: string;
}

export interface PluginBundle {
  marketplaceDir: string;
  version: string;
  skills: string[];
}

interface PluginSkill {
  name: string;
  text: string;
}

export function pluginSkills(): PluginSkill[] {
  const root = join(SOURCE_DIR, 'skills');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: readFileSync(join(root, name, 'SKILL.md'), 'utf8') }));
}

export function writePluginBundle(input: PluginBundleInput): PluginBundle {
  const files = new Map<string, string | Buffer>();
  for (const entry of SHIPPED) collect(SOURCE_DIR, entry, files);

  const skills = pluginSkills();
  for (const skill of skills)
    files.set(
      `skills/${skill.name}/SKILL.md`,
      `${skill.text.trimEnd()}

<!-- ${MANAGED_MARKER}: written from scratch every time the harness starts. -->
${harnessRootSection(input.harnessRoot)}`,
    );
  files.set('mcp/bridge.mjs', readFileSync(BRIDGE_PATH));
  files.set(
    '.mcp.json',
    json({
      mcpServers: {
        [MCP_SERVER_ID]: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/mcp/bridge.mjs', '--desktop'],
          env: { LUBBDUBB_DESKTOP_CREDENTIAL: input.credentialPath },
        },
      },
    }),
  );

  const manifest = JSON.parse(readFileSync(join(SOURCE_DIR, MANIFEST), 'utf8')) as PluginManifest;
  manifest.userConfig.url.default = input.url;
  manifest.userConfig.tokenFile.default = input.tokenFile;
  manifest.version = `1.0.0-${digest(new Map([...files, [MANIFEST, json({ ...manifest, version: '' })]]))}`;
  files.set(MANIFEST, json(manifest));
  const bundle = { marketplaceDir: input.outDir, version: manifest.version, skills: skills.map((s) => s.name) };

  const pluginDir = join(input.outDir, PLUGIN_NAME);
  const catalogue = join(input.outDir, '.claude-plugin', 'marketplace.json');
  if (writtenVersion(pluginDir, catalogue) === manifest.version) return bundle;
  rmSync(pluginDir, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(pluginDir, path)), { recursive: true });
    writeFileSync(join(pluginDir, path), content);
  }
  mkdirSync(join(input.outDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    catalogue,
    json({
      name: MARKETPLACE_NAME,
      owner: { name: 'LubbDubb' },
      plugins: [{ name: PLUGIN_NAME, source: `./${PLUGIN_NAME}`, description: manifest.description }],
    }),
  );
  return bundle;
}

function writtenVersion(pluginDir: string, catalogue: string): string | null {
  const manifest = readIfThere(join(pluginDir, MANIFEST));
  if (manifest === null || readIfThere(catalogue) === null) return null;
  try {
    return (JSON.parse(manifest) as { version?: string }).version ?? null;
  } catch {
    // A half-written manifest is rewritten rather than refused on every boot that follows.
    return null;
  }
}

function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

interface PluginManifest {
  version: string;
  description: string;
  userConfig: { url: { default: string }; tokenFile: { default: string } };
}

function collect(root: string, entry: string, into: Map<string, string | Buffer>): void {
  for (const child of readdirSync(join(root, entry), { withFileTypes: true })) {
    const path = join(entry, child.name);
    if (child.isDirectory()) collect(root, path, into);
    else into.set(path.replaceAll('\\', '/'), readFileSync(join(root, path)));
  }
}

function digest(files: Map<string, string | Buffer>): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) hash.update(path).update('\0').update(files.get(path)!).update('\0');
  return hash.digest('hex').slice(0, 12);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function harnessRootSection(harnessRoot: string | null): string {
  if (harnessRoot === null) return '';
  return `
## Where LubbDubb's own source is

This session is open on the repository the fleet **works on**. LubbDubb itself —
the harness, the cockpit, the dispatcher — is a different checkout, at:

    ${harnessRoot}

Read it when the question is about the harness's own behaviour rather than about
the work: why a goal was not picked up, why a rule did not fire, why the cockpit
shows what it shows. \`docs/spec/\` there is the specification, one document per
subsystem, and \`docs/README.md\` is its index.

- **The record first, the source second.** \`fleet_status\` and \`goal_read\` say
  what this deployment actually did. The source says what it is meant to do, and
  the answer to "why is this not being done" is usually a hold the record names —
  not a bug.
- **Change nothing there.** That checkout is the running harness, and the fleet
  cuts its worktrees from it. A fault worth fixing is worth filing: say so, and
  leave it to the operator's cockpit, which files it on LubbDubb's own tracker.
`;
}
