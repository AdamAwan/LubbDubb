import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { DesktopLink } from './DesktopLink.js';
import { buttonClass } from './button.js';
import { heldTitle } from './CaveatChecklist.js';
import { HeadRow } from './panel.js';
import type { PlanCaveat } from '../types.js';

// → docs/spec/17-cockpit.md

export function PlanAnswers({
  proposalId,
  issueNumber,
  approveLabel,
  outstanding,
  acknowledged,
  seedNote,
  desktopFolder,
  discussExplain,
  onReadPlan,
  onDecide,
  onBackOut,
}: {
  proposalId: string;
  issueNumber: number | null;
  approveLabel: string;
  outstanding: PlanCaveat[];
  acknowledged: string[];
  seedNote?: string;
  desktopFolder: string;
  discussExplain: string;
  onReadPlan?: () => void;
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
        {/* The way into the plan, drawn as a peer of the answers rather than as a
            banner above them: it is one of the things you can do here, and a card
            that asks for a verdict should put reading the plan on the same row as
            giving one. */}
        {onReadPlan && (
          <button
            type="button"
            className={buttonClass({ ghost: true })}
            title="The split, the evidence, what it rules out"
            onClick={onReadPlan}
          >
            Read the full plan →
          </button>
        )}
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
