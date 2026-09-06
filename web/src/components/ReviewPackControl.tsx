import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, type ReviewPackReading } from '../api.js';
import { packCurrency, packStanding } from '../view/reviewPack.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

const AGENT_POLL_MS = 4000;

export function ReviewPackControl({
  prNumber,
  headSha,
  canAsk,
  onOpen,
}: {
  prNumber: number;
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
      await load();
    }
  }, [prNumber, load]);

  if (reading === 'loading') return <span className="rp-ctl rp-ctl-quiet">pack…</span>;
  if (reading === 'failed') return null;

  if (reading.kind === 'none') {
    if (reading.writing) {
      return (
        <span className="rp-ctl">
          <Tag tone="blue">pack · writing</Tag>
        </span>
      );
    }
    if (!canAsk) return null;
    return (
      <span className="rp-ctl">
        <AsyncButton ghost size="small" onClick={ask} onRefused={setRefusal} pendingLabel="asking…">
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
      <Tag tone="blue">pack · checking</Tag>
    ) : standing === 'unchecked' ? (
      <Tag tone="amber" title="the checker never finished; asking again re-runs both agents">
        pack · unchecked
      </Tag>
    ) : currency.kind === 'gone' ? (
      <Tag title="the pull request is no longer in the world, so staleness cannot be decided">
        pack · pull request gone
      </Tag>
    ) : currency.kind === 'stale' ? (
      <Tag tone="amber" title={`written against ${reading.payload.pack.headSha}`}>
        pack · stale · {currency.commitsBehind === null ? 'unknown behind' : `${currency.commitsBehind} behind`}
      </Tag>
    ) : (
      <Tag tone="green">pack · checked</Tag>
    );
  return (
    <span className="rp-ctl">
      {state}
      <Button ghost size="small" onClick={onOpen}>
        Open pack
      </Button>
    </span>
  );
}
