import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { DesktopLink } from './DesktopLink.js';
import { buttonClass } from './button.js';
import { heldTitle } from './CaveatChecklist.js';
import { HeadRow } from './panel.js';
import type { PlanCaveat } from '../types.js';

/**
 * The four answers to a plan, drawn identically wherever a plan is decided.
 *
 * There were **six**, in one flat row, five of them ghost buttons whose whole
 * meaning lived in a `title` — and two of the six were the same act. `Reject` sent
 * the plan back to a planner and `Replan` asked a planner again, six inches apart,
 * with nothing on screen distinguishing them. Beside those sat `Close the ticket`
 * and `Hold`, which are not about the plan at all, and `Discuss…`, which was the
 * only answer to "I have a question" and read as one more way to say no.
 *
 * The four that are left are the four questions an operator actually arrives with:
 * yes; not like this; I have a question; not this goal at all.
 *
 * **The note is the act, so it is asked for by the act.** One box used to serve
 * five meanings — optional for a rejection and sent to the planner, *required* for
 * a close and posted publicly on the ticket, optional for a hold, ignored by
 * Replan and the discussion — captioned `Why (optional) — recorded either way`,
 * which is false of the two that matter. Each answer that needs words now opens
 * its own drawer, captioned by what it does with them, and **is held until there
 * are some**. That is not a nicety on the change arm: the operator's note is the
 * whole content of a refusal, and without it the replan is a re-run of the
 * question that produced the plan being refused (`src/plans/planApproval.ts`).
 *
 * **Approve carries no note.** It never went anywhere — `ProposalDesk.accept`
 * stores it on the proposal row, and `releasePlan` takes no note at all — so a box
 * beside it promised a tweak the release could not apply.
 *
 * → docs/spec/08-planning.md#the-four-answers, docs/spec/17-cockpit.md
 */
export function PlanAnswers({
  proposalId,
  issueNumber,
  approveLabel,
  outstanding,
  acknowledged,
  seedNote,
  desktopFolder,
  discussExplain,
  onDecide,
  onBackOut,
}: {
  proposalId: string;
  /**
   * The goal the plan hangs off. Null drops the Claude Code hand-off, because
   * `plan_amend` resolves a plan *by* that number — a control that opened a
   * session which could not find what it was sent for is worse than no control.
   */
  issueNumber: number | null;
  /** What Approve says starts — the count is the call site's, since only it knows the cut. */
  approveLabel: string;
  /** Caveats still unticked. Non-empty holds Approve, and says how many in its title. */
  outstanding: PlanCaveat[];
  /** The caveat ids ticked, sent with the accept. */
  acknowledged: string[];
  /**
   * What the change drawer opens with — the plan sheet's pinned objections, which
   * an operator marks while reading. They used to be composed into the one note
   * box and could only be sent by choosing a verdict first; here they are the
   * first draft of the sentence the planner gets.
   */
  seedNote?: string;
  desktopFolder: string;
  /** What the Claude Code session does once open — forks on whether the plan is running. */
  discussExplain: string;
  onDecide: (
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
  ) => Promise<unknown> | unknown;
  onBackOut: (id: string, verdict: 'close' | 'hold', note?: string) => Promise<unknown> | unknown;
}): JSX.Element {
  const [open, setOpen] = useState<DrawerId | null>(null);
  const [text, setText] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const held = outstanding.length > 0;

  // The drawer opens with the cursor in it, because the drawer *is* a request for
  // words: an operator who has to click twice to start typing has been asked the
  // question and handed no pen. Seeded on the change arm only — a close is about
  // the ticket, and the pins are about the plan.
  useEffect(() => {
    if (open === null) return;
    setText(open === 'change' ? (seedNote ?? '') : '');
    field.current?.focus();
  }, [open, seedNote]);

  const words = text.trim();
  const drawer = open === null ? null : DRAWERS[open];

  return (
    <>
      <HeadRow className="pa-row">
        <AsyncButton
          tone="primary"
          // Held, not hidden: the checklist says what is outstanding and the hint
          // says how many. The route refuses it either way — this is that answer,
          // a step earlier.
          disabled={held}
          title={
            held ? heldTitle(outstanding) : 'Release the plan — each part gets its own agent, branch and pull request'
          }
          onClick={() => onDecide(proposalId, 'accept', undefined, acknowledged)}
        >
          {approveLabel}
        </AsyncButton>
        <button
          type="button"
          className={buttonClass({ ghost: true }, open === 'change' ? 'pa-on' : '')}
          title="Say what should be different — the planner amends this plan with your words rather than starting over"
          onClick={() => setOpen(open === 'change' ? null : 'change')}
        >
          Change something first
        </button>
        {issueNumber !== null && (
          <DesktopLink folder={desktopFolder} prompt={discussPrompt(issueNumber)} explain={discussExplain} />
        )}
      </HeadRow>

      {/* Set apart below the answers, because neither of these is about the plan.
          A change asks a planner for a different one, which is the wrong "no" for a
          goal that should not be worked at all — and reading the plan is what tends
          to produce exactly that reading. */}
      <div className="pa-backout">
        <span className="muted small">Not the work you want?</span>
        <button
          type="button"
          className={buttonClass({ ghost: true, size: 'small' }, open === 'close' ? 'pa-on' : '')}
          title="Comment on the ticket, close it, stop watching it and abandon this plan"
          onClick={() => setOpen(open === 'close' ? null : 'close')}
        >
          Close the ticket
        </button>
        <AsyncButton
          ghost
          size="small"
          title="Stops watching the ticket and sends this plan back. Nothing is scheduled for it — watch it again and a fresh plan is written."
          onClick={() => onBackOut(proposalId, 'hold')}
        >
          Just stop watching
        </AsyncButton>
      </div>

      {drawer && (
        <div
          className={`pa-drawer ${drawer.kind}`}
          onKeyDown={(e) => {
            // Escape closes and decides nothing. The drawer is a question, and a
            // question you cannot back out of is a commitment.
            if (e.key === 'Escape') setOpen(null);
          }}
        >
          <span className="pa-drawer-q">{drawer.question}</span>
          <HeadRow className="pa-drawer-row">
            <input
              ref={field}
              className="pa-drawer-note"
              placeholder={drawer.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <AsyncButton
              // Held until there are words, for the reason the caption states. The
              // close route refuses an empty note as well; the change arm it would
              // *accept*, and that is the worse of the two — a refusal with nothing
              // in it reaches the planner as "a human said no" and re-runs the
              // question that produced this plan.
              disabled={words.length === 0}
              title={words.length === 0 ? drawer.held : drawer.ready}
              onClick={() =>
                open === 'change' ? onDecide(proposalId, 'reject', words) : onBackOut(proposalId, 'close', words)
              }
            >
              {drawer.submit}
            </AsyncButton>
            <button type="button" className={buttonClass({ ghost: true, size: 'small' })} onClick={() => setOpen(null)}>
              Cancel
            </button>
          </HeadRow>
          <span className="pa-drawer-hint">{drawer.hint}</span>
        </div>
      )}
    </>
  );
}

type DrawerId = 'change' | 'close';

/**
 * What each drawer asks, and what it does with the answer.
 *
 * A table rather than two branches in the markup: the two arms differ only in
 * their words, and the one thing that must never drift between them is that both
 * say where the words go. Written side by side, that is checkable by eye.
 */
const DRAWERS: Record<
  DrawerId,
  Record<'kind' | 'question' | 'placeholder' | 'submit' | 'held' | 'ready' | 'hint', string>
> = {
  change: {
    kind: 'pa-change',
    question: 'What should be different?',
    placeholder: 'The planner gets these words and amends the plan',
    submit: 'Send it back',
    held: 'Say what should change — this is the whole instruction the planner gets, and without it the replan asks the same question again',
    ready: 'Sends the plan back to a planner with your words',
    hint: 'Parts you keep, keep their branches and pull requests. Parts nothing has started for are retired; anything already in flight keeps running.',
  },
  close: {
    kind: 'pa-close',
    question: 'Why are you closing this ticket?',
    placeholder: 'Posted on the ticket as the closing comment',
    submit: 'Comment & close',
    held: 'Say why — your words go on the ticket as the closing comment, and a close nobody can read the reason for is what this asks for words to prevent',
    ready: 'Comments with your words, closes the ticket, stops watching it and abandons this plan',
    hint: 'The ticket closes, the watch tag comes off and this plan is abandoned — nothing is scheduled for it.',
  },
};
