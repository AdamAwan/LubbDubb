import { useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';

// → docs/spec/17-cockpit.md#the-summaries-banner

const DISMISSED_KEY = 'lubbdubb.featureSummariesAd.dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // TECHDEBT: a browser refusing storage costs the dismissal its durability, not the page.
  }
}

async function turnOn(): Promise<boolean> {
  const { revision } = await api.getConfig();
  const saved = await api.saveConfig({ set: { featureBoard: true }, baseline: revision });
  return !saved.pending.some((c) => c.path === 'featureBoard');
}

export function FeatureSummariesAd({
  actions,
  onTurnedOn,
}: {
  actions: CockpitActions;
  onTurnedOn: () => void;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [waitingOnRestart, setWaitingOnRestart] = useState(false);
  if (dismissed) return null;
  return (
    <aside className="cn-fb-ad" aria-label="Turn on feature summaries">
      <div className="cn-fb-ad-main">
        <p className="cn-fb-ad-title">Get a written account of every Feature</p>
        <p className="cn-fb-ad-lede">
          This board is drawn from what your tracker and the fleet already record. Turn on feature summaries and an
          agent reads each Feature and writes down where it is, in plain words.
        </p>
        <ul className="cn-fb-ad-gains">
          <li>
            <b>How far along</b> — one line on every card, answering “how is it going” before you open it
          </li>
          <li>
            <b>Usable now, needs a person, left to do</b> — the three things someone asks next, side by side
          </li>
          <li>
            <b>A board you can scan</b> — the one-line view shows each Feature’s headline, so thirty read at a glance
          </li>
          <li>
            <b>Kept current</b> — rewritten when work under the Feature moves, and marked when it is out of date
          </li>
        </ul>
        <p className="cn-fb-ad-how">
          It spends one desk agent per Feature when its work moves — and one for each Feature straight away, since none
          has an account yet. Turning it on sets <code>featureBoard</code> in your config file.
        </p>
        {waitingOnRestart && <p className="cn-fb-ad-how">Saved. This harness applies it on its next restart.</p>}
        {refusal !== null && <p className="cn-fb-ad-refusal">{refusal}</p>}
      </div>
      <div className="cn-fb-ad-acts">
        <AsyncButton
          tone="primary"
          size="small"
          pendingLabel="Turning on…"
          disabled={waitingOnRestart}
          onRefused={setRefusal}
          onClick={async () => {
            setRefusal(null);
            const applied = await turnOn();
            if (!applied) {
              setWaitingOnRestart(true);
              return;
            }
            await actions.refresh();
            onTurnedOn();
          }}
        >
          Turn on
        </AsyncButton>
        <Button
          ghost
          size="small"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
        >
          Not now
        </Button>
      </div>
    </aside>
  );
}
