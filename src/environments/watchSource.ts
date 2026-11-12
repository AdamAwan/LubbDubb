import type { GoalWatchKind, WatchSourceDeclaration, WatchSourceLanguage, WatchSourceRunner } from '../types.js';

// → docs/spec/29-post-deploy-watch.md#sources

export const WATCH_SOURCE_LANGUAGES: readonly WatchSourceLanguage[] = ['kql', 'sql', 'promql', 'other'];

export const WATCH_SOURCE_RUNNERS: readonly WatchSourceRunner[] = ['harness', 'operator'];

/** The name `watch.observe` alone stands for. */
const SHORTHAND_SOURCE = 'logs';

export interface WatchSourceConfig {
  language: WatchSourceLanguage;
  runBy: WatchSourceRunner;
  observe?: string;
  queryUrl?: string;
}

interface WatchSourcesConfig {
  observe?: string;
  queryUrl?: string;
  sources?: Record<string, WatchSourceConfig>;
}

export interface WatchSource extends WatchSourceConfig {
  name: string;
}

/**
 * Every source an environment's `watch` declares, with `observe` alone read as the one `kql` source
 * the harness runs. The only reader of either spelling: everything downstream sees sources.
 */
export function watchSources(watch: WatchSourcesConfig | undefined): WatchSource[] {
  if (watch === undefined) return [];
  if (watch.sources !== undefined) return Object.entries(watch.sources).map(([name, s]) => ({ ...s, name }));
  if (watch.observe === undefined) return [];
  return [
    {
      name: SHORTHAND_SOURCE,
      language: 'kql',
      runBy: 'harness',
      observe: watch.observe,
      ...(watch.queryUrl === undefined ? {} : { queryUrl: watch.queryUrl }),
    },
  ];
}

export function watchSourceDeclarations(watch: WatchSourcesConfig | undefined): WatchSourceDeclaration[] {
  return watchSources(watch).map(({ name, language, runBy }) => ({ name, language, runBy }));
}

/** Some source on this environment is one the harness can put a query to itself. */
export function harnessReadable(watch: WatchSourcesConfig | undefined): boolean {
  return watchSources(watch).some((s) => s.runBy === 'harness' && (s.observe ?? '').trim() !== '');
}

/** A language whose aggregation the harness cannot see, so it can take no signal. */
export function measuresOnly(language: WatchSourceLanguage): boolean {
  return language === 'promql' || language === 'other';
}

function measuresOnlyRefusal(environment: string, source: WatchSource): string {
  return (
    `\`${source.name}\` on ${environment} is a ${source.language} source, which takes measures only: the harness ` +
    `cannot read whether a ${source.language} query aggregates, and a signal that aggregates reads as one ` +
    'occurrence on every reading for ever. Write it as a measure with an "under".'
  );
}

type ResolvedSource =
  | { source: WatchSource & { observe: string }; refusal: null; operator: null }
  | { source: null; refusal: string; operator: WatchSource | null };

/**
 * The source a check reads on one environment, or **why the harness reads nothing there** — which is
 * `unknown` on that environment, never clean and never a refusal of the whole watch. A source only a
 * person can run comes back as `operator`: the harness spawns nothing for it and asks instead.
 * → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run
 */
export function resolveWatchSource(
  environment: { name: string; watch?: WatchSourcesConfig },
  check: { source: string | null; kind: GoalWatchKind },
): ResolvedSource {
  const sources = watchSources(environment.watch);
  const source = pickSource(environment.name, sources, check.source);
  if (typeof source === 'string') return { source: null, refusal: source, operator: null };
  if (check.kind === 'signal' && measuresOnly(source.language))
    return { source: null, refusal: measuresOnlyRefusal(environment.name, source), operator: null };
  if (source.runBy === 'operator')
    return {
      source: null,
      refusal:
        `\`${source.name}\` on ${environment.name} is run by the operator: the harness puts no query to it, ` +
        'and asks a person for the reading instead',
      operator: source,
    };
  const observe = source.observe ?? '';
  if (observe.trim() === '')
    return {
      source: null,
      refusal: `\`${source.name}\` on ${environment.name} declares no observe command`,
      operator: null,
    };
  return { source: { ...source, observe }, refusal: null, operator: null };
}

function pickSource(environment: string, sources: readonly WatchSource[], named: string | null): WatchSource | string {
  if (named !== null) return sources.find((s) => s.name === named) ?? `${environment} has no \`${named}\` source`;
  if (sources.length === 1) return sources[0]!;
  if (sources.length === 0) return `${environment} declares no watch source`;
  return (
    `${environment} declares ${String(sources.length)} sources (${sources.map((s) => `\`${s.name}\``).join(', ')}) ` +
    'and this check names none of them'
  );
}

/** The source a check names on this environment, for drawing — whether or not the harness can read it. */
export function declaredSource(watch: WatchSourcesConfig | undefined, named: string | null): WatchSource | null {
  const sources = watchSources(watch);
  if (named !== null) return sources.find((s) => s.name === named) ?? null;
  return sources.length === 1 ? sources[0]! : null;
}

/**
 * Why a check cannot be saved, where the environments that would read it are known — or null. A signal
 * naming a source in a measures-only language is refused here; everywhere the configuration is not to
 * hand, the same check reads `unknown` on that environment instead.
 */
export function watchSourceRefusal(
  environments: readonly { name: string; watch?: WatchSourcesConfig }[],
  check: { source: string | null; kind: GoalWatchKind },
): string | null {
  if (check.kind !== 'signal') return null;
  for (const environment of environments) {
    const source = declaredSource(environment.watch, check.source);
    if (source !== null && measuresOnly(source.language)) return measuresOnlyRefusal(environment.name, source);
  }
  return null;
}
