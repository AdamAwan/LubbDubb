import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewAttention, ReviewMark, ReviewPackSharing, ScratchEntryView } from '../types.js';
import { api, type ReviewPackReading } from '../api.js';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';
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
 * would pay for the feature in bandwidth. The reviewer's three marks ride their own
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
  // The last refused share, in the route's own words — the secret backstop's
  // reason names the line it stopped on, which is the whole of what the person
  // can act on. Held here rather than in the page, which is pure.
  const [shareRefusal, setShareRefusal] = useState<string | null>(null);
  // The last refused ask, in the same terms and for the same reason: the desk
  // refuses one for four reasons a reader can act on, and none of them is written
  // to the error log — a refusal is not a failure.
  const [askRefusal, setAskRefusal] = useState<string | null>(null);
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
  // A share asked for and not yet published is the third thing that changes
  // underneath the page on a clock of the harness's rather than the reader's: the
  // pool publishes on its own pulse, so the state arrives through the same read.
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
      // Re-read either way: a refused ask usually names state that moved under the
      // page — an author already on the pull request, a checker on its pack — and
      // the read is what draws it.
      await load();
    }
  }, [prNumber, load]);

  const share = useCallback(async () => {
    setShareRefusal(null);
    await api.shareReviewPack(prNumber);
    await load();
  }, [prNumber, load]);

  // The inverse, and it re-reads for the same reason: the row goes to "waiting to
  // leave" at once and the copy is gone on the pool's next pulse, which arrives
  // through the same read on the same short clock.
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
    <Modal
      face="modal"
      className="rp-modal"
      title="Review pack"
      chips={
        <span className="cn-refs">
          <Ref to={`pr:${prNumber}`} />
        </span>
      }
      onClose={onClose}
    >
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
    </Modal>
  );
}

/** A share or a withdrawal the pool's next pulse has still to carry out — what the short clock above is for. */
function pendingShare(sharing: ReviewPackSharing): boolean {
  const share = sharing.share;
  if (share === null) return false;
  // Two waits, both on the pool's own clock: a share the next pulse will publish,
  // and a withdrawal the next pulse will take back out.
  return share.withdrawnAt !== null || (share.publishedAt === null && share.refusal === null);
}

/** No pack yet: on its way, or never asked for — two different sentences, and only the second offers the ask. */
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
  /** Why the last ask was refused, in the route's own words. */
  refused: string | null;
  onRefused: (message: string) => void;
}) {
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
      <AsyncButton tone="primary" size="small" onClick={onAsk} onRefused={onRefused} pendingLabel="asking…">
        Ask for a review pack
      </AsyncButton>
      {refused !== null && <p className="rp-refusal">{refused}</p>}
    </div>
  );
}
