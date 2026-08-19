import { useState } from 'react';
import type { PetState, PetView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { petLabel, speciesKnown } from '../pets/reveal.js';
import { PetSprite } from './PetSprite.js';
import { relTime } from './util.js';

/**
 * The vivarium, whole.
 *
 * The **origin line** is the point of this surface. A grid of creatures is a toy;
 * a grid of creatures each labelled with the thing you were doing when it hatched
 * is a record, and it is the only part of the feature that gets better the longer
 * a deployment runs. Everything else here — the meter, the three buttons — is in
 * service of it.
 *
 * Nothing on this panel gates, ranks or reports anything. If a future change
 * finds a number here convenient for a decision, the number is the wrong source:
 * these tables are written from what an operator has already done, and reading
 * them back into a decision would be the harness marking its own homework.
 */
export function PetsPanel({
  pets,
  now,
  onFeed,
  onRename,
  onPlace,
  onBlend,
  onHatch,
}: {
  pets: PetState;
  now: number;
  onFeed: (id: string, beats: number) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onPlace: (id: string, placed: boolean) => Promise<unknown>;
  onBlend: (id: string) => Promise<unknown>;
  /** Open a shell — the ceremony, not a bare write. See `HatchModal`. */
  onHatch: (id: string) => void;
}) {
  const { wallet } = pets;
  // How many of each species are still alive, which is the whole of what decides
  // whether a card may offer Blend. Counted here rather than per card so the grid
  // walks the list once.
  const live = new Map<PetView['species'], number>();
  for (const pet of pets.pets) if (pet.dissolvedAt === null) live.set(pet.species, (live.get(pet.species) ?? 0) + 1);
  return (
    <div className="pets">
      <div className="pets-wallet">
        <div>
          <b>{wallet.balance.toLocaleString()}</b> <span className="muted">beats to spend</span>
        </div>
        <p className="muted small">
          Earned {wallet.earned.toLocaleString()} from what the fleet has spent, {wallet.spent.toLocaleString()} of it
          fed to something. Beats are a rebate on money already gone — spending more to raise a pet faster is a worse
          trade than not raising it.
        </p>
      </div>

      {pets.pets.length === 0 ? (
        <p className="muted">
          Nothing has been found yet. Eggs come from things <em>you</em> do — answering an escalation, settling a task,
          accepting a plan, landing a stack. The fleet cannot earn one however much it spends.
        </p>
      ) : (
        <div className="pets-grid">
          {pets.pets.map((pet) => (
            <PetCard
              key={pet.id}
              pet={pet}
              now={now}
              balance={wallet.balance}
              full={pets.pets.filter((p) => p.placed).length >= pets.slots && !pet.placed}
              slots={pets.slots}
              duplicate={(live.get(pet.species) ?? 0) > 1}
              onFeed={onFeed}
              onRename={onRename}
              onPlace={onPlace}
              onBlend={onBlend}
              onHatch={onHatch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PetCard({
  pet,
  now,
  balance,
  full,
  slots,
  duplicate,
  onFeed,
  onRename,
  onPlace,
  onBlend,
  onHatch,
}: {
  pet: PetView;
  now: number;
  balance: number;
  /** Whether the enclosure is already at capacity and this one is not in it. */
  full: boolean;
  slots: number;
  /** Whether another of this species is still alive, which is what Blend needs. */
  duplicate: boolean;
  onFeed: (id: string, beats: number) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onPlace: (id: string, placed: boolean) => Promise<unknown>;
  onBlend: (id: string) => Promise<unknown>;
  onHatch: (id: string) => void;
}) {
  const [name, setName] = useState(pet.name ?? '');
  const egg = pet.openedAt === null;
  // What it would take to finish the current stage, and never more than there is.
  // Offering a button that always refuses is worse than not offering it.
  const toNext = pet.beatsToNextStage === null ? 0 : Math.min(pet.beatsToNextStage, balance);
  const dissolved = pet.dissolvedAt !== null;
  // A pet that does not verify keeps its card and its origin line — nothing here
  // deletes anything — and loses the three controls that would spend beats on it
  // or turn it back into beats. The server refuses all three anyway; the card
  // says so first, because a button that always refuses is worse than no button.
  const flawed = pet.flaw !== null;
  return (
    <div className={`pet-card${dissolved ? ' is-dissolved' : ''}${flawed ? ' is-flawed' : ''}`}>
      <div className="pet-frame">
        <PetSprite pet={pet} size={84} beatMs={2400} />
      </div>
      <div className="pet-name">
        {/* Through `petLabel`, never `pet.display` — the species' own name is the
            answer to a question the sprite below is still asking, and printing it
            in the box above would hand it over at the shell *and* at the
            hatchling. It comes back when the juvenile says it itself. */}
        <input
          value={name}
          placeholder={petLabel(pet)}
          aria-label="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() !== (pet.name ?? '')) void onRename(pet.id, name.trim());
          }}
        />
        <span className={`pet-rarity is-${pet.rarity}`}>{pet.rarity}</span>
      </div>
      <p className="pet-origin">
        {originLine(pet)}
        <br />
        <span className="muted">{relTime(pet.hatchedAt, now)}</span>
      </p>
      {dissolved ? (
        <p className="pet-blended muted small">
          Blended {relTime(pet.dissolvedAt ?? pet.hatchedAt, now)} — its record stays.
        </p>
      ) : null}
      {pet.flaw === null ? null : (
        <p className="pet-flaw small">
          <b>Does not check out</b> — {pet.flaw.note}. It stays on the shelf: nothing here is ever deleted, but it
          cannot be fed, put out or blended.
        </p>
      )}
      {/* Only `modified` says anything. `official` is the ordinary case and needs no
          badge, and `unknown` — every pet from before the stamp, and every install
          that is not a git checkout — is a shrug rather than a suspicion, so drawing
          it would turn an honest collection into a wall of warnings. */}
      {pet.provenance === 'modified' && pet.flaw === null ? (
        <p className="pet-origin">Found by a build with uncommitted changes.</p>
      ) : null}
      {egg ? null : (
        <>
          <div className="pet-meter" title={`${pet.fed.toLocaleString()} beats fed`}>
            <i style={{ width: `${stageFill(pet)}%` }} />
          </div>
          <div className="pet-stage">
            <span>{pet.stage}</span>
            <span className="muted">
              {pet.beatsToNextStage === null ? 'fully grown' : `${pet.beatsToNextStage.toLocaleString()} to go`}
            </span>
          </div>
        </>
      )}
      <div className="pet-acts">
        {/* An egg has one act and the server agrees: it cannot be fed, and it
            cannot be blended, because neither is a decision anybody can make about
            an animal they have not been shown. It can still be put out — a shell
            in the corner of the rail is the whole point of one. */}
        {egg ? (
          <>
            <button type="button" className="ghost small" onClick={() => onHatch(pet.id)}>
              Open it
            </button>
            <AsyncButton
              className="ghost small"
              disabled={full}
              title={full ? `The vivarium holds ${slots} — take one out first` : undefined}
              onClick={() => onPlace(pet.id, !pet.placed)}
            >
              {pet.placed ? 'Take out' : 'Put out'}
            </AsyncButton>
          </>
        ) : dissolved || flawed ? null : (
          <>
            <AsyncButton className="ghost small" disabled={balance < 100} onClick={() => onFeed(pet.id, 100)}>
              Feed 100
            </AsyncButton>
            <AsyncButton className="ghost small" disabled={toNext <= 0} onClick={() => onFeed(pet.id, toNext)}>
              {pet.beatsToNextStage === null ? 'Grown' : `Feed ${toNext.toLocaleString()}`}
            </AsyncButton>
            <AsyncButton
              className="ghost small"
              disabled={full}
              title={full ? `The vivarium holds ${slots} — take one out first` : undefined}
              onClick={() => onPlace(pet.id, !pet.placed)}
            >
              {pet.placed ? 'Take out' : 'Put out'}
            </AsyncButton>
            <AsyncButton
              className="ghost small"
              disabled={!duplicate}
              title={
                duplicate
                  ? undefined
                  : speciesKnown(pet)
                    ? `This is your only ${pet.display} — blending is for duplicates`
                    : 'This is the only one of these you have — blending is for duplicates'
              }
              onClick={() => onBlend(pet.id)}
            >
              Blend
            </AsyncButton>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What the operator was doing when it hatched, in their words rather than the
 * table's. The raw ref rides along because it is the thing they would search for.
 */
function originLine(pet: PetView): string {
  // *Found*, not *hatched*: the drop and the reveal are two moments now, and this
  // line dates the first one. It is the moment worth recording — the night you
  // answered the thing — and the shell may have come off weeks later.
  const what: Record<PetView['originKind'], string> = {
    escalation: 'Found when you answered',
    'human-task': 'Found when you settled',
    plan: 'Found when you accepted',
    landing: 'Found when you landed',
    job: 'Found when you launched',
    finding: 'Found when you triaged',
    upgrade: 'Found when the harness updated itself,',
  };
  return `${what[pet.originKind]} ${pet.originRef}`;
}

/**
 * How far along it is towards its next stage, as a share of what that stage will
 * have cost in total.
 *
 * Computed from `fed` and `beatsToNextStage` — the two numbers the server ships —
 * rather than from a copy of the thresholds. Keeping the thresholds themselves
 * out of the cockpit is what stops a card reading JUVENILE above an adult sprite.
 */
function stageFill(pet: PetView): number {
  if (pet.beatsToNextStage === null) return 100;
  const target = pet.fed + pet.beatsToNextStage;
  if (target <= 0) return 2;
  return Math.max(2, Math.min(100, Math.round((pet.fed / target) * 100)));
}
