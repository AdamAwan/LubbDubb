import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { FactRuling, KnowledgeCorroboration, KnowledgeFactView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import { relTime, untilTime } from './util.js';
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
 * **Nothing on this page auto-promotes anything.** The store carries a claim to
 * `lookup` on two corroborations from two different goals and no further;
 * `injected` — in front of every agent before it reads any code — is an
 * operator's and only an operator's. Every control below is one of the four
 * things a person can say, and none of them is available to an agent.
 *
 * The order is the order things demand attention rather than the order of the
 * state machine: the notices with clocks on them, then the corroborated claims
 * waiting on the one decision that is yours, then what you have already vouched
 * for, then the long tails.
 *
 * → `docs/spec/27-knowledge.md`, `docs/spec/17-cockpit.md`
 */
export function KnowledgePanel({
  facts,
  now,
  refUrls,
  viewingFact,
  onReach,
  onDetail,
  onViewFact,
}: {
  facts: KnowledgeFactView[];
  now: number;
  refUrls: Record<string, string>;
  /** The claim whose provenance is open, from `Place` — never this component's own state. */
  viewingFact: string | null;
  onReach: (id: string, reach: FactRuling) => Promise<unknown> | unknown;
  onDetail: (id: string) => Promise<{ corroborations: KnowledgeCorroboration[] }>;
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

  const shared = { now, refUrls, viewingFact, onReach, onDetail, onViewFact };
  return (
    <div className="kn">
      <p className="muted small kn-note">
        What agents have learned about <em>working</em> this repository, and how far each claim carries. Agents write
        these down through <code>knowledge_propose</code>; two of them on two different goals carry a claim as far as{' '}
        <b>on lookup</b>, and nothing but a person puts one in front of every agent. A promoted lesson is mirrored in
        here as an injected fleet claim, so the <b>Lessons</b> panel and this page show the same claims until delivery
        moves — govern a mirrored claim wherever you first vouched for it.
      </p>
      <KnowledgeSection
        title="Live notices"
        blurb="Expiring observations, with the clock they were filed under. A notice states what was seen and never what to do about it; the agent draws the conclusion. Nothing here is raised by the harness itself yet."
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
        blurb="Vouched for, and bound for every agent's prompt before it reads any code. Nothing here is delivered yet — the block that renders these lands in phase 3, and until it does a promoted lesson still reaches agents through the Lessons block."
        facts={section('injected')}
        {...shared}
      />
      <KnowledgeSection
        title="On lookup"
        blurb="True, and answered when an agent asks. This is where a claim that is not worth every agent's context belongs — it costs nothing until somebody wants it."
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
        title="Rejected"
        blurb="Not true, and barred from coming back: a re-proposal of one of these is refused by name. Drawn rather than dropped, because a surface that shows only what it let through cannot show you what it stopped. Terminal — the way back is an agent filing an amendment that names the claim."
        facts={section('rejected')}
        {...shared}
      />
    </div>
  );
}

interface RowProps {
  now: number;
  refUrls: Record<string, string>;
  viewingFact: string | null;
  onReach: (id: string, reach: FactRuling) => Promise<unknown> | unknown;
  onDetail: (id: string) => Promise<{ corroborations: KnowledgeCorroboration[] }>;
  onViewFact: (id: string | null) => void;
}

function KnowledgeSection({
  title,
  blurb,
  facts,
  ...row
}: { title: string; blurb: string; facts: KnowledgeFactView[] } & RowProps): JSX.Element {
  return (
    <section className="kn-section">
      <h3 className="kn-head">
        {title} <span className="muted small">· {facts.length}</span>
      </h3>
      <p className="muted small">{blurb}</p>
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
  onViewFact,
}: { fact: KnowledgeFactView } & RowProps) {
  const open = viewingFact === fact.id;
  const settled = fact.reach === 'rejected' || fact.reach === 'committed';
  return (
    <div className={`kn-card${settled ? ' resolved' : ''}`}>
      {/* Markdown, and handed the ref map so a goal named inside the claim is
          still a way there — the treatment a lesson's text and a finding's detail
          both get. The renderer emits React children, so nothing in it executes. */}
      <div className="kn-claim">{renderMarkdown(fact.claim, refUrls)}</div>
      <div className="kn-foot">
        <FactScope scope={fact.scope} />
        <span className={`chip small ${fact.corroborations > 1 ? 'ok' : ''}`} title={countTitle(fact.corroborations)}>
          {fact.corroborations} {fact.corroborations === 1 ? 'observer' : 'observers'}
        </span>
        {fact.expiresAt !== null && (
          <span className="chip small warn" title="An expiring fact is out of every read once it lapses; the row stays">
            {new Date(fact.expiresAt).getTime() > now ? `lapses in ${untilTime(fact.expiresAt, now)}` : 'lapsed'}
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
      {open && <FactProvenance id={fact.id} now={now} onDetail={onDetail} />}
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
  if (fact.reach === 'rejected' || fact.reach === 'committed') return null;
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
 * The observations behind one claim, in the observers' own words.
 *
 * Fetched when the row is opened rather than shipped on the polled snapshot: the
 * evidence for a claim runs to thousands of characters per observation, and the
 * rows nobody opens should cost nothing. A failure says so rather than drawing an
 * empty list, which would read as "nobody said anything".
 */
function FactProvenance({
  id,
  now,
  onDetail,
}: {
  id: string;
  now: number;
  onDetail: (id: string) => Promise<{ corroborations: KnowledgeCorroboration[] }>;
}): JSX.Element {
  const [rows, setRows] = useState<KnowledgeCorroboration[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setRows(null);
    setFailed(false);
    onDetail(id)
      .then((payload) => live && setRows(payload.corroborations))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id, onDetail]);

  if (failed) return <p className="muted small">The observations behind this could not be read.</p>;
  if (rows === null) return <p className="muted small">Reading what was seen…</p>;
  return (
    <div className="kn-seen">
      {rows.map((row) => (
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
    </div>
  );
}
