import { sentence } from '../primitives.js';
import type { EnvironmentConfig } from './policy.js';

// → docs/spec/42-extensions.md#the-slots — the reading keys, each refused beside the command it replaces.

type EnvironmentErrors = NonNullable<EnvironmentConfig['errors']>;
type EnvironmentWatch = NonNullable<EnvironmentConfig['watch']>;

export function validateAt(env: EnvironmentConfig, where: string): void {
  if (env.atExtension !== undefined) {
    if (env.atExtension !== true)
      throw new Error(
        `${where}: "atExtension" must be true, or be left out — true hands "which commit is this environment at" ` +
          "to the project's extension.",
      );
    if (env.at !== undefined)
      throw new Error(
        `${where}: "at" and "atExtension" are two answers to one question — keep the command, or drop it and let ` +
          'the extension answer.',
      );
    return;
  }
  if (typeof env.at !== 'string' || env.at.trim() === '')
    throw new Error(
      `${where}: "at" must be a non-empty command printing the commit this environment is at. ` +
        'An empty one names nothing, which leaves every goal unanswered forever.',
    );
}

export function validateErrorsExtension(errors: EnvironmentErrors, where: string): void {
  if (errors.extension !== true)
    throw new Error(
      `${where}: "errors.extension" must be true, or be left out — true hands the error groups and their detail ` +
        "to the project's extension.",
    );
  const beside = (['list', 'detail'] as const).filter((key) => errors[key] !== undefined);
  if (beside.length > 0)
    throw new Error(
      `${where}: "errors.extension" sits beside ${sentence(beside.map((k) => `"errors.${k}"`))} — two answers ` +
        'to one question. Keep the commands, or drop them and let the extension answer.',
    );
}

export function validateWatchExtension(watch: EnvironmentWatch, where: string): void {
  if (watch.extension !== true)
    throw new Error(
      `${where}: "watch.extension" must be true, or be left out — true hands this environment's readings and ` +
        "exposure to the project's extension.",
    );
  const beside = [
    ...(watch.observe === undefined ? [] : ['"watch.observe"']),
    ...Object.entries(watch.sources ?? {})
      .filter(([, source]) => (source as { observe?: unknown } | null)?.observe !== undefined)
      .map(([name]) => `"watch.sources.${name}.observe"`),
    ...(watch.exposure?.command === undefined ? [] : ['"watch.exposure.command"']),
  ];
  if (beside.length > 0)
    throw new Error(
      `${where}: "watch.extension" sits beside ${sentence(beside)} — two answers to one question. Keep the ` +
        'commands, or drop them and let the extension answer.',
    );
}
