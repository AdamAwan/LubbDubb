import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { CockpitView } from '../../view/viewModel.js';
import type { CockpitActions } from '../../cockpit/actions.js';
import type { NeedRow } from '../../view/needsYou.js';
import { Ref } from '../../components/refs.js';
import { buildGoalPage, goalIssue, type GoalPartView, type PartGroup } from '../../view/goalPage.js';
import { relTime } from '../../components/util.js';
import { Button, ButtonRow } from '../../components/button.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel, subjectLabel } from '../QueueRail.js';
import { needBody } from '../NeedsBand.js';
import { PICKUP_WORD } from '../Overview.js';
import { waitedFor } from '../GoalPage.js';
import { OverviewSwitch } from './OverviewSwitch.js';
import { byWeight, partsHeld } from './asks.js';
import { buildLeads, type Lead, type LeadWhere } from './leads.js';

// → docs/spec/17-cockpit.md#the-overview

/**
 * One ask at a time, under the work it is about.
 *
 * The overview draws the single ask holding the most work; answering it advances
 * to the next. What makes that more than a queue with the queue hidden is the
 * column beside it: an ask read alone is a decision with no stakes attached —
 * "approve this merge" means very little until you can see it is the fourth of
 * five parts and which of them are waiting on it. So the goal, its plan and its
 * other asks sit alongside, off the goal page's own `parts` fold, with the part
 * the ask is about marked in the ask's own tone.
 *
 * The cursor is local state and deliberately so: it is a position in this
 * sitting, not a place. A reload starts again at the top, which is the correct
 * behaviour for a queue whose order the server decides — and the order does
 * change under the operator, so the cursor is **held by id**: an ask answered
 * two positions up would otherwise shuffle the list and move something else
 * under the cursor, which is how a surface like this hands somebody a verdict
 * they were not looking at. The id is resolved back to an index on every render,
 * and where it is gone — answered, withdrawn — the position it held is the one
 * the next ask falls into.
 */
export function NextOverview({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rows = [...view.needsYou].sort(byWeight);
  const [cursor, setCursor] = useState<{ id: string; at: number } | null>(null);
  const held = partsHeld(rows);

  const found = cursor === null ? -1 : rows.findIndex((r) => r.id === cursor.id);
  const at = Math.min(found === -1 ? (cursor?.at ?? 0) : found, Math.max(rows.length - 1, 0));
  const row = rows[at];
  const go = (to: number): void => {
    const next = rows[to];
    if (next !== undefined) setCursor({ id: next.id, at: to });
  };

  /* The arrows move the cursor, except where the operator is writing — every ask
     that takes a note or an answer puts a field on this page, and a left arrow
     inside one is a caret move, not a navigation. `closest` rather than a tag
     check, because the reply boxes are contenteditable in places and the caret is
     several elements down from the one that owns it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable]') != null) return;
      e.preventDefault();
      go(e.key === 'ArrowLeft' ? at - 1 : at + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (row === undefined) return <Clear view={view} actions={actions} />;

  const body = needBody(row, view, actions);
  const subject = subjectLabel(row);

  return (
    <div className="cn-ov-next">
      <OverviewSwitch shape="next" actions={actions} />

      <div className={`cn-ov-next-card cn-t-${KIND_TONE[row.kind]}`}>
        {/* The pips are the whole queue and each is a way into it: a bar that only
            reports a position, on a surface whose complaint about the rail was
            that it could not be acted on, would be the same mistake one size
            down. They carry the ask's tone, so the column also says what kind of
            thing is waiting where. */}
        <div className="cn-ov-next-progress">
          <span className="cn-ov-pips">
            {rows.map((r, i) => (
              <button
                key={r.id}
                type="button"
                className={`cn-ov-pip cn-t-${KIND_TONE[r.kind]} ${i === at ? 'cn-ov-pip-here' : ''}`}
                aria-label={`${i + 1} of ${rows.length} — ${KIND_LABEL[r.kind]}: ${r.title}`}
                aria-current={i === at}
                title={`${KIND_LABEL[r.kind]} — ${r.title}`}
                onClick={() => go(i)}
              />
            ))}
          </span>
          {/* The controls sit with the counter rather than under the ask, because
              the ask's own height is whatever its body happens to be — a footer
              puts Next somewhere different on every one of them, and the operator
              ends up hunting for the control they press most. Here it is the same
              place on every ask, and beside the count that says what pressing it
              does. */}
          <ButtonRow className="cn-ov-next-nav">
            <span className="cn-ov-next-count">
              {at + 1} of {rows.length}
            </span>
            <Button
              tone="secondary"
              ghost
              size="small"
              disabled={at === 0}
              onClick={() => go(at - 1)}
              title="The ask before this one (←)"
            >
              ‹ Prev
            </Button>
            <Button
              tone="secondary"
              ghost
              size="small"
              disabled={at >= rows.length - 1}
              onClick={() => go(at + 1)}
              title="The ask after this one (→)"
            >
              Next ›
            </Button>
          </ButtonRow>
        </div>

        {/* Setting beside the act rather than over it. Stacked, the plan pushed the
            ask itself under the fold on a wide screen — a surface whose whole
            argument is that the thing to do is in front of you, with the thing to
            do scrolled off. They collapse back into one column below 1100px,
            where the height is cheaper than the width. */}
        <div className="cn-ov-next-split">
          <aside className="cn-ov-next-aside">
            <Context row={row} view={view} actions={actions} />
          </aside>

          <div className="cn-ov-next-main">
            <h3 className="cn-ov-ctx-label cn-ov-ask-label">Your move</h3>
            <h2 className="cn-ov-next-title">
              <span className="cn-sym" aria-hidden="true">
                {KIND_SYMBOL[row.kind]}
              </span>
              {row.title}
            </h2>

            <div className="cn-ov-next-meta">
              <span className="cn-ov-ask-kind">{KIND_LABEL[row.kind]}</span>
              {subject !== null && <span className="cn-ov-ask-subject">{subject}</span>}
              {row.goalRef !== null && <Ref to={row.goalRef} />}
              {row.originRef !== null && row.originRef !== row.goalRef && <Ref to={row.originRef} />}
              {row.raisedAt !== '' && <span className="cn-ov-ask-age">{relTime(row.raisedAt, view.now)}</span>}
            </div>

            {row.holding > 0 && (
              <p className="cn-ov-next-cost">
                <b>{holdingLabel(row.holding)}</b> waiting on this answer.
              </p>
            )}

            {row.note !== undefined && <p className="cn-ov-ask-note">{row.note}</p>}

            <div className="cn-ov-next-body">{body}</div>

            <footer className="cn-ov-next-foot">
              <span className="cn-ov-next-rest">
                {rows.length - at - 1 === 0
                  ? 'last one'
                  : `${rows.length - at - 1} after this · ${held} ${held === 1 ? 'part' : 'parts'} held in total`}
              </span>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * What the ask is about: the goal, how far along it is, and what else on it is
 * waiting on the operator. Absent where the ask belongs to no goal — an upgrade,
 * a config gap, a supply ask — which is said rather than left blank, because a
 * band that silently vanishes reads as one that failed to load.
 *
 * Every region here wears its name. An unlabelled band under an unlabelled track
 * is a row of boxes the reader has to infer the meaning of, and the inference is
 * different for each of them — which is the whole cost this shape was meant to
 * remove.
 */
function Context({ row, view, actions }: { row: NeedRow; view: CockpitView; actions: CockpitActions }): JSX.Element {
  if (row.goalRef === null) {
    return (
      <div className="cn-ov-ctx cn-ov-ctx-wide">
        <h3 className="cn-ov-ctx-label">What this is about</h3>
        <span className="cn-ov-ctx-none">The fleet itself, rather than any one goal.</span>
      </div>
    );
  }

  const issue = goalIssue(view.state, row.goalRef);
  const page = buildGoalPage(view.state, row.goalRef, view.needsYou, null);
  const parts = page?.parts ?? [];
  const siblings = view.needsYou.filter((n) => n.goalRef === row.goalRef && n.id !== row.id).length;
  const merged = parts.filter((p) => p.group === 'merged').length;

  return (
    <div className="cn-ov-ctx">
      <h3 className="cn-ov-ctx-label">The goal this is about</h3>

      <div className="hdr hdr-base">
        <button type="button" className="cn-ov-ctx-name" onClick={() => actions.selectGoal(row.goalRef ?? '')}>
          {issue?.title ?? row.goalRef}
        </button>
        <Ref to={row.goalRef} />
        {issue !== undefined && (
          <span className="cn-ov-ctx-state">{PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status}</span>
        )}
      </div>

      {parts.length > 0 && (
        <>
          <h3 className="cn-ov-ctx-label cn-ov-ctx-label-sub">
            Its plan{' '}
            <span>
              {merged} of {parts.length} merged
            </span>
          </h3>
          <Track parts={parts} about={partOf(row)} />
        </>
      )}

      {siblings > 0 && (
        <p className="cn-ov-ctx-more">
          {siblings} other {siblings === 1 ? 'ask' : 'asks'} on this goal, after this one.
        </p>
      )}
    </div>
  );
}

/**
 * The goal's parts, each named. The count alone drew five identical boxes, which
 * says how many parts there are and nothing about what any of them is — and the
 * part the ask is about is the one the reader is looking for.
 */
function Track({ parts, about }: { parts: readonly GoalPartView[]; about: string | null }): JSX.Element {
  return (
    <ol className="cn-ov-track">
      {parts.map(({ part, group }) => {
        const here = about !== null && part.slug === about;
        return (
          <li
            key={part.id}
            className={`cn-ov-seg cn-ov-seg-${group} ${here ? 'cn-ov-seg-here' : ''}`}
            title={`${part.title} — ${GROUP_WORD[group]}`}
          >
            <b>{part.seq}</b>
            <span className="cn-ov-seg-name">{part.title}</span>
            <span className="cn-ov-seg-state">{here ? 'this ask' : GROUP_WORD[group]}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The part the ask is about, where its origin names one. Marking it is most of
 * what the band is for: the reader is looking for where this decision sits in the
 * work, and five named rows with none of them marked still leaves them counting.
 */
function partOf(row: NeedRow): string | null {
  const m = /^issue:\d+:part:(.+)$/.exec(row.originRef ?? '');
  return m?.[1] ?? null;
}

const GROUP_WORD: Record<PartGroup, string> = {
  merged: 'merged',
  now: 'being worked',
  held: 'held',
  waiting: 'not started',
};

/**
 * What the surface says when the ask queue is empty.
 *
 * An empty queue is not an empty deployment — it says only that nothing is
 * blocked on a person — and the sentence alone left the operator on the one
 * surface whose whole argument is that the thing to do is in front of them, with
 * nothing in front of them. So the work nobody is *asking* about is drawn instead:
 * the leads, each a reading that is true now and a way to the surface that owns
 * it. → {@link buildLeads}
 *
 * Where there is not even a lead, the panel says so in the same words it would
 * have used for a reading and offers the launch desk, because the answer to an
 * empty fleet is to give it something.
 */
function Clear({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const leads = buildLeads(view);
  const working = view.live.length;

  return (
    <div className="cn-ov-next">
      <OverviewSwitch shape="next" actions={actions} />
      <div className="cn-ov-next-clear">
        <h2>Nothing needs you.</h2>
        <p>
          {working} {working === 1 ? 'agent is' : 'agents are'} working
          {view.state.control.paused && ', and dispatch is paused'}. The next thing that wants an answer will land here.
        </p>

        {leads.length === 0 ? (
          <>
            <h3 className="cn-ov-ctx-label">Nothing to look at either</h3>
            <p className="cn-ov-lead-say">
              None of the readings this panel watches has anything in it — nothing queued, nothing unwatched, no goal
              sitting unattended, nothing waiting on your approval. The fleet is out of work rather than between it.
            </p>
            <ButtonRow>
              <Button tone="primary" size="small" onClick={() => actions.openPanel('launch')}>
                Write a brief
              </Button>
            </ButtonRow>
          </>
        ) : (
          <>
            <h3 className="cn-ov-ctx-label">
              Worth a look <span>{leads.length === 1 ? '1 reading' : `${leads.length} readings`}</span>
            </h3>
            <ul className="cn-ov-leads">
              {leads.map((lead) => (
                <LeadRow key={lead.key} lead={lead} now={view.now} actions={actions} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One lead: the figure, what it counts, why it is worth a look, and the way
 * there. The things it names are drawn as their own controls with their refs
 * beside them — a name with no way to it is the dead end this document keeps
 * naming, and a ref inside a button is the other half of the same rule.
 */
function LeadRow({ lead, now, actions }: { lead: Lead; now: number; actions: CockpitActions }): JSX.Element {
  return (
    <li className={`cn-ov-lead ${lead.tone === null ? '' : `cn-t-${lead.tone}`}`}>
      <div className="cn-ov-lead-head">
        <b className="cn-ov-lead-n">{lead.count}</b>
        <span className="cn-ov-lead-title">{lead.title}</span>
        <Button
          tone="secondary"
          ghost
          size="small"
          className="cn-ov-lead-go"
          onClick={() => goLead(lead.where, actions)}
        >
          {lead.go} →
        </Button>
      </div>
      <p className="cn-ov-lead-say">{lead.say}</p>
      {lead.items.length > 0 && (
        <ul className="cn-ov-lead-items">
          {lead.items.map((item) => (
            <li key={item.key}>
              <button type="button" className="cn-ov-lead-name" onClick={() => goLead(item.where, actions)}>
                {item.label}
              </button>
              <span className="cn-refs">
                <Ref to={item.ref} />
              </span>
              {/* The wait is the whole reason an unapproved pull request is a lead,
                  so it is drawn on the row rather than left to the page behind it. */}
              {item.since !== undefined && (
                <span className="cn-ov-lead-wait">waiting {waitedFor(item.since, now)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The one place a lead becomes navigation. Total over `LeadWhere`, so a lead
 * added with nowhere to go fails the typecheck here.
 */
function goLead(where: LeadWhere, actions: CockpitActions): void {
  switch (where.kind) {
    case 'upnext':
      actions.openPanel('upnext');
      return;
    case 'faults':
      actions.openPanel('faults');
      return;
    case 'reservoir':
      actions.openTab('tickets');
      actions.setTicketQuery({ ticketWatch: 'unwatched', ticketTracking: 'live', ticketState: 'any' });
      return;
    /* The readings these two are about are the Cards shape's own cards, so the
       lead hands the operator that shape rather than a copy of it here. */
    case 'cards':
      actions.setOverviewShape('cards');
      return;
    case 'goal':
      actions.selectGoal(where.ref);
      return;
    case 'pr':
      actions.selectPr(where.number);
      return;
  }
}
