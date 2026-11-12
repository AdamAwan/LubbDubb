import type { JSX } from 'react';
import type { CockpitEnvironment, GoalWatchKind, WatchSourceDeclaration } from '../types.js';
import { Tag } from './tag.js';

// → docs/spec/29-post-deploy-watch.md#sources

/** Every source a watched environment declares, by name, the first declaration of each name standing for it. */
export function watchSourceChoices(environments: readonly CockpitEnvironment[]): WatchSourceDeclaration[] {
  const seen = new Map<string, WatchSourceDeclaration>();
  for (const env of environments) for (const s of env.watchSources) if (!seen.has(s.name)) seen.set(s.name, s);
  return [...seen.values()];
}

/**
 * Which source a check reads, beside it. A check naming none reads the only source there is; where there
 * is more than one, or where nothing declares the one it names, the chip says so rather than guessing.
 */
export function WatchSourceChip({
  source,
  sources,
}: {
  source: string | null;
  sources: readonly WatchSourceDeclaration[];
}): JSX.Element | null {
  if (sources.length === 0 && source === null) return null;
  const declared =
    source === null ? (sources.length === 1 ? sources[0] : undefined) : sources.find((s) => s.name === source);
  if (declared === undefined)
    return source === null ? (
      <Tag tone="amber" title="This check names no source, and there is more than one — so it is read as unknown">
        no source
      </Tag>
    ) : (
      <Tag tone="amber" title="Nothing here declares this source, so the check is read as unknown">
        {source} · undeclared
      </Tag>
    );
  return (
    <Tag
      lower
      dashed={declared.runBy === 'operator'}
      title={
        declared.runBy === 'harness'
          ? 'Read by the harness on a schedule, at no cost to anyone'
          : 'Run by a person, with their own credential — the harness does not read it yet'
      }
    >
      {declared.name} · {declared.language}
    </Tag>
  );
}

/** The operator's choice of source on the add and edit form, offered where there is one to make. */
export function WatchSourcePicker({
  value,
  sources,
  onChange,
}: {
  value: string;
  sources: readonly WatchSourceDeclaration[];
  onChange: (value: string) => void;
}): JSX.Element {
  const known = sources.some((s) => s.name === value);
  return (
    <label className="cn-sig-field cn-sig-narrow">
      <span title="Where the query is asked. A check that names none reads an environment’s only source.">Source</span>
      <select className="cn-in" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">the environment’s only source</option>
        {!known && value !== '' && <option value={value}>{value} (undeclared)</option>}
        {sources.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} · {s.language} · {s.runBy === 'harness' ? 'read by the harness' : 'run by a person'}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A signal on a source whose aggregation the harness cannot see, refused before it is sent. */
export function measuresOnlyRefusal(
  kind: GoalWatchKind,
  source: string,
  sources: readonly WatchSourceDeclaration[],
): string | null {
  if (kind !== 'signal') return null;
  const declared =
    source === '' ? (sources.length === 1 ? sources[0] : undefined) : sources.find((s) => s.name === source);
  if (declared === undefined || (declared.language !== 'promql' && declared.language !== 'other')) return null;
  return (
    `A ${declared.language} source takes measures only: the harness cannot read whether such a query aggregates. ` +
    'Write the count as a measure with an “under”.'
  );
}
