import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, type ReviewPackReading } from '../api.js';
import { packCurrency, packStanding } from '../view/reviewPack.js';
import { AsyncButton } from './AsyncButton.js';

/** The row re-reads on this clock while an author or a checker is on the pull request. */
const AGENT_POLL_MS = 4000;

/**
 * The control on a pull request's row that asks for a review pack and opens the
 * one it has — and the states between: not asked, being written, written and
 * being checked, checked, stale by so many commits (or an unknown number), and
 * a pull request the world no longer carries, which is never folded into
 * "current". → docs/spec/31-review-packs.md#when-a-pack-is-made
 *
 * A shared component rather than console markup because it has an async flow
 * of its own: the pack is not on the snapshot, so the row reads
 * `GET /api/prs/:number/review-pack` itself on mount, again when the head moves,
 * and on a short clock while an agent is on the pull request. The ask goes
 * straight to the route; opening the page goes through the seam (`onOpen`),
 * because which pack is open is `Place` state.
 *
 * `canAsk` is false on a closed pull request: the desk refuses to write a pack
 * for one, but the pack it already has stays readable.
 *
 * **A refused ask is drawn beside the button.** The desk refuses one for four
 * reasons a reader can act on and records none of them — a refusal is not a
 * failure — so a 409 the row kept to itself was a button that did nothing.
 * → docs/spec/31-review-packs.md#when-a-pack-is-made
 */
export function ReviewPackControl({
  prNumber,
  headSha,
  canAsk,
  onOpen,
}: {
  prNumber: number;
  /** The pull request's head as the snapshot has it; a change re-reads, since staleness is decided against it. */
  headSha: string | null;
  canAsk: boolean;
  onOpen: () => void;
}): JSX.Element | null {
  const [reading, setReading] = useState<ReviewPackReading | 'loading' | 'failed'>('loading');
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReading(await api.getReviewPack(prNumber));
    } catch {
      setReading('failed');
    }
  }, [prNumber]);

  useEffect(() => {
    void load();
  }, [load, headSha]);

  const busy =
    reading !== 'loading' &&
    reading !== 'failed' &&
    (reading.kind === 'none' ? reading.writing : reading.payload.checking);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), AGENT_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const ask = useCallback(async () => {
    setRefusal(null);
    try {
      await api.requestReviewPack(prNumber);
    } finally {
      // Re-read either way. A refusal is usually about state that moved under the
      // row — an author already on the pull request, a checker on its pack — and
      // the re-read is what turns the button into the chip that says so.
      await load();
    }
  }, [prNumber, load]);

  if (reading === 'loading') return <span className="rp-ctl rp-ctl-quiet">pack…</span>;
  // Drawn as nothing rather than as "not asked": a failed read says nothing about
  // whether a pack exists, and a control offering to ask for one it cannot see
  // would spend two agent runs on a guess.
  if (reading === 'failed') return null;

  if (reading.kind === 'none') {
    if (reading.writing) {
      return (
        <span className="rp-ctl">
          <span className="chip small info">pack · writing</span>
        </span>
      );
    }
    if (!canAsk) return null;
    return (
      <span className="rp-ctl">
        <AsyncButton className="ghost small" onClick={ask} onRefused={setRefusal} pendingLabel="asking…">
          Review pack
        </AsyncButton>
        {refusal !== null && <span className="rp-ctl-refusal">{refusal}</span>}
      </span>
    );
  }

  const standing = packStanding(reading.payload);
  const currency = packCurrency(reading.payload);
  const state =
    standing === 'checking' ? (
      <span className="chip small info">pack · checking</span>
    ) : standing === 'unchecked' ? (
      <span className="chip small warn" title="the checker never finished; asking again re-runs both agents">
        pack · unchecked
      </span>
    ) : currency.kind === 'gone' ? (
      <span className="chip small" title="the pull request is no longer in the world, so staleness cannot be decided">
        pack · pull request gone
      </span>
    ) : currency.kind === 'stale' ? (
      <span className="chip small warn" title={`written against ${reading.payload.pack.headSha}`}>
        pack · stale · {currency.commitsBehind === null ? 'unknown behind' : `${currency.commitsBehind} behind`}
      </span>
    ) : (
      <span className="chip small ok">pack · checked</span>
    );
  return (
    <span className="rp-ctl">
      {state}
      <button type="button" className="btn ghost small" onClick={onOpen}>
        Open pack
      </button>
    </span>
  );
}
