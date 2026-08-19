import { useState } from 'react';
import type { PetState, PetView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
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
}: {
  pets: PetState;
  now: number;
  onFeed: (id: string, beats: number) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onPlace: (id: string, placed: boolean) => Promise<unknown>;
}) {
  const { wallet } = pets;
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
          Nothing has hatched yet. Creatures come from things <em>you</em> do — answering an escalation, settling a
          task, accepting a plan, landing a stack. The fleet cannot earn one however much it spends.
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
              onFeed={onFeed}
              onRename={onRename}
              onPlace={onPlace}
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
  onFeed,
  onRename,
  onPlace,
}: {
  pet: PetView;
  now: number;
  balance: number;
  /** Whether the enclosure is already at capacity and this one is not in it. */
  full: boolean;
  slots: number;
  onFeed: (id: string, beats: number) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onPlace: (id: string, placed: boolean) => Promise<unknown>;
}) {
  const [name, setName] = useState(pet.name ?? '');
  // What it would take to finish the current stage, and never more than there is.
  // Offering a button that always refuses is worse than not offering it.
  const toNext = pet.beatsToNextStage === null ? 0 : Math.min(pet.beatsToNextStage, balance);
  return (
    <div className="pet-card">
      <div className="pet-frame">
        <PetSprite pet={pet} size={84} beatMs={2400} />
      </div>
      <div className="pet-name">
        <input
          value={name}
          placeholder={pet.display}
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
      <div className="pet-meter" title={`${pet.fed.toLocaleString()} beats fed`}>
        <i style={{ width: `${stageFill(pet)}%` }} />
      </div>
      <div className="pet-stage">
        <span>{pet.stage}</span>
        <span className="muted">
          {pet.beatsToNextStage === null ? 'fully grown' : `${pet.beatsToNextStage.toLocaleString()} to go`}
        </span>
      </div>
      <div className="pet-acts">
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
      </div>
    </div>
  );
}

/**
 * What the operator was doing when it hatched, in their words rather than the
 * table's. The raw ref rides along because it is the thing they would search for.
 */
function originLine(pet: PetView): string {
  const what: Record<PetView['originKind'], string> = {
    escalation: 'Hatched when you answered',
    'human-task': 'Hatched when you settled',
    plan: 'Hatched when you accepted',
    landing: 'Hatched when you landed',
    job: 'Hatched when you launched',
    finding: 'Hatched when you triaged',
    upgrade: 'Hatched when the harness updated itself,',
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
