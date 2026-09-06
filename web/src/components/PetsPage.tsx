import { useEffect, useMemo, useState, type JSX } from 'react';
import { api } from '../api.js';
import type {
  PetActionKind,
  PetCatalogue,
  PetCatalogueEntry,
  PetCatalogueSource,
  PetRarity,
  PetSpecies,
  PetStage,
  PetState,
} from '../types.js';
import { PET_STAGES, speciesSeen } from '../pets/reveal.js';
import { SpeciesSprite } from './SpeciesSprite.js';
import { absDate } from './util.js';
import { Panel } from './panel.js';

// → docs/spec/17-cockpit.md

export function PetsPage({ pets }: { pets: PetState }): JSX.Element {
  const [catalogue, setCatalogue] = useState<PetCatalogue | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .getPetCatalogue()
      .then((next) => {
        if (live) setCatalogue(next);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const seen = useMemo(() => speciesSeen(pets.pets), [pets.pets]);
  const found = useMemo(
    () => new Set([...seen].filter(([, stages]) => stages.has('juvenile')).map(([species]) => species)),
    [seen],
  );

  if (failed) return <p className="muted">The catalogue did not load. It returns by itself when the link does.</p>;
  if (catalogue === null) return <p className="muted">Reading the catalogue…</p>;

  const { rules, rarities, species, sources } = catalogue;
  if (species.length === 0)
    return (
      <p className="muted">
        The catalogue is built from the harness&rsquo;s own tables, which this build does not run.
      </p>
    );
  const weighed = rarities.reduce((sum, tier) => sum + rules.rarity[tier], 0);
  const kinds = [...new Set(sources.map((row) => row.kind))];
  const everyKind = kinds.length;
  const meanDrop = kinds.reduce((sum, kind) => sum + rules.rates[kind].dropChance, 0) / Math.max(1, kinds.length);

  return (
    <div className="species">
      <div className="species-intro">
        <p>
          Every pet you can get, how often it drops, and what each one looks like as it grows. Rates are set in the code
          and cannot be changed.
        </p>
        <p className="muted small">
          You have found <b>{found.size}</b> of {species.length}. A pet you have not found keeps its rate and its
          sources, and withholds its name, its forms and its colours. An egg you have not opened counts for none of
          them, and each age appears once one of yours has reached it.
        </p>
        {/* The one thing on this page that is about *this* deployment rather than
            about the tables. Every rate above is a claim about what an action is
            worth, and on a harness that took pets long after it started working
            there is a whole history of actions those rates visibly did not pay
            for — which reads as the feature being broken. It is not: the vivarium
            counts from a start, and this says when that was. Drawn only once the
            start exists, because a sentence about a boundary nothing has decided
            yet would be worse than the silence. */}
        {pets.startedAt === null ? null : (
          <p className="muted small">
            This vivarium has been counting since <b>{absDate(pets.startedAt)}</b>. Anything done before then is on
            record and pays nothing — otherwise a harness that took pets years in would roll all of it in one pass, and
            spend its first pet on something nobody remembers doing.
          </p>
        )}
      </div>

      <h3 className="species-h">Drop rates</h3>
      <dl className="species-odds">
        <Odd
          label="Beats per $"
          value={rules.beatsPerDollar.toLocaleString()}
          why="Beats are what you feed a pet. You earn them from money the fleet has already spent — you cannot buy them."
        />
        <Odd
          label="Blend yield"
          value={rules.blendYield.toLocaleString()}
          why="Beats returned for dissolving a spare, scaled by how big that pet is. Always less than one stage costs."
        />
      </dl>

      {/* A rate per action rather than one figure. The price runs roughly inverse to
          how often the action comes up, so a single number would make whichever
          button the deployment presses most into the whole vivarium — which is the
          thing the per-kind table exists to stop. */}
      <div className="species-scroll">
        <table className="species-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Drop chance</th>
              <th>That is</th>
              <th>Pity</th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind) => (
              <tr key={kind}>
                <td className="species-kind" title={KIND_NOTE[kind]}>
                  {KIND_LABEL[kind]}
                </td>
                <td className="species-figure">{pct(rules.rates[kind].dropChance)}</td>
                <td className="species-figure muted">
                  1 in {Math.round(1 / rules.rates[kind].dropChance).toLocaleString()}
                </td>
                <td
                  className="species-figure muted"
                  title={`After ${rules.rates[kind].pity.toLocaleString()} of these with no pet, the next one is a pet. That is twice the usual wait, so it caps bad luck rather than setting a schedule — and it does not change which tier you get.`}
                >
                  {rules.rates[kind].pity.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        className="species-tiers"
        title="When you get a pet, its tier is picked from this one table — the same for every action. Which pet you then get is picked evenly from that action's pets of that tier."
      >
        {rarities.map((tier) => (
          <i key={tier} className={`is-${tier}`} style={{ flexGrow: rules.rarity[tier] }}>
            {rules.rarity[tier] / weighed >= 0.06 ? tier : ''}
          </i>
        ))}
      </div>
      <p className="species-key muted small">
        {rarities.map((tier) => (
          <span key={tier} className={`is-${tier}`}>
            <i />
            {tier} {Math.round((rules.rarity[tier] / weighed) * 100)}%
          </span>
        ))}
      </p>

      <h3 className="species-h">All {species.length} pets</h3>
      {rarities.map((tier) => {
        const members = species.filter((entry) => entry.rarity === tier).sort((a, b) => b.share - a.share);
        if (members.length === 0) return null;
        return (
          <section key={tier} className={`species-band is-${tier}`}>
            <div className="species-band-head">
              <h4>{tier}</h4>
              <span>
                {members.filter((entry) => found.has(entry.species)).length} of {members.length} found ·{' '}
                {pct(members.reduce((sum, entry) => sum + entry.share, 0))} of drops
              </span>
              <hr />
            </div>
            <div className="species-grid">
              {members.map((entry) => (
                <SpeciesCard
                  key={entry.species}
                  entry={entry}
                  known={found.has(entry.species)}
                  seen={seen.get(entry.species) ?? EMPTY}
                  rules={rules}
                  everyKind={everyKind}
                  meanDrop={meanDrop}
                />
              ))}
            </div>
          </section>
        );
      })}

      <h3 className="species-h">
        Where each pet comes from
        {sources.some((row) => row.landed !== row.rolled) ? (
          <span
            className="species-legend"
            title="If an action has no pet at the tier you rolled, the roll steps down a tier — never up."
          >
            ↓ = stepped down a tier
          </span>
        ) : null}
      </h3>
      <SourceTable sources={sources} rarities={rarities} species={species} found={found} kinds={kinds} />

      <p className="muted small species-foot">
        A pet&rsquo;s share of drops assumes you do all seven actions about equally often, and weighs each action by its
        own drop chance — so an upgrade counts for more of the catalogue than a job launch does. The two tables are
        exact per action. Every pet of a tier hatches as the same egg, so you find out what you got at the juvenile
        stage — and each age is drawn once a pet of yours has grown that far. ☾ marks a pet that can only drop in
        certain hours, going by the time of the action rather than the time you look.
      </p>
    </div>
  );
}

function Odd({ label, value, why }: { label: string; value: string; why: string }): JSX.Element {
  return (
    <div className="species-odd" title={why}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SpeciesCard({
  entry,
  known,
  seen,
  rules,
  everyKind,
  meanDrop,
}: {
  entry: PetCatalogueEntry;
  known: boolean;
  seen: ReadonlySet<PetStage>;
  rules: PetCatalogue['rules'];
  everyKind: number;
  meanDrop: number;
}): JSX.Element {
  const window = entry.hours === null ? null : hourWindow(entry.hours);
  const oneIn = Math.round(1 / (entry.share * meanDrop)).toLocaleString();
  return (
    <Panel density="flush" className={`species-card is-${entry.rarity}${known ? '' : ' is-unknown'}`}>
      <div className="species-top">
        <h5>{known ? entry.display : '???'}</h5>
        <span className="species-spacer" />
        {entry.hours === null ? null : (
          <span
            className="species-night"
            title={
              window === null
                ? 'Only drops in certain hours, going by the time of the action rather than the time you look.'
                : `Only drops between ${clock(window.from)} and ${clock(window.to)}, going by the time of the action rather than the time you look.`
            }
          >
            ☾ {window === null ? 'some hours' : `${clock(window.from)}–${clock(window.to)}`}
          </span>
        )}
        <span className={`pet-rarity is-${entry.rarity}`}>{entry.rarity}</span>
      </div>

      <div className="species-ages">
        {PET_STAGES.map((stage) => {
          const hidden = !known || !seen.has(stage);
          return (
            <div key={stage} className="species-age" title={ageNote(entry, stage, known, hidden)}>
              <span className="species-art">
                <SpeciesSprite
                  species={entry.species}
                  rarity={entry.rarity}
                  stage={stage}
                  seed={`catalogue:${entry.species}`}
                  size={70}
                  blank={hidden}
                />
              </span>
              <b>{hidden ? '???' : stage}</b>
            </div>
          );
        })}
      </div>

      <div className="species-stats">
        <div
          className="species-stat"
          title={`Share of all pet drops — about 1 in ${oneIn} actions. Assumes you do the seven actions about equally often.`}
        >
          <b>{pct(entry.share)}</b>
          <span>drop</span>
        </div>
        <div
          className="species-stat"
          title={`Beats to feed it from hatchling to adult — about $${Math.round(entry.adultAt / rules.beatsPerDollar).toLocaleString()} of fleet spend. Juvenile at ${entry.juvenileAt.toLocaleString()}.`}
        >
          <b>{entry.adultAt.toLocaleString()}</b>
          <span>to adult</span>
        </div>
        <div className="species-stat" title="Beats returned for dissolving a spare. Only available if you have two.">
          <b>{entry.blend.toLocaleString()}</b>
          <span>blend</span>
        </div>
      </div>

      <div className="species-srcs" title="Actions that can drop this pet.">
        {entry.kinds.length === everyKind ? (
          <span className="species-src">every action</span>
        ) : (
          entry.kinds.map((kind) => (
            <span key={kind} className="species-src">
              {KIND_LABEL[kind]}
            </span>
          ))
        )}
      </div>

      {/* Only for a species you have: five of one animal is the point being made,
          and five identical silhouettes would make it about nothing. */}
      {known ? (
        <div className="species-vary" title={`Four ${entry.display}s from four different actions.`}>
          {VARY_SEEDS.map((seed) => (
            <SpeciesSprite
              key={seed}
              species={entry.species}
              rarity={entry.rarity}
              stage="adult"
              seed={seed}
              size={56}
            />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function SourceTable({
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

const EMPTY: ReadonlySet<PetStage> = new Set();

const VARY_SEEDS: readonly string[] = ['escalation:esc_1', 'human-task:htk_2', 'plan:plan_3', 'landing:land_4'];

const KIND_LABEL: Record<PetActionKind, string> = {
  escalation: 'escalation',
  'human-task': 'task',
  plan: 'plan',
  landing: 'landing',
  job: 'job',
  claim: 'claim',
  finding: 'finding',
  upgrade: 'upgrade',
};

const KIND_NOTE: Record<PetActionKind, string> = {
  escalation: 'Answering an escalation',
  'human-task': 'Settling a task',
  plan: 'Accepting a plan',
  landing: 'Landing a stack',
  job: 'Launching a job',
  claim: 'Ruling on a claim',
  finding: 'Triaging a finding',
  upgrade: 'The harness updating itself',
};

function pct(share: number): string {
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1).replace(/\.0+$/, '')}%`;
}

function clock(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function ageNote(entry: PetCatalogueEntry, stage: PetStage, known: boolean, hidden: boolean): string {
  if (!known) return 'Find one to see this form.';
  if (hidden)
    return `Raise one this far to see this form — ${(stage === 'juvenile' ? entry.juvenileAt : entry.adultAt).toLocaleString()} beats.`;
  if (stage === 'hatchling')
    return `Every ${entry.rarity} hatches as this same egg. You find out what you got at the juvenile stage.`;
  return `${(stage === 'juvenile' ? entry.juvenileAt : entry.adultAt).toLocaleString()} beats fed.`;
}

/**
 * The window a gated species may be drawn in, as one wrapping run of hours.
 *
 * Returns null unless the hours form a single run, so a species gated on two
 * windows gets a vaguer label rather than a confidently wrong one — the chip says
 * "some hours" and the numbers stay on the wire where they are right.
 *
 * @public — read by `test/petCatalogue.test.ts`, which is where the wrap is checked.
 */
export function hourWindow(hours: readonly number[]): { from: number; to: number } | null {
  if (hours.length === 0 || hours.length >= 24) return null;
  const sorted = [...hours].sort((a, b) => a - b);
  const size = sorted.length;
  const breaks = sorted.filter((hour, i) => (sorted[(i + size - 1) % size]! + 1) % 24 !== hour);
  if (breaks.length !== 1) return null;
  const start = sorted.indexOf(breaks[0]!);
  return { from: sorted[start]!, to: (sorted[(start + size - 1) % size]! + 1) % 24 };
}
