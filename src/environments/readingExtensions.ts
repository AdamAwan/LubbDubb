import type { LoadedExtension } from '../extensions/contract.js';
import type { ExtensionSlots } from '../extensions/slots.js';
import { sentence } from '../primitives.js';
import type { EnvironmentConfig } from './policy.js';

// → docs/spec/42-extensions.md#the-slots

/** What stands in for the command a reading would run, on an environment whose extension answers it. */
export const READING_SLOT_LABELS = {
  at: 'the "deployedCommits" slot',
  errorsList: 'the "appErrors" slot',
  errorsDetail: 'the "appErrorDetail" slot',
  exposure: 'the "watchExposure" slot',
} as const;

export function atFromExtension(environment: EnvironmentConfig): boolean {
  return environment.atExtension === true;
}

export function errorsFromExtension(environment: EnvironmentConfig): boolean {
  return environment.errors?.extension === true;
}

export function watchFromExtension(environment: EnvironmentConfig): boolean {
  return environment.watch?.extension === true;
}

/** The command `at` names, or what answers in its place. */
export function atCommand(environment: EnvironmentConfig): string {
  return atFromExtension(environment) ? READING_SLOT_LABELS.at : (environment.at ?? '');
}

/** The declared `errors.list`, or what answers in its place; null where the environment reads no errors. */
export function errorsListCommand(environment: EnvironmentConfig): string | null {
  if (errorsFromExtension(environment)) return READING_SLOT_LABELS.errorsList;
  return environment.errors?.list ?? null;
}

/** The declared `watch.exposure.command`, or what answers in its place. */
export function exposureCommand(environment: EnvironmentConfig): string {
  if (watchFromExtension(environment)) return READING_SLOT_LABELS.exposure;
  return environment.watch?.exposure?.command ?? '';
}

interface ReadingOptIn {
  key: string;
  slot: keyof ExtensionSlots;
  opted: (environment: EnvironmentConfig) => boolean;
}

const READING_OPT_INS: readonly ReadingOptIn[] = [
  { key: 'atExtension', slot: 'deployedCommits', opted: atFromExtension },
  { key: 'errors.extension', slot: 'appErrors', opted: errorsFromExtension },
  { key: 'watch.extension', slot: 'watchReading', opted: watchFromExtension },
  {
    key: 'watch.extension',
    slot: 'watchExposure',
    opted: (e) => watchFromExtension(e) && e.watch?.exposure !== undefined,
  },
];

/** Every environment that hands a reading to the extension needs one that fills its slot. */
export function checkReadingExtensions(
  environments: readonly EnvironmentConfig[],
  loaded: readonly LoadedExtension[] = [],
): void {
  for (const { key, slot, opted } of READING_OPT_INS) {
    const unanswered = environments.filter(opted);
    if (unanswered.length === 0 || loaded.some((extension) => extension.slots.has(slot))) continue;
    throw new Error(
      `Refusing to start: ${sentence(unanswered.map((env) => `"${env.name}"`))} set "${key}" and no extension ` +
        `fills the "${slot}" slot, so nothing could answer it. Add the extension to "extensions", or declare the ` +
        'command instead.',
    );
  }
}
