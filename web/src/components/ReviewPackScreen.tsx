import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewAttention, ReviewMark, ReviewPackSharing, ScratchEntryView } from '../types.js';
import { api, type ReviewPackReading } from '../api.js';
import { AsyncButton } from './AsyncButton.js';
import { ReviewPackPage } from './ReviewPackPage.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md#the-review-pack

const AGENT_POLL_MS = 4000;

export function ReviewPackScreen({
  prNumber,
  goalRef,
  openIdea,
  refUrls,
  onOpenIdea,
}: {
  prNumber: number;
  goalRef: string | null;
  openIdea: string | null;
  refUrls: Record<string, string>;
  onOpenIdea: (id: string | null) => void;
}) {
  const [reading, setReading] = useState<ReviewPackReading | 'loading' | 'failed'>('loading');
  const [marks, setMarks] = useState<ReviewMark[] | null>(null);
  const [entries, setEntries] = useState<ReadonlyMap<string, ScratchEntryView> | null>(null);
  const [shareRefusal, setShareRefusal] = useState<string | null>(null);
  const [askRefusal, setAskRefusal] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await api.getReviewPack(prNumber);
      if (!live.current) return;
      setReading(next);
      if (next.kind === 'pack') setMarks(next.payload.marks);
    } catch {
      if (live.current) setReading('failed');
    }
  }, [prNumber]);

  useEffect(() => {
    live.current = true;
    setReading('loading');
    setMarks(null);
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  useEffect(() => {
    let on = true;
    const refs = [`pr:${prNumber}`, ...(goalRef !== null ? [goalRef] : [])];
    void Promise.all(refs.map((ref) => api.getScratchpad(ref).catch(() => ({ padRef: ref, entries: [] })))).then(
      (pads) => {
        if (!on) return;
        setEntries(new Map(pads.flatMap((pad) => pad.entries).map((entry) => [entry.id, entry])));
      },
    );
    return () => {
      on = false;
    };
  }, [prNumber, goalRef]);

  const busy =
    reading !== 'loading' &&
    reading !== 'failed' &&
    (reading.kind === 'none' ? reading.writing : reading.payload.checking || pendingShare(reading.payload.sharing));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), AGENT_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const ask = useCallback(async () => {
    setAskRefusal(null);
    try {
      await api.requestReviewPack(prNumber);
    } finally {
      await load();
    }
  }, [prNumber, load]);

  const share = useCallback(async () => {
    setShareRefusal(null);
    await api.shareReviewPack(prNumber);
    await load();
  }, [prNumber, load]);

  const unshare = useCallback(async () => {
    setShareRefusal(null);
    await api.unshareReviewPack(prNumber);
    await load();
  }, [prNumber, load]);

  const onRead = useCallback(
    async (ideaId: string, read: boolean) => {
      const next = await api.markReviewIdeaRead(prNumber, ideaId, read);
      if (live.current) setMarks(next.marks);
    },
    [prNumber],
  );
  const onSeen = useCallback(
    async (ideaId: string, seen: boolean) => {
      const next = await api.markReviewFindingSeen(prNumber, ideaId, seen);
      if (live.current) setMarks(next.marks);
    },
    [prNumber],
  );
  const onAttention = useCallback(
    async (ideaId: string, attention: ReviewAttention | null) => {
      const next = await api.overrideReviewAttention(prNumber, ideaId, attention);
      if (live.current) setMarks(next.marks);
    },
    [prNumber],
  );

  return (
    <div className="rp-screen">
      {reading === 'loading' && <p className="empty">Loading the pack…</p>}
      {reading === 'failed' && <p className="empty">Could not load the pack. The harness may be unreachable.</p>}
      {reading !== 'loading' && reading !== 'failed' && reading.kind === 'none' && (
        <NoPack
          prNumber={prNumber}
          writing={reading.writing}
          onAsk={ask}
          refused={askRefusal}
          onRefused={setAskRefusal}
        />
      )}
      {reading !== 'loading' && reading !== 'failed' && reading.kind === 'pack' && (
        <ReviewPackPage
          payload={reading.payload}
          marks={marks ?? reading.payload.marks}
          entries={entries}
          openIdea={openIdea}
          onOpenIdea={onOpenIdea}
          onRead={onRead}
          onSeen={onSeen}
          onAttention={onAttention}
          onAsk={ask}
          onShare={share}
          onUnshare={unshare}
          shareRefusal={shareRefusal}
          onShareRefused={setShareRefusal}
          askRefusal={askRefusal}
          onAskRefused={setAskRefusal}
          refUrls={refUrls}
        />
      )}
    </div>
  );
}

function pendingShare(sharing: ReviewPackSharing): boolean {
  const share = sharing.share;
  if (share === null) return false;
  return share.withdrawnAt !== null || (share.publishedAt === null && share.refusal === null);
}

function NoPack({
  prNumber,
  writing,
  onAsk,
  refused,
  onRefused,
}: {
  prNumber: number;
  writing: boolean;
  onAsk: () => Promise<void>;
  refused: string | null;
  onRefused: (message: string) => void;
}) {
  if (writing) {
    return (
      <div className="rp rp-none">
        <Tag tone="blue">being written</Tag>
        <p>
          An author is reading the diff and the witness log for #{prNumber}. The pack arrives when its run ends, and the
          checker follows it; this page re-reads on its own until then.
        </p>
      </div>
    );
  }
  return (
    <div className="rp rp-none">
      <p>
        Nobody has asked for a pack on #{prNumber}. Asking spends two agent runs — an author and a checker — and the
        pack arrives here when the first has finished.
      </p>
      <AsyncButton tone="primary" size="small" onClick={onAsk} onRefused={onRefused} pendingLabel="asking…">
        Ask for a review pack
      </AsyncButton>
      {refused !== null && <p className="rp-refusal">{refused}</p>}
    </div>
  );
}
