import { Fragment, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type {
  ContradictionRuling,
  FactExit,
  FactRuling,
  GraduationOutcome,
  KnowledgeContradictionView,
  KnowledgeCorroboration,
  KnowledgeCost,
  KnowledgeDeliveryView,
  KnowledgeFactView,
  KnowledgeGraduationView,
} from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import { absDate, fmtTokens, fmtUsd, relTime, untilTime } from './util.js';
import { Ref } from './refs.js';
import {
  groupFor,
  inShow,
  KNOWLEDGE_GROUPS,
  nextSort,
  sortFacts,
  waitingOn,
  type KnowledgeQuery,
} from '../cockpit/knowledgeQuery.js';

/**
 * What the fleet knows about working this repository, and how far each claim
 * carries (issue #27 phase 2).
 *
 * **This page is the governance, so it draws what it stopped.** A surface showing
 * only what it let through cannot tell an operator that a claim was killed, or
 * that one is sitting at `lookup` reaching nobody — and the rejection bar, which
 * is what stops two agents re-proposing next week what was killed today, is
 * invisible everywhere else in the harness. So the rejected tail is a section
 * here, exactly as the Lessons panel keeps its retired one.
 *
 * **Nothing on this page auto-promotes anything.** The store carries a standing
 * claim to `lookup` on two corroborations from two different goals and no
 * further; `injected` — in front of every agent before it reads any code — is an
 * operator's and only an operator's. The one exception is a **notice**, which the
 * store injects on corroboration alone because its blast radius is capped by its
 * own clock (phase 4) — and that is the store's doing, not a control here. Every
 * control below is one of the four things a person can say, and none of them is
 * available to an agent.
 *
 * The order is the order things demand attention rather than the order of the
 * state machine: the notices with clocks on them, then the corroborated claims
 * waiting on the one decision that is yours, then what you have already vouched
 * for, then the long tails — **each of which an operator may fold away, and none
 * of which starts folded**: a claim hidden by default would leave no way to tell a
 * list you have finished with from one that lost rows. What each heading used to
 * say in a paragraph underneath it, it says in a tooltip now, which is where the
 * page's real cost was — nine of them between an operator and the rows they came
 * to rule on. `KNOWLEDGE_GROUPS` holds the words.
 *
 * **The filter narrows and never moves.** *Waiting on you* gathers a reading from
 * four reach states — an unanswered dispute, a cap drop, a drifted scope, a
 * graduation the harness will not guess about — because that question is one
 * question and an operator who has to visit four headings to answer it answers
 * three. What it does is show fewer rows: every claim stays under the heading its
 * reach puts it in, since lifting a disputed claim out of **Injected** would draw
 * a demotion that did not happen.
 *
 * **Every number here is a reading and never a trigger** (issue #27 phase 7). What
 * the block costs, whether a `check:` scope has stopped matching anything, and how
 * often a claim was asked for are all drawn and none of them acts: nothing is
 * demoted, lapsed or dropped from a prompt because it costs money, because its
 * check was renamed, or because nobody has wanted it lately. There is one thing
 * the page deliberately does not show, because it cannot be measured — whether an
 * injected line was *read*. Cost, corroboration, contradiction and demand are
 * measurable, and the fourth is not invented to sit beside them.
 *
 * → `docs/spec/27-knowledge.md`, `docs/spec/17-cockpit.md`
 */
export function KnowledgePanel({
  facts,
  graduations,
  delivery,
  cost,
  canFileTickets,
  now,
  refUrls,
  viewingFact,
  query,
  onQuery,
  onReach,
  onExit,
  onRaise,
  onSettleGraduation,
  onDetail,
  onResolveContradiction,
  onViewFact,
}: {
  facts: KnowledgeFactView[];
  /** Every attempt to put a claim in the repository, with the sweep's own reading of each. */
  graduations: KnowledgeGraduationView[];
  /** What the two renderers actually send, projected server-side. Never recomputed here. */
  delivery: KnowledgeDeliveryView;
  /** What sending it costs, priced server-side against the fleet's own spend. Never divided here. */
  cost: KnowledgeCost;
  now: number;
  refUrls: Record<string, string>;
  /** The claim whose provenance is open, from `Place` — never this component's own state. */
  viewingFact: string | null;
  /** How the page is drawn, narrowed and ordered — every field of it a `Place` field. */
  query: KnowledgeQuery;
  onQuery: (next: Partial<KnowledgeQuery>) => void;
  onReach: (id: string, reach: FactRuling) => Promise<unknown> | unknown;
  /** Send a claim on — a documentation pull request, a job, or a ticket. */
  onExit: (id: string, exit: FactExit) => Promise<unknown> | unknown;
  /** Write one down. The one write here that is not a ruling; it lands a proposal. */
  onRaise: (claim: string, originRef: string | null) => Promise<unknown>;
  onSettleGraduation: (id: string, outcome: GraduationOutcome) => Promise<unknown> | unknown;
  onDetail: (id: string) => Promise<{
    corroborations: KnowledgeCorroboration[];
    contradictions: KnowledgeContradictionView[];
  }>;
  onResolveContradiction: (id: string, ruling: ContradictionRuling) => Promise<unknown> | unknown;
  onViewFact: (id: string | null) => void;
  /** False when no real tracker is configured — there is nowhere to file a claim into. */
  canFileTickets: boolean;
}) {
  // Which injected claims the cap left out, as the renderer that ran reported it.
  // Never a character count taken here: a second implementation of "what fits" is
  // free to disagree with the one that shipped, and nothing is red when it does.
  const dropped = new Set(delivery.dropped);
  // The graduation a row draws, if any: the one still going, or the last one that
  // did not land. Taken here rather than in the card so the list is walked once,
  // and taken from the server's own rows — the reading on each is the sweep's.
  const graduationOf = new Map<string, KnowledgeGraduationView>();
  for (const row of [...graduations].reverse()) graduationOf.set(row.factId, row);
  // Why each claim is waiting on a person, taken once for the filter, the count on
  // its chip and the line on its row — three readings of one predicate rather than
  // three predicates, which is how a count and a list come to disagree.
  const waiting = new Map<string, string>();
  for (const fact of facts) {
    const why = waitingOn(fact, graduationOf.get(fact.id) ?? null, dropped);
    if (why !== null) waiting.set(fact.id, why);
  }
  const shown = facts.filter((fact) => inShow(query.show, fact, waiting.get(fact.id) ?? null));
  const folded = new Set(query.fold);
  const shared = {
    now,
    refUrls,
    viewingFact,
    canFileTickets,
    onReach,
    onExit,
    onSettleGraduation,
    onDetail,
    onResolveContradiction,
    onViewFact,
    dropped,
    graduationOf,
    waiting,
  };
  return (
    <div className="kn">
      <p className="muted small kn-note">
        Everything the fleet has raised about working this repository, and how far each claim carries. Agents write them
        down through one call — <code>raise</code> — and do not choose a destination: two of them on two different goals
        carry a claim as far as <b>on lookup</b>, and nothing but a person puts a standing one in front of every agent.
        The one exception is a <b>notice</b> — an observation with a clock on it — which agreement alone injects,
        because it ends by itself. What an agent noticed outside its own task and what working a goal taught are here
        too, on the same rows: they were three stores and one question, and three places to answer it was two places to
        forget. Every heading below carries its own rule — hover one to read it.
      </p>
      <ClaimComposer onRaise={onRaise} />
      <KnowledgeBar
        query={query}
        onQuery={onQuery}
        counts={{
          all: facts.length,
          waiting: facts.filter((f) => waiting.has(f.id)).length,
          reaching: facts.filter((f) => inShow('reaching', f, null)).length,
          settled: facts.filter((f) => inShow('settled', f, null)).length,
        }}
      />
      {/* The budget is the page's, not a section's, since the page grew a filter
          and a second view: a reading about what every agent receives that
          disappears because somebody narrowed to the settled tail is a reading they
          would have to un-narrow to find. The per-row marking of what the cap left
          out stays on the cards, which is the half of it an operator acts on. */}
      <BlockBudget delivery={delivery} cost={cost} />
      {shown.length === 0 ? (
        <p className="empty">
          No claim matches this filter. Nothing was demoted by it — the store is exactly as it was.
        </p>
      ) : query.view === 'table' ? (
        <KnowledgeTable facts={shown} sort={query.sort} desc={query.desc} onQuery={onQuery} {...shared} />
      ) : (
        KNOWLEDGE_GROUPS.map((group) => {
          const inGroup = shown.filter((fact) => groupFor(fact, now) === group.id);
          // An empty heading is drawn on the whole store and never under a
          // narrowing. On `all` it is the page saying a tail is empty rather than
          // missing, which is half of drawing what it stopped; under a filter it is
          // eight headings answering a question nobody asked.
          if (inGroup.length === 0 && query.show !== 'all') return null;
          return (
            <KnowledgeSection
              key={group.id}
              group={group}
              facts={inGroup}
              open={!group.tail || !folded.has(group.id)}
              onToggle={() =>
                onQuery({
                  fold: folded.has(group.id) ? query.fold.filter((id) => id !== group.id) : [...query.fold, group.id],
                })
              }
              {...shared}
            />
          );
        })
      )}
      <Receives delivery={delivery} />
    </div>
  );
}

/**
 * What the page is showing, and how it is laid out — the two controls, and the
 * counts that make them worth clicking.
 *
 * A count on each chip rather than a bare word, because the one question this bar
 * answers before it is touched is *is there anything on me* — and a filter an
 * operator has to click to find out is one they click once.
 *
 * **Neither control moves a claim.** Narrowing shows fewer rows and re-ordering
 * shows the same rows in another order; nothing here is a ruling, and nothing here
 * is a reading the server did not already take.
 */
function KnowledgeBar({
  query,
  onQuery,
  counts,
}: {
  query: KnowledgeQuery;
  onQuery: (next: Partial<KnowledgeQuery>) => void;
  counts: Record<KnowledgeQuery['show'], number>;
}): JSX.Element {
  return (
    <div className="kn-bar">
      <div className="kn-fgroup">
        <span className="kn-flabel" title="Which claims the page is showing. It narrows and never moves one">
          Show
        </span>
        <div className="kn-seg">
          {SHOW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.value === query.show ? 'on' : ''}
              title={option.title}
              aria-pressed={option.value === query.show}
              onClick={() => onQuery({ show: option.value })}
            >
              {option.label} <span className="muted">{counts[option.value]}</span>
            </button>
          ))}
        </div>
      </div>
      <i className="kn-fdiv" />
      <div className="kn-fgroup">
        <span className="kn-flabel" title="How the claims are laid out">
          View
        </span>
        <div className="kn-seg">
          {VIEW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.value === query.view ? 'on' : ''}
              title={option.title}
              aria-pressed={option.value === query.view}
              onClick={() => onQuery({ view: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const SHOW_OPTIONS: ReadonlyArray<{ value: KnowledgeQuery['show']; label: string; title: string }> = [
  { value: 'all', label: 'All', title: 'Every claim the fleet has raised, under the heading its reach puts it in' },
  {
    value: 'waiting',
    label: 'Waiting on you',
    title:
      'The claims with something only a person can answer: corroborated and unruled, a dispute nobody has answered, a claim over the block cap, a scope that has stopped matching, a documentation pull request that left the world unseen. Each one stays under its own heading — this narrows the page and demotes nothing',
  },
  {
    value: 'reaching',
    label: 'Reaching agents',
    title: 'Injected or on lookup — what the fleet is actually being told, and what it can ask for',
  },
  {
    value: 'settled',
    label: 'Settled',
    title:
      'Gone somewhere better, superseded, retired, rejected. Drawn rather than dropped: a surface that shows only what it let through cannot show you what it stopped',
  },
];

const VIEW_OPTIONS: ReadonlyArray<{ value: KnowledgeQuery['view']; label: string; title: string }> = [
  { value: 'list', label: 'List', title: 'Grouped by where each claim stands, with the long tails folded away' },
  {
    value: 'table',
    label: 'Table',
    title:
      'One row per claim, sortable by any reading on it — which claims are most disputed, and which the fleet keeps asking for',
  },
];

/**
 * Every claim as one row, ordered by any reading on it.
 *
 * The view a store this size grows into: the list answers *what should I do now*
 * and cannot answer *what is the fleet asking for that nobody has vouched for*,
 * because that is a question about an order rather than about a group. Sorting is
 * the whole of what it adds — every column is a number the server already took,
 * and a table that recomputed one would be the second implementation this page
 * refuses everywhere else.
 *
 * **The claim cell is a button and carries no reference.** The row opens the same
 * `?fact=` place the list does, and a reference inside a control is one click with
 * two destinations — so the cell draws the claim as plain text and the card it
 * expands into draws it as markdown, references and all.
 *
 * The ask count is drawn on `lookup` rows and nowhere else, as in the list: an
 * injected claim is in front of every agent whether it wanted it or not, so a `0`
 * against one would read as nobody wanting a claim nobody could ask for.
 */
function KnowledgeTable({
  facts,
  sort,
  desc,
  onQuery,
  ...row
}: {
  facts: KnowledgeFactView[];
  sort: KnowledgeQuery['sort'];
  desc: boolean;
  onQuery: (next: Partial<KnowledgeQuery>) => void;
} & RowProps): JSX.Element {
  const ordered = sortFacts(facts, row.now, sort, desc);
  return (
    <div className="kn-tablewrap">
      <table className="kn-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              // Off the object before the closure: a property narrowed in the
              // ternary is wide again inside the handler, and `null` there is the
              // one order this table does not have.
              const sortKey = column.key;
              return (
                <th
                  key={column.label}
                  className={column.numeric === true ? 'num' : ''}
                  aria-sort={sortKey === null ? undefined : ariaSort(sortKey, sort, desc)}
                >
                  {sortKey === null ? (
                    <span title={column.title}>{column.label}</span>
                  ) : (
                    <button
                      type="button"
                      className="chip-button"
                      title={column.title}
                      onClick={() => {
                        const next = nextSort(sort, desc, sortKey);
                        onQuery({ sort: next.knowledgeSort, desc: next.knowledgeDesc });
                      }}
                    >
                      {column.label}
                      {sort === sortKey && <span aria-hidden="true"> {desc ? '↓' : '↑'}</span>}
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((fact) => {
            const group = KNOWLEDGE_GROUPS.find((g) => g.id === groupFor(fact, row.now));
            const open = row.viewingFact === fact.id;
            return (
              <Fragment key={fact.id}>
                <tr className={`kn-trow${row.waiting.has(fact.id) ? ' waiting' : ''}${open ? ' open' : ''}`}>
                  <td>
                    <button
                      type="button"
                      className="chip-button kn-tclaim"
                      title={open ? 'Close this claim' : fact.claim}
                      onClick={() => row.onViewFact(open ? null : fact.id)}
                    >
                      {/* Backticks stripped rather than rendered: a table cell is one
                          line, and the card below draws the same claim as markdown. */}
                      {fact.claim.replace(/`/g, '')}
                    </button>
                  </td>
                  <td>
                    <span className="chip small" title={group?.blurb}>
                      {group?.title}
                    </span>
                  </td>
                  <td>
                    <FactScope scope={fact.scope} />
                  </td>
                  <td className="num" title={countTitle(fact.corroborations)}>
                    {fact.corroborations}
                  </td>
                  <td className="num">
                    {fact.contradictions === 0 ? <span className="muted">—</span> : fact.contradictions}
                  </td>
                  <td className="num">
                    {fact.reach === 'lookup' ? (
                      fact.asks
                    ) : (
                      <span
                        className="muted"
                        title="An injected claim is in front of every agent whether it wanted it or not, so there is no demand to count — and a zero here would read as nobody wanting it"
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="num" title={absDate(fact.createdAt)}>
                    {relTime(fact.createdAt, row.now)}
                  </td>
                  <td>{fact.originRef !== null && <Ref to={fact.originRef} />}</td>
                </tr>
                {open && (
                  <tr className="kn-tdetail">
                    <td colSpan={COLUMNS.length}>
                      <FactCard fact={fact} {...row} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What a screen reader is told about the column the table is ordered by. */
function ariaSort(
  key: KnowledgeQuery['sort'],
  sort: KnowledgeQuery['sort'],
  desc: boolean,
): 'ascending' | 'descending' | 'none' {
  if (key !== sort) return 'none';
  return desc ? 'descending' : 'ascending';
}

const COLUMNS: ReadonlyArray<{
  /** Null where the column is not an order: a reference is not a reading. */
  key: KnowledgeQuery['sort'] | null;
  label: string;
  title: string;
  numeric?: boolean;
}> = [
  { key: 'claim', label: 'Claim', title: 'What the fleet says, alphabetically' },
  { key: 'reach', label: 'Reach', title: 'How far it carries — the order the headings are in' },
  { key: 'scope', label: 'Scope', title: 'Who it applies to' },
  { key: 'observers', label: 'Obs', title: 'Independent corroborators, counted server-side', numeric: true },
  {
    key: 'disputes',
    label: 'Disputes',
    title: 'Independent voices against it, over the whole life of the claim',
    numeric: true,
  },
  {
    key: 'asks',
    label: 'Asks',
    title:
      'How often an agent asked for it and was answered — the reading that finds a lookup claim worth vouching for',
    numeric: true,
  },
  { key: 'age', label: 'Age', title: 'When it was first seen', numeric: true },
  { key: null, label: 'Origin', title: 'The goal it was first seen on' },
];

/**
 * The block against its budget.
 *
 * Both numbers are the renderer's: the block is the string that will ship, and
 * the drop is the list it reported dropping. What an operator does about a full
 * meter is per-row — which is why the count is here and the marking is on the
 * cards, rather than a bare "two are over" they would then have to go and find.
 */
function BlockBudget({ delivery, cost }: { delivery: KnowledgeDeliveryView; cost: KnowledgeCost }): JSX.Element {
  const used = delivery.block.length;
  const full = delivery.limit > 0 && used >= delivery.limit;
  const over = delivery.dropped.length;
  return (
    <div className="kn-budget">
      <div className="kn-meter" role="presentation">
        <div
          className={`kn-meter-fill${full ? ' full' : ''}`}
          style={{ width: `${delivery.limit > 0 ? Math.min(100, (used / delivery.limit) * 100) : 100}%` }}
        />
      </div>
      <span className="muted small">
        {used.toLocaleString()} of {delivery.limit.toLocaleString()} characters
        {over > 0 ? (
          <>
            {' '}
            ·{' '}
            <b title="Over the cap, so no agent reads them. Demote something above to make room — the agent is told the count and nothing else.">
              {over} not sent
            </b>
          </>
        ) : (
          ' · everything above is being sent'
        )}
      </span>
      <BlockCost cost={cost} />
    </div>
  );
}

/**
 * What the block costs, in the dollars the rest of the cockpit uses.
 *
 * Characters are the cap; this is the purchase. Every figure is the server's —
 * the share, the total and the per-dispatch division alike — because it is
 * arithmetic over a token estimate and a fleet total whose rule this file does not
 * know, and a division taken here would be free to disagree with the spend the
 * Insights page reports an inch away.
 *
 * **A reading and never a trigger.** Nothing above is demoted, lapsed or dropped
 * from the block because of what it costs; the only thing this can do is be read.
 *
 * A null figure is *cannot say*, not free — a deployment whose runtime reports no
 * usage still pays for this block, and a `$0.00` there would be the one number on
 * the page that is a lie.
 */
function BlockCost({ cost }: { cost: KnowledgeCost }): JSX.Element {
  if (cost.perDispatchUsd === null || cost.windowCostUsd === null) {
    return (
      <p className="muted small kn-cost">
        No dispatch in the last {cost.windowLabel} reported what it cost, so this block cannot be priced.{' '}
        {cost.unmeasured > 0
          ? `${cost.unmeasured} ${cost.unmeasured === 1 ? 'dispatch' : 'dispatches'} ran and reported no usage — unmeasured, not free.`
          : 'Nothing has been dispatched.'}
      </p>
    );
  }
  return (
    <p className="muted small kn-cost">
      <b title="The block's share of the fleet's own input over this window, applied to the fleet's own recorded spend. There is no price list here: a table of per-token prices would be a second statement about money, free to disagree with what the agents reported.">
        {fmtSmallUsd(cost.perDispatchUsd)} a dispatch
      </b>{' '}
      · {fmtUsd(cost.windowCostUsd)} over {cost.launches.toLocaleString()}{' '}
      {cost.launches === 1 ? 'dispatch' : 'dispatches'} in the last {cost.windowLabel}
      {cost.unmeasured > 0 && (
        <span title="These reported no usage at all, so they are in none of the figures. Unmeasured is never free.">
          {' '}
          ({cost.unmeasured} more reported nothing)
        </span>
      )}
      <br />
      <span
        title={`${cost.blockTokens.toLocaleString()} tokens estimated at ${cost.charsPerToken} characters each — the one figure here nothing can measure, since the harness does not tokenise. Everything else is what the fleet reported.`}
      >
        ≈{fmtTokens(cost.blockTokens)} tokens, sent on each of {cost.turns.toLocaleString()} turns
      </span>{' '}
      ·{' '}
      <span title="The block is in the system prompt so that it is a cached prefix: identical on every launch, and re-sent on every turn of a session. It is priced at the fleet's own dollars per input token, which already carries whatever the cache saved.">
        {Math.round((cost.shareOfInput ?? 0) * 1000) / 10}% of the fleet&rsquo;s input,{' '}
        {cost.inputTokens > 0 ? Math.round((cost.cachedInputTokens / cost.inputTokens) * 100) : 0}% of which was served
        from cache
      </span>
    </p>
  );
}

/**
 * Dollars that run below a cent, where `fmtUsd`'s two places print `$0.00`.
 *
 * A per-dispatch figure is usually fractions of a cent, and the whole point of the
 * reading is that it is small — rounding it to a zero would answer "what does this
 * cost" with "nothing", which is the one thing it must not say.
 */
function fmtSmallUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : fmtUsd(n);
}

/**
 * What an agent actually receives, from the same two functions that send it.
 *
 * The half of this page a store this size cannot be governed without: the reach
 * machine says where a claim *stands*, and this says what is *sent* — and they
 * come apart at the cap, silently, because the agent is told a count and never
 * which claims it is missing. The lessons section carries the idea in miniature, per
 * row; a whole store needs the text itself.
 *
 * The scoped lists are per scope rather than per dispatch: a dispatch matches its
 * goal and every check it answers at once, so an agent fixing CI on a goal with
 * claims against both receives both of these, in one pass through the renderer.
 */
function Receives({ delivery }: { delivery: KnowledgeDeliveryView }): JSX.Element {
  return (
    <section className="kn-section">
      <h3 className="kn-head">What an agent actually receives</h3>
      <p className="muted small">
        Verbatim, from the same renderers the harness launches and dispatches with — not a description of them. The
        block is in every agent&rsquo;s system prompt on its next launch; the scoped lists are appended to the task
        prompt of a dispatch that matches, and to nothing else.
      </p>
      <div className="kn-card">
        <div className="kn-head small">Every launch · system prompt</div>
        {delivery.block === '' ? (
          <p className="empty">Nothing is injected, so the launch carries no block at all.</p>
        ) : (
          <pre className="kn-sent">{delivery.block}</pre>
        )}
      </div>
      {delivery.scoped.length === 0 ? (
        <p className="empty">No claim is scoped to a check or a goal, so no dispatch carries an append.</p>
      ) : (
        delivery.scoped.map((entry) => (
          <div className="kn-card" key={entry.scope}>
            <div className="kn-head small">
              A dispatch matching <code>{entry.scope}</code> · task prompt
            </div>
            <pre className="kn-sent">{entry.text}</pre>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * Writing a claim down by hand — the operator's own arm of the store, and the one
 * write on this page that is not a ruling.
 *
 * **It lands a proposal.** The surface is one gate, not one gate and a bypass for
 * whoever happens to be at the keyboard: a claim an operator typed is a claim with
 * one voice behind it, and putting it in front of the fleet is the same second
 * click they would make on an agent's. This is `LessonComposer`, kept: what it
 * writes is a `knowledge_facts` row now rather than a `lessons` one, which is the
 * whole of the change.
 *
 * Two fields, and the second is the provenance — the goal it was learned on, which
 * is what lets a reader in six months date the claim against the repository it is
 * about. Optional, because an operator writing down what they already know has no
 * goal behind it, and a defaulted one would date the claim to work that did not
 * teach it.
 *
 * A failed post keeps the text, the one outcome worth writing code to prevent.
 */
function ClaimComposer({ onRaise }: { onRaise: (claim: string, originRef: string | null) => Promise<unknown> }) {
  const [text, setText] = useState('');
  const [goal, setGoal] = useState('');
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (text.trim().length === 0) return;
    setFailed(false);
    try {
      // Typed as `41` or `issue:41`; the harness's colon form is what every ref in
      // the cockpit is, so the bare number is normalised into one here rather than
      // stored as a second spelling nothing can link.
      const number = /^#?(\d+)$/.exec(goal.trim())?.[1];
      const ref = goal.trim() === '' ? null : number ? `issue:${number}` : goal.trim();
      await onRaise(text.trim(), ref);
      setText('');
      setGoal('');
    } catch (err) {
      setFailed(true);
      // Rethrown so the button flashes its own error ring, as everywhere else:
      // swallowing it would leave the control reporting a success the line below
      // denies.
      throw err;
    }
  }

  return (
    <div className="lesson-compose">
      <label className="rb-label" htmlFor="claim-text">
        Write one down yourself
      </label>
      <textarea
        id="claim-text"
        className="rb-text"
        rows={3}
        value={text}
        placeholder="The web bundle has to be built before the suite passes — `npm run build:web` first, or the console tests fail on a stale dist."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter submits, matching every other composer in the cockpit.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="lesson-compose-foot">
        <label className="muted small" htmlFor="claim-goal">
          Learned on
        </label>
        <input
          id="claim-goal"
          className="lesson-goal"
          value={goal}
          placeholder="issue:41 — optional"
          onChange={(e) => setGoal(e.target.value)}
        />
        <span className="spacer" />
        <AsyncButton className="primary" disabled={text.trim().length === 0} onClick={submit}>
          Write it down
        </AsyncButton>
      </div>
      <p className="muted small">
        It lands as <b>one voice</b>, like anything an agent raises — nothing here puts a claim in front of the fleet
        without a second decision.
      </p>
      {failed && (
        <p className="launch-error" role="alert">
          That didn&rsquo;t go through. Your text is still here — try again.
        </p>
      )}
    </div>
  );
}

interface RowProps {
  now: number;
  refUrls: Record<string, string>;
  viewingFact: string | null;
  /** False when no real tracker is configured — the ticket exit is not drawn at all. */
  canFileTickets: boolean;
  onReach: (id: string, reach: FactRuling) => Promise<unknown> | unknown;
  /** Send a claim on — a documentation pull request, a job, or a ticket. */
  onExit: (id: string, exit: FactExit) => Promise<unknown> | unknown;
  onSettleGraduation: (id: string, outcome: GraduationOutcome) => Promise<unknown> | unknown;
  /** The graduation each fact carries, if any — the live one, or the last that did not land. */
  graduationOf: Map<string, KnowledgeGraduationView>;
  onDetail: (id: string) => Promise<{
    corroborations: KnowledgeCorroboration[];
    contradictions: KnowledgeContradictionView[];
  }>;
  onResolveContradiction: (id: string, ruling: ContradictionRuling) => Promise<unknown> | unknown;
  onViewFact: (id: string | null) => void;
  /** Ids the block's cap left out, from the renderer that left them out. */
  dropped: Set<string>;
  /** Why each claim is waiting on a person, by fact id — `waitingOn`'s answer, taken once. */
  waiting: Map<string, string>;
}

/**
 * One heading and what is under it.
 *
 * The blurb is a tooltip rather than a paragraph: the words are the page's only
 * statement of several of its invariants and none is dropped, but nine of them
 * stacked between an operator and the rows they came to rule on is what the page
 * was costing. A tail may be folded away by the operator who has finished with it
 * and starts open, so nothing is hidden by default; the count stays on the heading
 * either way, so a tail somebody has collapsed still says what it holds.
 */
function KnowledgeSection({
  group,
  facts,
  open,
  onToggle,
  ...row
}: {
  group: (typeof KNOWLEDGE_GROUPS)[number];
  facts: KnowledgeFactView[];
  /** A tail an operator has opened, or one of the headings that is always open. */
  open: boolean;
  onToggle: () => void;
} & RowProps): JSX.Element {
  const count = <span className="muted small">· {facts.length}</span>;
  return (
    <section className="kn-section">
      <h3 className="kn-head">
        {group.tail ? (
          <button
            type="button"
            className="chip-button kn-fold"
            aria-expanded={open}
            title={group.blurb}
            onClick={onToggle}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {group.title} {count}
          </button>
        ) : (
          <span title={group.blurb}>
            {group.title} {count}
          </span>
        )}
      </h3>
      {open &&
        (facts.length === 0 ? (
          <p className="empty">Nothing here.</p>
        ) : (
          facts.map((fact) => <FactCard key={fact.id} fact={fact} {...row} />)
        ))}
    </section>
  );
}

/**
 * One claim: what it says, who it applies to, how many independent observers say
 * so, and where it came from.
 *
 * The corroboration count is the server's — {@link distinctCorroborators}' answer,
 * shipped on the row — and never `corroborations.length` here: two observations
 * are one corroborator if they share a goal or a session, so a length counted in
 * the browser would be a different number wearing the same label, free to
 * disagree with the one that actually promotes a claim.
 */
function FactCard({
  fact,
  now,
  refUrls,
  viewingFact,
  canFileTickets,
  onReach,
  onExit,
  onSettleGraduation,
  onDetail,
  onResolveContradiction,
  onViewFact,
  dropped,
  graduationOf,
  waiting,
}: { fact: KnowledgeFactView } & RowProps) {
  const open = viewingFact === fact.id;
  const graduation = graduationOf.get(fact.id) ?? null;
  // Why this claim is waiting on a person — drawn only where the heading above it
  // does not already say so. Under **Needs you** it would be the section's own
  // sentence repeated once per row; on an injected claim with an unanswered
  // dispute it is the whole reason the row is in the filter, and there is nowhere
  // else on the page it could be read.
  const why = groupFor(fact, now) === 'needsYou' ? null : (waiting.get(fact.id) ?? null);
  // Transient form state and not `Place`: a half-filled radio group is not a place
  // anybody would link to or expect the back button to restore, which is the line
  // the address bar draws (`docs/spec/17-cockpit.md#the-address-bar`).
  const [committing, setCommitting] = useState(false);
  const settled =
    fact.reach === 'rejected' || fact.reach === 'graduated' || fact.reach === 'superseded' || fact.reach === 'retired';
  return (
    <div className={`kn-card${settled ? ' resolved' : ''}`}>
      {/* Markdown, and handed the ref map so a goal named inside the claim is
          still a way there — the treatment a lesson's text and a finding's detail
          both get. The renderer emits React children, so nothing in it executes. */}
      <div className="kn-claim">{renderMarkdown(fact.claim, refUrls)}</div>
      {why !== null && (
        <p
          className="kn-waiting"
          title="A reading, and never a trigger: nothing was demoted, lapsed or dropped by it. The claim is exactly where you left it."
        >
          {why}
        </p>
      )}
      <div className="kn-foot">
        <FactScope scope={fact.scope} />
        {/* The one failure a check scope has that nothing else can show: a check
            name is a provider identifier matched exactly, so a renamed or
            re-matrixed job stops the claim being delivered and nothing errors.
            The verdict is the server's — it is a comparison against a configured
            window, made beside the dispatches and the world it reads.

            Nothing was demoted by it. A scope that matched nothing may be a check
            that is simply not running this week, which is why this says what it
            saw rather than what to do about it. */}
        {fact.scopeStale && (
          <span
            className="chip small warn"
            title={
              `Nothing has matched this scope lately, and the provider is not reporting a check by this name — ` +
              `so it is probably a job that was renamed or re-matrixed, and this claim is reaching nobody. ` +
              (fact.scopeLastMatchedAt === null
                ? 'No dispatch has ever carried it.'
                : `Last carried by a dispatch on ${absDate(fact.scopeLastMatchedAt)}.`) +
              ' Nothing was demoted by this reading — the claim is exactly where you left it.'
            }
          >
            scope has drifted
          </span>
        )}
        {/* How often the claim was actually wanted — explicit `knowledge_ask`
            calls, never delivery by a matching scope, which is the harness putting
            a claim in front of an agent that did not ask for it. Drawn on lookup
            rows alone: an injected claim is in front of every agent whether it
            wanted it or not, and there is no way to measure whether a line was
            read. This page does not pretend there is.

            A reading and never a trigger: a claim nobody asked for this month may
            be the one that saves the next agent a day. */}
        {fact.reach === 'lookup' && (
          <span
            className={`chip small ${fact.asks > 0 ? 'ok' : ''}`}
            title={
              fact.asks === 0
                ? 'No agent has asked for this. That is a reading and not a verdict — nothing is demoted, lapsed or dropped for want of demand, and a claim nobody wanted this month may be the one that saves the next agent a day.'
                : `Asked for ${fact.asks} ${fact.asks === 1 ? 'time' : 'times'}${fact.lastAskedAt === null ? '' : `, most recently on ${absDate(fact.lastAskedAt)}`}. Explicit knowledge_ask calls only: a claim also reaches the dispatches its scope matches, and counting those would make this a count of dispatches rather than of demand.`
            }
          >
            {fact.asks === 0 ? 'never asked for' : `asked for ${fact.asks}×`}
          </span>
        )}
        <span className={`chip small ${fact.corroborations > 1 ? 'ok' : ''}`} title={countTitle(fact.corroborations)}>
          {fact.corroborations} {fact.corroborations === 1 ? 'observer' : 'observers'}
        </span>
        {/* What the fleet has said *against* the claim, and the fraction of
            everything said that is. Both the server's — the count is over a
            different table from the one beside it, and the ratio is its division,
            because two counts of voices divided in the browser would be arithmetic
            over numbers whose rule this file does not know.

            A reading and never a verdict: nothing here demoted anything. A claim
            right in general and wrong at one edge attracts contradictions because
            it is being used, so a high ratio on a well-used claim is a claim worth
            sharpening rather than one worth killing. */}
        {fact.contradictions > 0 && (
          <span
            className={`chip small ${fact.openContradictions > 0 ? 'warn' : ''}`}
            title={
              `${fact.contradictions} independent ${fact.contradictions === 1 ? 'voice disputes' : 'voices dispute'} ` +
              `this — ${Math.round(fact.contradictionRatio * 100)}% of everything said about it. Nothing was ` +
              `demoted by that: the claim is exactly where it was, and only you or its own clock will move it.`
            }
          >
            {fact.contradictions} {fact.contradictions === 1 ? 'dispute' : 'disputes'} ·{' '}
            {Math.round(fact.contradictionRatio * 100)}%
          </span>
        )}
        {fact.openContradictions > 0 && (
          <span
            className="chip small warn"
            title="Open disputes, each with an amendment behind it. Until you answer one the claim keeps reaching every agent it already reached — nothing here is demoted by a count."
          >
            {fact.openContradictions} to answer
          </span>
        )}
        {fact.expiresAt !== null && (
          <span className="chip small warn" title="An expiring fact is out of every read once it lapses; the row stays">
            {new Date(fact.expiresAt).getTime() > now ? `lapses in ${untilTime(fact.expiresAt, now)}` : 'lapsed'}
          </span>
        )}
        {fact.resolvesWhen !== null && (
          <span
            className="chip small info"
            title="The harness watches this and ends the notice when it is met. The clock is the backstop, not the mechanism."
          >
            ends when {fact.resolvesWhen.check} passes on {fact.resolvesWhen.ref}
          </span>
        )}
        {/* Whether agents are getting this one. Per row rather than as a count,
            because "two are over the cap" leaves the operator to work out which two
            before they can demote anything — and the drop is the one thing here
            that the agent is told only the size of. */}
        {dropped.has(fact.id) && (
          <span
            className="chip small warn"
            title="Over the block's character cap, so no agent reads it. Demote a newer injected claim to make room."
          >
            over the cap
          </span>
        )}
        {graduation !== null && <GraduationChip graduation={graduation} />}
        {fact.supersedes !== null && (
          <span
            className="chip small info"
            title="An amendment: it names the claim it sharpens, which is what exempts it from that claim's bar"
          >
            amends an earlier claim
          </span>
        )}
        {/* Provenance, on every row: which goal it was first seen on and when are
            the two things a reader needs to judge whether a claim still holds. */}
        <span className="muted">
          {fact.originRef !== null ? (
            <>
              first seen on <Ref to={fact.originRef} />
            </>
          ) : (
            'not observed on a goal'
          )}{' '}
          · {relTime(fact.createdAt, now)}
        </span>
      </div>
      <div className="kn-acts">
        {/* The words behind the count — what an operator reads to decide whether
            the claim should have carried. Its own fetch, and a place, so a link to
            it opens on it. */}
        <button type="button" className="ghost" onClick={() => onViewFact(open ? null : fact.id)}>
          {open ? 'Hide what was seen' : 'What was seen'}
        </button>
        <span className="spacer" />
        <FactExits
          fact={fact}
          graduation={graduation}
          canFileTickets={canFileTickets}
          committing={committing}
          onCommitting={setCommitting}
          onExit={onExit}
          onSettle={onSettleGraduation}
        />
        <FactRulings fact={fact} onReach={onReach} />
      </div>
      {committing && <FactCommitForm fact={fact} onExit={onExit} onDone={() => setCommitting(false)} />}
      {open && <FactProvenance id={fact.id} now={now} onDetail={onDetail} onResolve={onResolveContradiction} />}
    </div>
  );
}

/**
 * Where a claim is between the click and the landing, drawn as the pull request it
 * is riding on.
 *
 * **The reference is a reference.** A row that names a pull request and offers no
 * way there is the cockpit's most repeated bug, and it is invisible: the row reads
 * correctly and is simply a dead end. Which is why the chip carrying the ref is not
 * a button — one click cannot have two destinations — and the controls that answer
 * an `unknown` reading sit beside it rather than around it.
 *
 * `unknown` is the only reading here that asks for something. The pull request left
 * the world without ever being seen closed, so the harness will not say either way:
 * calling it merged would take the claim out of every prompt for a pull request
 * that may never have merged, and calling it closed would leave a committed claim
 * being paid for twice.
 */
function GraduationChip({ graduation }: { graduation: KnowledgeGraduationView }): JSX.Element {
  // Where the claim went, said in the terms of the exit it took. One chip for
  // three, because the reading is the same question of each — did this actually
  // arrive — and three chips would be three places to keep the wording true.
  const where =
    graduation.exit === 'docs'
      ? graduation.target === 'claudeMd'
        ? 'CLAUDE.md'
        : 'the document that owns it'
      : graduation.exit === 'ticket'
        ? 'the tracker'
        : 'a job';
  const label =
    graduation.reading === 'landed'
      ? graduation.exit === 'ticket'
        ? 'filed in the tracker'
        : graduation.exit === 'job'
          ? 'worked, and the work landed'
          : `committed to ${where}`
      : graduation.reading === 'abandoned'
        ? `the work to take this to ${where} did not land`
        : graduation.reading === 'unknown'
          ? 'its pull request left the world unseen'
          : graduation.exit === 'ticket'
            ? 'being written up for the tracker'
            : graduation.exit === 'job'
              ? 'being worked now'
              : `being written up for ${where}`;
  const tone = graduation.reading === 'landed' ? 'ok' : graduation.reading === 'waiting' ? 'info' : 'warn';
  return (
    <span className="cn-refs">
      <span
        className={`chip small ${tone}`}
        title={
          graduation.reading === 'waiting'
            ? 'An operator sent this on and the work is open. The claim keeps reaching every agent it already reached until that work actually lands — a claim taken out of prompts for a pull request still in review is one nobody is told and nobody can read.'
            : graduation.reading === 'abandoned'
              ? 'It did not land, so nobody took the claim anywhere. It is exactly where it was, and you can send it again.'
              : graduation.reading === 'unknown'
                ? 'The pull request stopped being reported without ever being seen closed, so the harness will not say whether it merged. Guessing either way is silent: merged takes the claim out of every prompt, not-merged goes on paying for a sentence the repository may already state.'
                : 'The exit was taken, so the claim is somewhere better than a prompt and out of every one of them.'
        }
      >
        {label}
      </span>
      {/* A row that names a pull request or a ticket and offers no way there is
          the cockpit's most repeated bug. Whichever the exit produced is drawn as
          a reference beside the chip rather than inside it — one click cannot have
          two destinations. */}
      {graduation.prRef !== null && <Ref to={graduation.prRef} />}
      {graduation.ticketRef !== null && <Ref to={graduation.ticketRef} />}
    </span>
  );
}

/**
 * The three ways a claim leaves this store, as three controls on the row.
 *
 * **They sit beside the reach buttons and not above them**, because they are the
 * same kind of decision made at the same moment: how far this claim carries, and
 * whether it belongs here at all. What used to be two panels' worth of buttons —
 * "Queue job", "File ticket", "Dismiss" on a finding; "Promote", "Retire" on a
 * lesson — is one row of controls, because there is one claim.
 *
 * **There is no "Dismiss" here, and its absence is the point.** Dismissing a
 * finding meant *an operator answered this and a later report is not folded
 * silently into it*, which is exactly what `Reject` already does and says. What
 * dismissing did **not** mean is now sayable separately: `Retire` prunes a claim
 * nobody has to be wrong about. Two words for two acts, where the old surfaces had
 * one word each meaning both.
 *
 * Each control is offered only where the store would take it, so a control that
 * would be refused is not drawn: `docs` needs a standing claim that reaches
 * somebody, `ticket` needs a tracker, and all three need a claim that has not
 * already left. The wording of every refusal lives in `exitableFact`; this only
 * decides what to draw.
 *
 * The two settle buttons are the answer to the one reading the harness will not
 * take. They appear only where a pull request was actually opened, which is what
 * makes saying "it merged" put the claim in a place rather than nowhere — the
 * objection that keeps `graduated` off the ordinary reach control.
 */
function FactExits({
  fact,
  graduation,
  canFileTickets,
  committing,
  onCommitting,
  onExit,
  onSettle,
}: {
  fact: KnowledgeFactView;
  graduation: KnowledgeGraduationView | null;
  canFileTickets: boolean;
  committing: boolean;
  onCommitting: (open: boolean) => void;
  onExit: (id: string, exit: FactExit) => Promise<unknown> | unknown;
  onSettle: (id: string, outcome: GraduationOutcome) => Promise<unknown> | unknown;
}): JSX.Element | null {
  if (graduation !== null && graduation.reading === 'unknown') {
    return (
      <>
        <AsyncButton
          className="ghost"
          onClick={() => onSettle(graduation.id, 'landed')}
          title="It merged. The claim leaves every prompt — an agent reads it from the repository now"
        >
          It merged
        </AsyncButton>
        <AsyncButton
          className="ghost"
          onClick={() => onSettle(graduation.id, 'abandoned')}
          title="It did not merge. The claim stays exactly where it is and goes on being delivered"
        >
          It did not
        </AsyncButton>
      </>
    );
  }
  // One at a time, whichever exit: two agents writing the same paragraph into two
  // pull requests is two chances to land a half of it, and two jobs on one claim is
  // two agents on one piece of work.
  if (graduation !== null && graduation.reading === 'waiting') return null;
  if (!sendableHere(fact)) return null;
  return (
    <>
      <AsyncButton
        className="ghost"
        onClick={() => onExit(fact.id, { exit: 'job' })}
        title="Queue this as a job — an agent verifies the claim and works it now. Nothing here says the claim is true; the prompt tells it to check first and stop if it does not hold"
      >
        Queue job
      </AsyncButton>
      {canFileTickets && (
        <AsyncButton
          className="ghost"
          onClick={() => onExit(fact.id, { exit: 'ticket' })}
          title="File it in the tracker so it can wait its turn there — an agent writes it up, and the claim leaves every prompt once the item exists"
        >
          File ticket
        </AsyncButton>
      )}
      {committableHere(fact) && (
        <button
          type="button"
          className="ghost"
          onClick={() => onCommitting(!committing)}
          title="Open a documentation pull request for this claim. It keeps reaching agents until that pull request merges, and leaves every prompt when it does"
        >
          {committing ? 'Not now' : 'Commit to the repository'}
        </button>
      )}
    </>
  );
}

/**
 * Whether this claim can be sent anywhere at all — the store's own refusal, asked
 * here only so a control that would be refused is not drawn.
 *
 * The terminal reaches, and nothing else: `graduated` has already gone, and
 * `rejected`, `superseded` and `retired` reach nobody, so there is nothing left to
 * act on. `exitableFact` is where the rule lives and where the wording that
 * explains it lives.
 */
function sendableHere(fact: KnowledgeFactView): boolean {
  return fact.reach === 'proposal' || fact.reach === 'lookup' || fact.reach === 'injected';
}

/**
 * Where a committed claim goes, asked before anything is opened — and the two
 * answers are deliberately not offered evenly.
 *
 * The owning document is the ordinary one and needs nothing said: the repository
 * already states which document owns what, and the agent reads it. CLAUDE.md is
 * loaded into every agent's context on every dispatch and **its length is asserted
 * rather than intended**, so graduating there grows without bound the exact cost
 * this page exists to cap. It therefore costs a sentence — what breaks *silently*
 * without the claim, which is that file's own bar — and that sentence is not
 * ceremony: it is appended to the prompt, so the agent writing the entry checks the
 * operator's reading the way it checks the claim.
 *
 * Nothing here moves the claim. It stays exactly where it is, delivered, until the
 * pull request merges — which is a sweep, not this click.
 */
function FactCommitForm({
  fact,
  onExit,
  onDone,
}: {
  fact: KnowledgeFactView;
  onExit: (id: string, exit: FactExit) => Promise<unknown> | unknown;
  onDone: () => void;
}): JSX.Element {
  const [target, setTarget] = useState<'spec' | 'claudeMd'>('spec');
  const [bar, setBar] = useState('');
  return (
    <div className="kn-commit">
      <p className="muted small">
        An agent will check this against the code, write it into the repository and open a pull request. The claim keeps
        reaching every agent it already reaches until that pull request merges — and leaves every prompt for good when
        it does, because an agent reads it from the tree from then on. If the pull request is closed unmerged, nothing
        changes and you can commit it again.
      </p>
      <label className="kn-commit-target">
        <input type="radio" checked={target === 'spec'} onChange={() => setTarget('spec')} />
        <span>
          <b>The document that owns it.</b> The agent finds it — the repository states which document owns what.
        </span>
      </label>
      <label className="kn-commit-target">
        <input type="radio" checked={target === 'claudeMd'} onChange={() => setTarget('claudeMd')} />
        <span>
          <b>CLAUDE.md.</b> Loaded into every agent on every dispatch, and its length is asserted rather than intended —
          so it takes only what, not knowing it, breaks something <em>silently</em>.
        </span>
      </label>
      {target === 'claudeMd' && (
        <textarea
          value={bar}
          rows={3}
          onChange={(e) => setBar(e.target.value)}
          aria-label="What breaks silently without this"
          placeholder="What breaks without this claim, and how it fails without anything going red. The agent writing the entry reads this, and checks it."
        />
      )}
      <div className="kn-acts">
        <AsyncButton
          className="primary"
          disabled={target === 'claudeMd' && bar.trim() === ''}
          onClick={async () => {
            await onExit(
              fact.id,
              target === 'claudeMd' ? { exit: 'docs', target, bar: bar.trim() } : { exit: 'docs', target },
            );
            onDone();
          }}
          title="Queue the documentation job. Nothing leaves any prompt until its pull request merges"
        >
          Open the documentation pull request
        </AsyncButton>
      </div>
    </div>
  );
}

/**
 * Whether the page offers the **`docs`** exit on this claim.
 *
 * Narrower than {@link sendableHere}, and the two refusals are the reason the exits
 * take a control each rather than sharing one. A `docs` exit **asserts** the claim,
 * in a document that outlives the afternoon: so a proposal is refused because
 * nobody has agreed with it, and a notice because it is a report on today. A job
 * and a ticket **act on** it, which asserts nothing and is exactly what an operator
 * clicking "Queue job" on one agent's report has always been doing.
 *
 * `exitableFact` is where the rule lives and where the wording that explains it
 * lives; this only decides what to draw.
 */
function committableHere(fact: KnowledgeFactView): boolean {
  return (fact.reach === 'lookup' || fact.reach === 'injected') && fact.lifetime === 'standing';
}

/** What one more observer would mean, said where the number is. */
function countTitle(count: number): string {
  return count > 1
    ? 'Two independent observers is what carries a claim to lookup — a shared goal or an inherited conversation counts once'
    : 'One observer. A second, on a different goal, carries this to lookup on its own';
}

/**
 * The four things a person can say about a claim, and nothing else.
 *
 * "Keep on lookup" is the one that looks like a no-op and is not: it is how an
 * operator says they have read a corroborated claim and `lookup` is where it
 * belongs, which is what takes the row out of **Needs you**. Without it the
 * section would ask again forever and the only way to silence it would be the
 * wrong decision.
 *
 * Rejecting is two-step, because it is the one act here that cannot be undone:
 * a rejected claim is barred from coming back, and what lifts the bar is an
 * amendment an agent files, not a click.
 */
function FactRulings({
  fact,
  onReach,
}: {
  fact: KnowledgeFactView;
  onReach: (id: string, reach: FactRuling) => Promise<unknown> | unknown;
}): JSX.Element | null {
  // Nothing to say about a claim that is settled. `superseded` is terminal for a
  // second reason: a sharper version of it is standing, and bringing this one back
  // would put the two in one block saying different things.
  if (fact.reach === 'rejected' || fact.reach === 'graduated' || fact.reach === 'superseded') return null;
  // A retired claim is the one non-live reach that offers anything, because
  // retiring is a prune and not a bar: it was never judged untrue, so bringing it
  // back is an ordinary ruling rather than an appeal.
  if (fact.reach === 'retired') {
    return (
      <AsyncButton
        className="ghost"
        onClick={() => onReach(fact.id, 'lookup')}
        title="Carry it again — answered when an agent asks. Retiring was a prune, not a judgement, so this needs no appeal"
      >
        Carry again
      </AsyncButton>
    );
  }
  return (
    <>
      {fact.reach === 'proposal' && (
        <AsyncButton
          className="ghost"
          onClick={() => onReach(fact.id, 'lookup')}
          title="Answer asks with this, without waiting for a second agent to see it"
        >
          Put on lookup
        </AsyncButton>
      )}
      {fact.reach === 'lookup' && fact.ruledAt === null && (
        <AsyncButton
          className="ghost"
          onClick={() => onReach(fact.id, 'lookup')}
          title="True, but not worth every agent's context — leave it here, and stop being asked about it"
        >
          Keep on lookup
        </AsyncButton>
      )}
      {fact.reach === 'injected' ? (
        <AsyncButton
          className="ghost"
          onClick={() => onReach(fact.id, 'lookup')}
          title="Take it out of every agent's prompt, and leave it answerable when somebody asks"
        >
          Demote to lookup
        </AsyncButton>
      ) : (
        <AsyncButton
          className="primary"
          onClick={() => onReach(fact.id, 'injected')}
          title="Put this in front of every agent, before it reads any code. Yours alone to say"
        >
          Inject
        </AsyncButton>
      )}
      {/* One click, no confirmation, and that asymmetry with Reject beside it is
          the point. Retiring is the cheap act on this surface — an operator who has
          to be sure before tidying is an operator who does not tidy, and a store
          nobody prunes is the failure the whole design fears. Nothing is lost: the
          row stays, saying what it said, and an agent that hits the same wall
          raises it again with its own evidence and today's date. */}
      <AsyncButton
        className="ghost"
        onClick={() => onReach(fact.id, 'retired')}
        title="Stop carrying it — not a judgement that it is false. An agent that sees it again may raise it, which re-dates the claim"
      >
        Retire
      </AsyncButton>
      <ConfirmButton
        className="ghost"
        label="Reject"
        confirmLabel="Say it is not true?"
        title="Not true — and barred from being raised again. Terminal: what comes back is an amendment naming this claim, filed by an agent"
        onConfirm={() => onReach(fact.id, 'rejected')}
      />
    </>
  );
}

/**
 * Who it applies to, drawn as the thing it names.
 *
 * A goal scope is a reference and is drawn as one — a scope an operator cannot
 * follow is a label, and this page's rows are full of goals long gone from the
 * world. A check scope is a provider identifier and says so: it matches exactly,
 * so a renamed job silently stops matching, and the only place that can be seen
 * is here.
 */
function FactScope({ scope }: { scope: KnowledgeFactView['scope'] }): JSX.Element {
  if (scope === 'fleet') {
    return (
      <span className="chip small" title="True of working this repository at all — the most expensive kind to be wrong">
        fleet
      </span>
    );
  }
  if (scope.startsWith('goal:')) {
    return (
      <span className="muted">
        goal <Ref to={scope.slice('goal:'.length)} />
      </span>
    );
  }
  return (
    <span
      className="chip small"
      title="One CI check, named exactly as the provider names it. A renamed or re-matrixed job stops matching silently — this is the only place that shows"
    >
      {scope}
    </span>
  );
}

/**
 * The observations behind one claim — who agreed, who disputed it, and what each
 * of them actually saw.
 *
 * Fetched when the row is opened rather than shipped on the polled snapshot: the
 * evidence for a claim runs to thousands of characters per observation, and the
 * rows nobody opens should cost nothing. A failure says so rather than drawing an
 * empty list, which would read as "nobody said anything".
 *
 * Both sides are here because the decision is between them: an operator answering
 * a contradiction is choosing between the sentence that stands and the sentence
 * being offered, and a surface showing only one of them would be asking for that
 * decision with half of it hidden.
 */
function FactProvenance({
  id,
  now,
  onDetail,
  onResolve,
}: {
  id: string;
  now: number;
  onDetail: (id: string) => Promise<{
    corroborations: KnowledgeCorroboration[];
    contradictions: KnowledgeContradictionView[];
  }>;
  onResolve: (id: string, ruling: ContradictionRuling) => Promise<unknown> | unknown;
}): JSX.Element {
  const [payload, setPayload] = useState<{
    corroborations: KnowledgeCorroboration[];
    contradictions: KnowledgeContradictionView[];
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setPayload(null);
    setFailed(false);
    onDetail(id)
      .then((next) => live && setPayload(next))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id, onDetail]);

  if (failed) return <p className="muted small">The observations behind this could not be read.</p>;
  if (payload === null) return <p className="muted small">Reading what was seen…</p>;
  return (
    <div className="kn-seen">
      {payload.corroborations.map((row) => (
        <div className="kn-obs" key={row.id}>
          <div className="kn-words">{row.words}</div>
          <div className="muted small">
            {row.goalRef !== null ? (
              <>
                on <Ref to={row.goalRef} />
              </>
            ) : (
              'no goal behind it'
            )}{' '}
            · {relTime(row.createdAt, now)}
          </div>
        </div>
      ))}
      {payload.contradictions.length > 0 && (
        <>
          <div className="kn-head small">Disputed</div>
          <p className="muted small">
            An agent found this claim contradicted by the code in front of it and wrote what it should say instead —
            which is the whole of a contradiction here, because nothing is demoted by a count. A claim that is right in
            general and wrong at one edge attracts these <em>because it is being used</em>, so the move is usually to
            sharpen it. Until you make one, the claim goes on reaching every agent it already reached.
          </p>
          {payload.contradictions.map((row) => (
            <Contradiction key={row.id} row={row} now={now} onResolve={onResolve} />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * One dispute: what the agent saw, the sentence it offered instead, and the three
 * moves — **two of which move the claim, and one of which is the only one that
 * does not**.
 *
 * "Adopt" is one control and one call rather than a promote followed by a demote:
 * the amendment reaching the claim's place and the claim leaving it are two halves
 * of one decision, and half of it landing puts the sharper claim in the same block
 * as the blunter one it was written to replace, both being read by every agent
 * until somebody notices.
 */
function Contradiction({
  row,
  now,
  onResolve,
}: {
  row: KnowledgeContradictionView;
  now: number;
  onResolve: (id: string, ruling: ContradictionRuling) => Promise<unknown> | unknown;
}): JSX.Element {
  const [narrowing, setNarrowing] = useState<string | null>(null);
  return (
    <div className={`kn-obs kn-dispute${row.resolution !== null ? ' resolved' : ''}`}>
      <div className="kn-words">{row.words}</div>
      {row.amendment !== null ? (
        <div className="kn-amendment">
          <div className="kn-head small">Should say instead</div>
          <div>{row.amendment.claim}</div>
        </div>
      ) : (
        <p className="muted small">The amendment filed with this is gone.</p>
      )}
      <div className="muted small">
        {row.goalRef !== null ? (
          <>
            on <Ref to={row.goalRef} />
          </>
        ) : (
          'no goal behind it'
        )}{' '}
        · {relTime(row.createdAt, now)}
        {row.resolution !== null && <> · {RESOLVED_AS[row.resolution]}</>}
      </div>
      {row.resolution === null &&
        (narrowing === null ? (
          <div className="kn-acts">
            <AsyncButton
              className="primary"
              onClick={() => onResolve(row.id, { resolution: 'amended' })}
              title="Put the amendment exactly where this claim is and supersede this wording — one act, so the two can never both be in the block"
            >
              Adopt the amendment
            </AsyncButton>
            <button type="button" className="ghost" onClick={() => setNarrowing(row.amendment?.claim ?? '')}>
              Narrow it yourself
            </button>
            <span className="spacer" />
            <AsyncButton
              className="ghost"
              onClick={() => onResolve(row.id, { resolution: 'dismissed' })}
              title="The dispute is wrong. The claim stays exactly where it is, and the amendment stays a proposal reaching nobody"
            >
              Dismiss
            </AsyncButton>
          </div>
        ) : (
          <div className="kn-narrow">
            <textarea
              value={narrowing}
              rows={4}
              onChange={(e) => setNarrowing(e.target.value)}
              aria-label="What the claim should say"
            />
            <div className="kn-acts">
              <AsyncButton
                className="primary"
                disabled={narrowing.trim() === ''}
                onClick={() => onResolve(row.id, { resolution: 'narrowed', claim: narrowing.trim() })}
                title="Rewrite the claim in place. Every open dispute on it is answered, and the amendments they offered are superseded by your wording"
              >
                Save this wording
              </AsyncButton>
              <button type="button" className="ghost" onClick={() => setNarrowing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

/** What an answered dispute says it was. The verb an operator used, in their terms rather than the store's. */
const RESOLVED_AS: Record<NonNullable<KnowledgeContradictionView['resolution']>, string> = {
  amended: 'you adopted this amendment',
  narrowed: 'you narrowed the claim yourself',
  dismissed: 'you left the claim where it was',
};
