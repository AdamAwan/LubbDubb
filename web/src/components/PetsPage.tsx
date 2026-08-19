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
import { SpeciesSprite } from './SpeciesSprite.js';

/**
 * The catalogue: every species that exists, what each costs, and how often it
 * turns up — the part of the vivarium you can read *before* you have the animal.
 *
 * **A species you have not hatched is withheld, not hidden.** Its rate, its cost
 * and the actions that draw it are all drawn; its name, its two grown forms and
 * its colours are not. That is the whole shape of the surface: a page that showed
 * everything would spend the reveal the sprites are built around — every tier
 * shares one egg precisely so that finding out *what you got* is worth waiting
 * for — and a page that showed nothing would answer none of the questions an
 * operator actually has. What is withheld is identity; what is published is
 * price.
 *
 * Like {@link PetsPanel}, nothing here gates, ranks or reports anything. If a
 * future change finds a number on this page convenient for a decision, the number
 * is the wrong source — it is written from tables the harness already ships, and
 * reading it back into a decision would be the harness quoting itself.
 *
 * → `docs/spec/22-pets.md#the-pets-page`
 */
export function PetsPage({ pets }: { pets: PetState }): JSX.Element {
  const [catalogue, setCatalogue] = useState<PetCatalogue | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetched once on open rather than read off the snapshot: it is the same bytes
  // on every request of a build, and a constant riding every heartbeat is paid for
  // forever. → `src/server/routes/pets.ts`
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

  // A blended pet still counts: its record stays, and so does the fact that you
  // once had one. Finding is about having seen the animal, not about owning it now.
  const found = useMemo(() => new Set(pets.pets.map((pet) => pet.species)), [pets.pets]);

  if (failed) return <p className="muted">The catalogue did not load. It returns by itself when the link does.</p>;
  if (catalogue === null) return <p className="muted">Reading the catalogue…</p>;

  const { rules, rarities, species, sources } = catalogue;
  // The demo serves an empty catalogue on purpose — what exists is decided by
  // tables the web bundle deliberately does not import, and a hand-written copy of
  // them would be stale the first time a species was added. Drawing the rules strip
  // over no species would put a 0% drop chance on screen, which is a lie rather
  // than an absence. → `web/src/demo/demoBackend.ts`
  if (species.length === 0)
    return (
      <p className="muted">
        The catalogue is built from the harness&rsquo;s own tables, which this build does not run.
      </p>
    );
  const weighed = rarities.reduce((sum, tier) => sum + rules.rarity[tier], 0);
  // Counted off the sources rather than off a literal seven, so an eighth action
  // collapses the same way rather than turning every universal card into a wall of
  // chips.
  const everyKind = new Set(sources.map((row) => row.kind)).size;

  return (
    <div className="species">
      <div className="species-intro">
        <p>
          Every pet you can get, how often it drops, and what each one looks like as it grows. Rates are set in the code
          and cannot be changed.
        </p>
        <p className="muted small">
          You have found <b>{found.size}</b> of {species.length}. A pet you have not found keeps its rate and its
          sources, and withholds its name, its grown forms and its colours.
        </p>
      </div>

      <h3 className="species-h">Drop rates</h3>
      <dl className="species-odds">
        <Odd
          label="Drop chance"
          value={`${Math.round(rules.dropChance * 100)}%`}
          why={`One action in ${Math.round(1 / rules.dropChance)} gives you a pet. The result comes from the action itself, not a random number, so reading the same action twice can never give you a second pet.`}
        />
        <Odd
          label="Pity"
          value={rules.pity.toLocaleString()}
          why={`After ${rules.pity.toLocaleString()} actions with no pet, the next one is a pet. That is twice the usual wait, so it caps bad luck rather than setting a schedule. It does not change which tier you get.`}
        />
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
                  eggSeen={members.some((sibling) => found.has(sibling.species))}
                  rules={rules}
                  everyKind={everyKind}
                />
              ))}
            </div>
          </section>
        );
      })}

      <h3 className="species-h">Where each pet comes from</h3>
      <SourceTable sources={sources} rarities={rarities} species={species} found={found} />

      <p className="muted small species-foot">
        Drop rates assume you do all seven actions about equally often; the table above is exact per action. Every pet
        of a tier hatches as the same egg, so you find out what you got at the juvenile stage. ☾ marks a pet that can
        only drop in certain hours, going by the time of the action rather than the time you look.
      </p>
    </div>
  );
}

/** One figure from the rules, with the sentence that says what it means on hover. */
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
  eggSeen,
  rules,
  everyKind,
}: {
  entry: PetCatalogueEntry;
  /** Whether this species is in the collection, which is what decides the reveal. */
  known: boolean;
  /** Whether any pet of this tier has been found — the egg is shared, so one is all it takes. */
  eggSeen: boolean;
  rules: PetCatalogue['rules'];
  /** How many actions there are in total, which is what makes the list collapsible. */
  everyKind: number;
}): JSX.Element {
  const window = entry.hours === null ? null : hourWindow(entry.hours);
  const oneIn = Math.round(1 / (entry.share * rules.dropChance)).toLocaleString();
  return (
    <div className={`species-card is-${entry.rarity}${known ? '' : ' is-unknown'}`}>
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
        {STAGES.map((stage) => {
          const hidden = stage === 'hatchling' ? !eggSeen : !known;
          return (
            <div key={stage} className="species-age" title={ageNote(entry, stage, hidden)}>
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
    </div>
  );
}

/**
 * Every action against every tier it can roll, and what that actually lands on.
 *
 * The step-down is invisible everywhere else in the cockpit and decides the most:
 * settling a task can never produce a rare, because `human-task` holds none and
 * the roll walks *down*. Names of species you have not found are withheld here
 * too — a table that spelled them out would undo the card grid above it.
 */
function SourceTable({
  sources,
  rarities,
  species,
  found,
}: {
  sources: PetCatalogueSource[];
  rarities: PetRarity[];
  species: PetCatalogueEntry[];
  found: Set<PetSpecies>;
}): JSX.Element {
  const display = new Map(species.map((entry) => [entry.species, entry.display]));
  const gated = new Set(species.filter((entry) => entry.hours !== null).map((entry) => entry.species));
  const kinds = [...new Set(sources.map((row) => row.kind))];
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

const STAGES: readonly PetStage[] = ['hatchling', 'juvenile', 'adult'];

/**
 * Four actions, so four palettes of one animal.
 *
 * Fixed strings rather than the operator's own pets: the point being made is that
 * the colours come from the action, and four drawn from whatever happens to be in
 * one collection would make it about that collection instead.
 *
 * Four rather than five because four adults fit a card at the narrowest column the
 * grid allows. A fifth scrolls, and a strip that scrolls is one nobody scrolls —
 * they read four and assume that is all of it.
 */
const VARY_SEEDS: readonly string[] = ['escalation:esc_1', 'human-task:htk_2', 'plan:plan_3', 'landing:land_4'];

/** What the operator was doing, in their words rather than the table's. */
const KIND_LABEL: Record<PetActionKind, string> = {
  escalation: 'escalation',
  'human-task': 'task',
  plan: 'plan',
  landing: 'landing',
  job: 'job',
  finding: 'finding',
  upgrade: 'upgrade',
};

const KIND_NOTE: Record<PetActionKind, string> = {
  escalation: 'Answering an escalation',
  'human-task': 'Settling a task',
  plan: 'Accepting a plan',
  landing: 'Landing a stack',
  job: 'Launching a job',
  finding: 'Triaging a finding',
  upgrade: 'The harness updating itself',
};

/** One decimal, or two where a rounding to 0.0% would read as never. */
function pct(share: number): string {
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1).replace(/\.0+$/, '')}%`;
}

function clock(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function ageNote(entry: PetCatalogueEntry, stage: PetStage, hidden: boolean): string {
  if (hidden) return 'Find one to see this form.';
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
 * @public — read by `test/petsPage.test.ts`, which is where the wrap is checked.
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
