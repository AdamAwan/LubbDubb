import type { JSX } from 'react';
import type { PetActionKind, PetCatalogueEntry, PetCatalogueSource, PetRarity, PetSpecies } from '../types.js';

// → docs/spec/17-cockpit.md

export const KIND_LABEL: Record<PetActionKind, string> = {
  escalation: 'escalation',
  'human-task': 'task',
  plan: 'plan',
  landing: 'landing',
  job: 'job',
  claim: 'claim',
  finding: 'finding',
  upgrade: 'upgrade',
};

export const KIND_NOTE: Record<PetActionKind, string> = {
  escalation: 'Answering an escalation',
  'human-task': 'Settling a task',
  plan: 'Accepting a plan',
  landing: 'Landing a stack',
  job: 'Launching a job',
  claim: 'Ruling on a claim',
  finding: 'Triaging a finding',
  upgrade: 'The harness updating itself',
};

export function SourceTable({
  sources,
  rarities,
  species,
  found,
  kinds,
}: {
  sources: PetCatalogueSource[];
  rarities: PetRarity[];
  species: PetCatalogueEntry[];
  found: Set<PetSpecies>;
  kinds: PetActionKind[];
}): JSX.Element {
  const display = new Map(species.map((entry) => [entry.species, entry.display]));
  const gated = new Set(species.filter((entry) => entry.hours !== null).map((entry) => entry.species));
  const cell = (kind: PetActionKind, rolled: PetRarity) => sources.find((r) => r.kind === kind && r.rolled === rolled);
  return (
    <div className="species-scroll">
      <table className="species-table">
        <thead>
          <tr>
            <th>What you did</th>
            {rarities.map((tier) => (
              <th key={tier}>rolled {tier}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {kinds.map((kind) => (
            <tr key={kind}>
              <td className="species-kind" title={KIND_NOTE[kind]}>
                {KIND_LABEL[kind]}
              </td>
              {rarities.map((tier) => {
                const row = cell(kind, tier);
                if (row === undefined)
                  return (
                    <td key={tier}>
                      <span className="species-landed">nothing</span>
                    </td>
                  );
                const stepped = rarities.indexOf(row.landed) < rarities.indexOf(row.rolled);
                return (
                  <td key={tier}>
                    <span
                      className={`species-landed is-${row.landed}${stepped ? ' is-stepped' : ''}`}
                      title={stepped ? `No ${row.rolled} here, so the roll steps down.` : undefined}
                    >
                      {row.landed}
                      {stepped ? ' ↓' : ''}
                    </span>
                    <span className="species-members">
                      {row.members
                        .map(
                          (member) =>
                            `${found.has(member) ? (display.get(member) ?? member) : '???'}${gated.has(member) ? ' ☾' : ''}`,
                        )
                        .join(' · ')}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
