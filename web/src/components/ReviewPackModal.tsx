import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewAttention, ReviewMark, ScratchEntryView } from '../types.js';
import { api, type ReviewPackReading } from '../api.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { ReviewPackPage } from './ReviewPackPage.js';

/**
 * How often the modal re-reads while an agent is on the pull request. The pack
 * and the check both arrive through the read, and the `dirty` the hub emits for
 * either is a snapshot signal the modal is not on — so while an author or a
 * checker is running, it asks again on a short clock and stops the moment
 * neither is.
 */
const AGENT_POLL_MS = 4000;

/**
 * A pull request's review pack, over the goal page — the one rendering that
 * takes input. Fetched on open (`GET /api/prs/:number/review-pack`), never off
 * the snapshot: a pack carries its code, and one per pull request on every poll
 * would pay for the feature in bandwidth. The reviewer's two marks ride their own
 * routes and the marks the write returns replace what the page holds, so the
 * page re-lays them from one shape rather than patching a copy.
 *
 * **Shell-owned**, opened through `viewReviewPack(prNumber | null)` and its idea
 * through `openReviewIdea` — both `Place` fields, so the back button steps out
 * of an idea and a link lands on one. The page itself is `ReviewPackPage`, pure,
 * so the order of things on it can be asserted.
 *
 * Four states rather than three, because the read's 404 is an answer: loading,
 * no pack (not asked for, or being written), the pack, and an error — a fetch
 * that failed must not read as "nobody asked".
 * → docs/spec/31-review-packs.md#reading-it
 */
export function ReviewPackModal({
  prNumber,
  /** The goal page this is over, whose pad the author was handed beside the pull request's own. */
  goalRef,
  openIdea,
  refUrls,
  onOpenIdea,
  onClose,
}: {
  prNumber: number;
  goalRef: string | null;
  openIdea: string | null;
  refUrls: Record<string, string>;
  onOpenIdea: (id: string | null) => void;
  onClose: () => void;
}) {
  const [reading, setReading] = useState<ReviewPackReading | 'loading' | 'failed'>('loading');
  const [marks, setMarks] = useState<ReviewMark[] | null>(null);
  const [entries, setEntries] = useState<ReadonlyMap<string, ScratchEntryView> | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await api.getReviewPack(prNumber);
      if (!live.current) return;
      setReading(next);
      // A fresh read carries the marks as the store holds them; a write's answer
      // replaces them in between. Either way one shape, never a merge.
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

  // The pads the claims cite: the pull request's own, and the goal's where the
  // page is over one. Read once per open, in parallel with the pack, and drawn
  // verbatim beside each `witnessed` or `disputed` claim. A pad that will not
  // load leaves the map without its entries, and the claim says so.
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

  // While an author or a checker is on the pull request the read is what will
  // change, so it is asked again on a clock and left alone otherwise.
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
    await api.requestReviewPack(prNumber);
    await load();
  }, [prNumber, load]);

  const onRead = useCallback(
    async (ideaId: string, read: boolean) => {
      const next = await api.markReviewIdeaRead(prNumber, ideaId, read);
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
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal rp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          <span className="pm-title">Review pack</span>
          <span className="cn-refs">
            <Ref to={`pr:${prNumber}`} />
          </span>
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>
        {reading === 'loading' && <p className="empty">Loading the pack…</p>}
        {reading === 'failed' && <p className="empty">Could not load the pack. The harness may be unreachable.</p>}
        {reading !== 'loading' && reading !== 'failed' && reading.kind === 'none' && (
          <NoPack prNumber={prNumber} writing={reading.writing} onAsk={ask} />
        )}
        {reading !== 'loading' && reading !== 'failed' && reading.kind === 'pack' && (
          <ReviewPackPage
            payload={reading.payload}
            marks={marks ?? reading.payload.marks}
            entries={entries}
            openIdea={openIdea}
            onOpenIdea={onOpenIdea}
            onRead={onRead}
            onAttention={onAttention}
            onAsk={ask}
            refUrls={refUrls}
          />
        )}
      </div>
    </div>
  );
}

/** No pack yet: on its way, or never asked for — two different sentences, and only the second offers the ask. */
function NoPack({ prNumber, writing, onAsk }: { prNumber: number; writing: boolean; onAsk: () => Promise<void> }) {
  if (writing) {
    return (
      <div className="rp rp-none">
        <span className="chip small info">being written</span>
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
      <AsyncButton className="primary small" onClick={onAsk} pendingLabel="asking…">
        Ask for a review pack
      </AsyncButton>
    </div>
  );
}
