import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type {
  ContradictionRuling,
  FactRuling,
  KnowledgeContradictionView,
  KnowledgeCorroboration,
  KnowledgeCost,
  KnowledgeDeliveryView,
  KnowledgeFactView,
} from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import { absDate, fmtTokens, fmtUsd, relTime, untilTime } from './util.js';
import { Ref } from './refs.js';

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
 * for, then the long tails.
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
  delivery,
  cost,
  now,
  refUrls,
  viewingFact,
  onReach,
  onDetail,
  onResolveContradiction,
  onViewFact,
}: {
  facts: KnowledgeFactView[];
  /** What the two renderers actually send, projected server-side. Never recomputed here. */
  delivery: KnowledgeDeliveryView;
  /** What sending it costs, priced server-side against the fleet's own spend. Never divided here. */
  cost: KnowledgeCost;
  now: number;
  refUrls: Record<string, string>;
  /** The claim whose provenance is open, from `Place` — never this component's own state. */
  viewingFact: string | null;
  onReach: (id: string, reach: FactRuling) => Promise<unknown> | unknown;
  onDetail: (id: string) => Promise<{
    corroborations: KnowledgeCorroboration[];
    contradictions: KnowledgeContradictionView[];
  }>;
  onResolveContradiction: (id: string, ruling: ContradictionRuling) => Promise<unknown> | unknown;
  onViewFact: (id: string | null) => void;
}) {
  const live = (fact: KnowledgeFactView): boolean =>
    fact.expiresAt === null || new Date(fact.expiresAt).getTime() > now;
  // A notice is an expiring fact that has not lapsed. A lapsed one is out of every
  // read but its row still says what it said, so it falls through to the section
  // its reach puts it in rather than vanishing.
  const notices = facts.filter((f) => f.lifetime === 'expiring' && f.reach !== 'rejected' && live(f));
  const noticed = new Set(notices.map((f) => f.id));
  const standing = facts.filter((f) => !noticed.has(f.id));
  const section = (reach: KnowledgeFactView['reach'], ruled: boolean | null = null): KnowledgeFactView[] =>
    standing.filter((f) => f.reach === reach && (ruled === null || (f.ruledAt !== null) === ruled));

  // Which injected claims the cap left out, as the renderer that ran reported it.
  // Never a character count taken here: a second implementation of "what fits" is
  // free to disagree with the one that shipped, and nothing is red when it does.
  const dropped = new Set(delivery.dropped);
  const shared = { now, refUrls, viewingFact, onReach, onDetail, onResolveContradiction, onViewFact, dropped };
  return (
    <div className="kn">
      <p className="muted small kn-note">
        What agents have learned about <em>working</em> this repository, and how far each claim carries. Agents write
        these down through <code>knowledge_propose</code>; two of them on two different goals carry a claim as far as{' '}
        <b>on lookup</b>, and nothing but a person puts a standing one in front of every agent. The one exception is a{' '}
        <b>notice</b> — an observation with a clock on it, raised through <code>knowledge_notice</code> or by the
        harness itself — which agreement alone injects, because it ends by itself. A promoted lesson is mirrored in here
        as an injected fleet claim, so the <b>Lessons</b> panel and this page show the same claims — govern a mirrored
        claim wherever you first vouched for it.
      </p>
      <KnowledgeSection
        title="Live notices"
        blurb="Expiring observations, with the clock they were filed under. A notice states what was seen and never what to do about it; the agent draws the conclusion. These are the one thing agreement alone puts in front of every agent — two goals seeing the same thing is enough, and what makes that safe is that each one ends by itself. The harness raises its own for a check that went red and green on one commit, and for a check red on a branch other pull requests are based on; it reads those rather than being told them, so it counts as an observer."
        facts={notices}
        {...shared}
      />
      <KnowledgeSection
        title="Needs you"
        blurb="Two agents on two different goals saw the same thing, which is as far as agreement can carry a claim. What is left is yours: put it in front of every agent, leave it here to be asked for, or say it is not true."
        facts={section('lookup', false)}
        {...shared}
      />
      <KnowledgeSection
        title="Injected"
        blurb="In every agent's system prompt before it reads any code — vouched for by you, or a notice two goals saw. Everything here rides the block below whatever its scope, because a claim about one check is for the agent about to run it as much as for the one sent to fix it. The exception is a goal claim: it dies with its goal, so it rides that goal's own dispatches instead."
        facts={section('injected')}
        meter={<BlockBudget delivery={delivery} cost={cost} />}
        {...shared}
      />
      <KnowledgeSection
        title="On lookup"
        blurb="True, and answered when an agent asks. This is where a claim that is not worth every agent's context belongs — it costs nothing until somebody wants it. Each row carries how often it was actually asked for, which is the one signal an injected claim cannot have: there is no way to measure whether a line in every agent's prompt was read, and this page does not pretend there is. Nothing is demoted for want of demand."
        facts={section('lookup', true)}
        {...shared}
      />
      <KnowledgeSection
        title="One voice"
        blurb="One agent said it and nothing has agreed. These reach nobody and cost nothing; they are here because the second agent to hit the same wall is what moves them, and because you can rule on one now if you already know."
        facts={section('proposal')}
        {...shared}
      />
      <KnowledgeSection
        title="Committed to the repository"
        blurb="In docs/spec or CLAUDE.md now, and out of every prompt: an agent reads these from the repository, and keeping them injected would pay context twice for one sentence. This list growing while Injected shrinks is the number worth watching."
        facts={section('committed')}
        {...shared}
      />
      <KnowledgeSection
        title="Superseded"
        blurb="Replaced. An agent said one of these was contradicted by the code in front of it, wrote what it should say instead, and you adopted that amendment — so this wording is out of every prompt while its row stays saying what it said. Not rejected: it was not judged untrue, and a rejection would bar the sharper claim's own words, since an amendment contains the claim it sharpens."
        facts={section('superseded')}
        {...shared}
      />
      <KnowledgeSection
        title="Rejected"
        blurb="Not true, and barred from coming back: a re-proposal of one of these is refused by name. Drawn rather than dropped, because a surface that shows only what it let through cannot show you what it stopped. Terminal — the way back is an agent filing an amendment that names the claim."
        facts={section('rejected')}
        {...shared}
      />
      <Receives delivery={delivery} />
    </div>
  );
}

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
 * which claims it is missing. `LessonsPanel` carries the idea in miniature, per
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

interface RowProps {
  now: number;
  refUrls: Record<string, string>;
  viewingFact: string | null;
  onReach: (id: string, reach: FactRuling) => Promise<unknown> | unknown;
  onDetail: (id: string) => Promise<{
    corroborations: KnowledgeCorroboration[];
    contradictions: KnowledgeContradictionView[];
  }>;
  onResolveContradiction: (id: string, ruling: ContradictionRuling) => Promise<unknown> | unknown;
  onViewFact: (id: string | null) => void;
  /** Ids the block's cap left out, from the renderer that left them out. */
  dropped: Set<string>;
}

function KnowledgeSection({
  title,
  blurb,
  facts,
  meter,
  ...row
}: { title: string; blurb: string; facts: KnowledgeFactView[]; meter?: JSX.Element } & RowProps): JSX.Element {
  return (
    <section className="kn-section">
      <h3 className="kn-head">
        {title} <span className="muted small">· {facts.length}</span>
      </h3>
      <p className="muted small">{blurb}</p>
      {meter}
      {facts.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        facts.map((fact) => <FactCard key={fact.id} fact={fact} {...row} />)
      )}
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
  onReach,
  onDetail,
  onResolveContradiction,
  onViewFact,
  dropped,
}: { fact: KnowledgeFactView } & RowProps) {
  const open = viewingFact === fact.id;
  const settled = fact.reach === 'rejected' || fact.reach === 'committed' || fact.reach === 'superseded';
  return (
    <div className={`kn-card${settled ? ' resolved' : ''}`}>
      {/* Markdown, and handed the ref map so a goal named inside the claim is
          still a way there — the treatment a lesson's text and a finding's detail
          both get. The renderer emits React children, so nothing in it executes. */}
      <div className="kn-claim">{renderMarkdown(fact.claim, refUrls)}</div>
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
        <FactRulings fact={fact} onReach={onReach} />
      </div>
      {open && <FactProvenance id={fact.id} now={now} onDetail={onDetail} onResolve={onResolveContradiction} />}
    </div>
  );
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
  if (fact.reach === 'rejected' || fact.reach === 'committed' || fact.reach === 'superseded') return null;
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
      <ConfirmButton
        className="ghost"
        label="Reject"
        confirmLabel="Say it is not true?"
        title="Not true — and barred from being proposed again. Terminal: what comes back is an amendment naming this claim, filed by an agent"
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
