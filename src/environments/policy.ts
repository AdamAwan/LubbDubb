/**
 * One environment a goal's landed work travels to, and how to ask whether it has
 * got there. → `docs/spec/23-environments.md#configuring-an-environment`
 */
export interface EnvironmentConfig {
  /**
   * What the operator calls it — `staging`, `prod`, `eu-west`. It is the display
   * label *and* the key every reading is stored against, so renaming one discards
   * what was known about it rather than migrating it.
   */
  name: string;
  /**
   * The command that answers, run in a shell in `repoRoot` with `LUBBDUBB_COMMIT`
   * and `LUBBDUBB_ENVIRONMENT` set. Exit `0` = the commit is there, `1` = it is not,
   * anything else = the probe could not say. → {@link CommandEnvironmentProber}
   */
  command: string;
}

/**
 * Refuse a list that cannot mean what it says.
 *
 * Every failure here is otherwise silent in the same direction: a nameless entry
 * stores its readings under `""`, a duplicate name has two commands writing over one
 * key, and an empty command exits 0 in every shell there is — which reports *every*
 * goal as being in that environment, confidently, forever.
 */
export function validateEnvironments(environments: EnvironmentConfig[]): void {
  if (!Array.isArray(environments))
    throw new Error('environments: must be a list of {name, command} entries — one per environment to probe.');
  const seen = new Set<string>();
  environments.forEach((env, i) => {
    const where = `environments[${i}]`;
    if (typeof env.name !== 'string' || env.name.trim() === '')
      throw new Error(`${where}: "name" must be a non-empty name — it is the key every reading is stored against.`);
    if (seen.has(env.name))
      throw new Error(
        `${where}: "${env.name}" is declared twice. Readings are keyed on the name, so the second command would ` +
          "overwrite the first's answers rather than adding an environment.",
      );
    seen.add(env.name);
    if (typeof env.command !== 'string' || env.command.trim() === '')
      throw new Error(
        `${where} ("${env.name}"): "command" must be a non-empty command. An empty one exits 0, which reports every ` +
          'goal as having reached this environment.',
      );
  });
}
