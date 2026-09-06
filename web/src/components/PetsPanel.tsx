import { useState } from 'react';
import type { PetState, PetView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { petLabel, speciesKnown } from '../pets/reveal.js';
import { PetSprite } from './PetSprite.js';
import { relTime } from './util.js';
import { Panel } from './panel.js';

// → docs/spec/17-cockpit.md

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
  onHatch: (id: string) => void;
}) {
  const { wallet } = pets;
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
  full: boolean;
  slots: number;
  duplicate: boolean;
  onFeed: (id: string, beats: number) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onPlace: (id: string, placed: boolean) => Promise<unknown>;
  onBlend: (id: string) => Promise<unknown>;
  onHatch: (id: string) => void;
}) {
  const [name, setName] = useState(pet.name ?? '');
  const egg = pet.openedAt === null;
  const toNext = pet.beatsToNextStage === null ? 0 : Math.min(pet.beatsToNextStage, balance);
  const dissolved = pet.dissolvedAt !== null;
  const flawed = pet.flaw !== null;
  return (
    <Panel density="padded" className={`pet-card${dissolved ? ' is-dissolved' : ''}${flawed ? ' is-flawed' : ''}`}>
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
        {/* The sentence carries the label, so it is the thing that can run long —
            clamped in CSS with the whole of it on hover, rather than shortened
            here, since only the layout knows how wide this card came out. */}
        <span className="pet-origin-said" title={originLine(pet)}>
          {originLine(pet)}
        </span>
        <br />
        <span className="muted">
          {relTime(pet.hatchedAt, now)}
          {/* The ref is already the whole sentence when there is no label, and
              printing it twice would say nothing. Where there is one it stays
              here, in mono, because it is what an operator quotes back at a
              database. */}
          {pet.originLabel === null ? null : (
            <>
              {' · '}
              <code className="pet-origin-ref">{pet.originRef}</code>
            </>
          )}
        </span>
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
              ghost
              size="small"
              disabled={full}
              title={full ? `The vivarium holds ${slots} — take one out first` : undefined}
              onClick={() => onPlace(pet.id, !pet.placed)}
            >
              {pet.placed ? 'Take out' : 'Put out'}
            </AsyncButton>
          </>
        ) : dissolved || flawed ? null : (
          <>
            <AsyncButton ghost size="small" disabled={balance < 100} onClick={() => onFeed(pet.id, 100)}>
              Feed 100
            </AsyncButton>
            <AsyncButton ghost size="small" disabled={toNext <= 0} onClick={() => onFeed(pet.id, toNext)}>
              {pet.beatsToNextStage === null ? 'Grown' : `Feed ${toNext.toLocaleString()}`}
            </AsyncButton>
            <AsyncButton
              ghost
              size="small"
              disabled={full}
              title={full ? `The vivarium holds ${slots} — take one out first` : undefined}
              onClick={() => onPlace(pet.id, !pet.placed)}
            >
              {pet.placed ? 'Take out' : 'Put out'}
            </AsyncButton>
            <AsyncButton
              ghost
              size="small"
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
    </Panel>
  );
}

function originLine(pet: PetView): string {
  if (pet.originLabel === null) {
    const bare: Record<PetView['originKind'], string> = {
      escalation: 'Found when you answered',
      'human-task': 'Found when you settled',
      plan: 'Found when you accepted',
      landing: 'Found when you landed',
      job: 'Found when you launched',
      claim: 'Found when you ruled on',
      finding: 'Found when you triaged',
      upgrade: 'Found when the harness updated itself,',
    };
    return `${bare[pet.originKind]} ${pet.originRef}`;
  }
  const said: Record<PetView['originKind'], (label: string) => string> = {
    escalation: (label) => `Found when you answered “${label}”`,
    'human-task': (label) => `Found when you settled “${label}”`,
    plan: (label) => `Found when you accepted the plan “${label}”`,
    landing: (label) => `Found when you landed the stack for ${label}`,
    job: (label) => `Found when you launched “${label}”`,
    claim: (label) => `Found when you ruled on “${label}”`,
    finding: (label) => `Found when you triaged “${label}”`,
    upgrade: (label) => `Found when the harness updated itself to ${label}`,
  };
  return said[pet.originKind](pet.originLabel);
}

function stageFill(pet: PetView): number {
  if (pet.beatsToNextStage === null) return 100;
  const target = pet.fed + pet.beatsToNextStage;
  if (target <= 0) return 2;
  return Math.max(2, Math.min(100, Math.round((pet.fed / target) * 100)));
}
