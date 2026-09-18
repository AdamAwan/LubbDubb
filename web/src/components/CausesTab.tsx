import type { JSX } from 'react';
import type {
  RemedyCauseTotal,
  RemedyInsights,
  RemedyKindHealth,
  ReviewAreaTotal,
  ReviewLabelInsights,
} from '../types.js';
import { fmtUsd, relTime } from './util.js';
import { fmtShare, share } from './insightsFormat.js';
import { Ref } from './refs.js';
import { HeadRow } from './panel.js';
import { Tag } from './tag.js';
import { MethodNote } from './insightsMethod.js';

// → docs/spec/17-cockpit.md

export function CausesTab({
  remedies,
  reviewLabels,
  windowLabel,
}: {
  remedies: RemedyInsights;
  reviewLabels: ReviewLabelInsights | null;
  windowLabel: string;
}): JSX.Element {
  return (
    <div className="rl">
      <Causes remedies={remedies} windowLabel={windowLabel} />
      {reviewLabels !== null && <ReviewComments labels={reviewLabels} windowLabel={windowLabel} />}
    </div>
  );
}

function ReviewComments({ labels, windowLabel }: { labels: ReviewLabelInsights; windowLabel: string }): JSX.Element {
  if (labels.threads === 0) {
    return (
      <>
        <p className="sp-sub">Review threads, {windowLabel}</p>
        <p className="empty">The fleet has answered no review threads in this window.</p>
      </>
    );
  }
  const placed = labels.byArea.filter((a) => a.threads > 0);
  return (
    <>
      <p className="sp-sub">Review threads, {windowLabel}</p>
      <table className="sp-tbl">
        <thead>
          <tr>
            <th>Where</th>
            <th className="n">Threads</th>
            <th className="n">About a comment</th>
            <th className="n">Changed code</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="nm">Everything answered</span>
            </td>
            <td className="n b">{labels.threads}</td>
            <td className="n">
              {labels.aboutComment} ({fmtShare(labels.aboutComment, labels.threads)})
            </td>
            <td className="n">
              {labels.changedCode} ({fmtShare(labels.changedCode, labels.threads)})
            </td>
          </tr>
          {placed.map((area: ReviewAreaTotal) => (
            <tr key={area.area}>
              <td>
                <span className="nm mono">{area.area}</span>
              </td>
              <td className="n b">{area.threads}</td>
              <td className="n">
                {area.aboutComment} ({fmtShare(area.aboutComment, area.threads)})
              </td>
              <td className="n">
                {area.changedCode} ({fmtShare(area.changedCode, area.threads)})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="sp-tbl">
        <thead>
          <tr>
            <th>Who raised it</th>
            <th className="n">Threads</th>
            <th className="n">About a comment</th>
            <th className="n">Changed code</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="nm">People</span>
            </td>
            <td className="n b">{labels.byPeople.threads}</td>
            <td className="n">
              {labels.byPeople.aboutComment} ({fmtShare(labels.byPeople.aboutComment, labels.byPeople.threads)})
            </td>
            <td className="n">
              {labels.byPeople.changedCode} ({fmtShare(labels.byPeople.changedCode, labels.byPeople.threads)})
            </td>
          </tr>
          <tr>
            <td>
              <span className="nm">Machines</span>
            </td>
            <td className="n b">{labels.byBots.threads}</td>
            <td className="n">
              {labels.byBots.aboutComment} ({fmtShare(labels.byBots.aboutComment, labels.byBots.threads)})
            </td>
            <td className="n">
              {labels.byBots.changedCode} ({fmtShare(labels.byBots.changedCode, labels.byBots.threads)})
            </td>
          </tr>
        </tbody>
      </table>
      <p className="sp-note">
        {labels.replies} repl{labels.replies === 1 ? 'y' : 'ies'} across {labels.threads} thread
        {labels.threads === 1 ? '' : 's'} &middot; {labels.threads - labels.answeredOnce} needed more than one
        {labels.unanchored > 0 ? ` · ${labels.unanchored} anchored to no file` : ''}
        {labels.unplaced > 0 ? ` · ${labels.unplaced} in no configured area` : ''}
      </p>
      {labels.byAuthor.length > 1 && (
        <table className="sp-tbl">
          <thead>
            <tr>
              <th>Who raised it</th>
              <th className="n">Threads</th>
              <th className="n">About a comment</th>
              <th className="n">Changed code</th>
            </tr>
          </thead>
          <tbody>
            {labels.byAuthor.map((a) => (
              <tr key={a.author}>
                <td>
                  <span className="nm">{a.author}</span>
                  <Tag>{a.kind === 'bot' ? 'machine' : 'person'}</Tag>
                </td>
                <td className="n b">{a.threads}</td>
                <td className="n">
                  {a.aboutComment} ({fmtShare(a.aboutComment, a.threads)})
                </td>
                <td className="n">
                  {a.changedCode} ({fmtShare(a.changedCode, a.threads)})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <MethodNote>
        <p>
          <b>The denominator is threads the fleet answered</b>, not review comments left. A thread a reviewer resolved
          themselves, or one an operator answered, never reaches an agent and is counted nowhere here.
        </p>
        <p>
          <b>A machine is one the provider owns up to</b>, one whose thread carries the stamp this project declared in{' '}
          <code>review.publishedThreadProperty</code>, or one named in <code>review.machineAuthors</code>. Anything else
          is counted as a person, which is an assumption rather than a finding &mdash; a machine nobody has named yet
          sits in the People row until somebody names it. The authors are drawn by name for that reason: one hiding
          among the people is visible in the rows, where a total would hide it.
        </p>
        <p>
          <b>Both columns are the answering agent&rsquo;s own word</b>, given as it replied. An area is worked out from
          the file the thread is anchored to, so a thread on no file sits in none, and a file matching two rules is
          counted under both &mdash; the rows do not sum to the total.
        </p>
      </MethodNote>
    </>
  );
}

export function causeRows(remedies: RemedyInsights | null): (string | number | null)[][] {
  if (remedies === null || remedies.accounts === 0) return [];
  return [
    ['Causes'],
    ['Accounts filed', remedies.accounts],
    ['Cost of returning (USD)', remedies.costUsd],
    ['Dispatches that filed nothing', remedies.unaccounted],
    ['An account is', "one agent's reckoning of one return — not one red, and not one run"],
    ['Cost is', "the filing agent's spend in the window, divided evenly across the accounts it filed"],
    [],

    ['What would have caught it'],
    ['Guard', 'Label', 'Definition', 'Accounts', 'Cost (USD)'],
    ...remedies.byGuard.map((g) => [g.guard, g.label, g.blurb, g.accounts, g.costUsd]),
    [],

    ['By cause'],
    ['Kind', 'Cause', 'Label', 'Definition', 'Accounts', 'Cost (USD)', 'Undocumented', 'Top check', 'On accounts'],
    ...remedies.byKind.flatMap((k) =>
      k.byCause.map((c) => [
        k.kind,
        c.cause,
        c.label,
        c.blurb,
        c.accounts,
        c.costUsd,
        c.undocumented,
        c.topCheck?.name ?? null,
        c.topCheck?.accounts ?? null,
      ]),
    ),
    [],

    ['Lately'],
    ['When (ISO)', 'Kind', 'PR', 'Cause', 'Guard', 'Checks', 'Summary'],
    ...remedies.recent.map((r) => [r.at, r.kind, r.prNumber, r.cause, r.guard, r.checks.join(' '), r.summary]),
    [`The ${remedies.recent.length} most recent of ${remedies.accounts} accounts.`],
  ];
}
function Causes({ remedies, windowLabel }: { remedies: RemedyInsights; windowLabel: string }): JSX.Element {
  return (
    <>
      <p className="sp-sub">Causes, {windowLabel}</p>
      {remedies.accounts === 0 ? (
        <p className="empty">
          {remedies.unaccounted === 0
            ? 'Nothing has come back to a pull request in this window, so there is nothing to account for.'
            : `${remedies.unaccounted} dispatch${remedies.unaccounted === 1 ? '' : 'es'} answered a red or a review ` +
              'and none filed an account. Nothing here until one does.'}
        </p>
      ) : (
        <>
          <GuardSplit remedies={remedies} />
          <div className="sp-cols">
            {remedies.byKind.map((kind) => (
              <section className="sp-col" key={kind.kind}>
                <p className="sp-sub">{kind.kind === 'ci' ? 'CI, by cause' : 'Review, by cause'}</p>
                <CauseTable kind={kind} />
              </section>
            ))}
          </div>
          <p className="sp-sub">Lately</p>
          <Lately remedies={remedies} />
        </>
      )}
    </>
  );
}

function GuardSplit({ remedies }: { remedies: RemedyInsights }): JSX.Element {
  const total = remedies.accounts;
  return (
    <>
      <div
        className="sp-bar sp-well"
        role="img"
        aria-label={remedies.byGuard.map((g) => `${g.label} ${g.accounts}`).join(', ')}
      >
        {remedies.byGuard.map((g) => (
          <span
            key={g.guard}
            className="sg"
            style={{ width: `${share(g.accounts, total)}%`, background: `var(--rm-${g.guard})` }}
            title={`${g.label}: ${g.accounts} (${fmtShare(g.accounts, total)})`}
          />
        ))}
      </div>
      <table className="sp-tbl">
        <thead>
          <tr>
            <th>What would have caught it</th>
            <th className="n">Accounts</th>
            <th className="n">Share</th>
            <th className="n">Cost</th>
          </tr>
        </thead>
        <tbody>
          {remedies.byGuard.map((g) => (
            <tr key={g.guard}>
              <td>
                <span className="sw" style={{ background: `var(--rm-${g.guard})` }} />
                <span className="nm" title={g.blurb}>
                  {g.label}
                </span>
                <span className="bl">{g.blurb}</span>
              </td>
              <td className="n b">{g.accounts}</td>
              <td className="n">{fmtShare(g.accounts, total)}</td>
              <td className="n">{g.costUsd > 0 ? fmtUsd(g.costUsd) : <span className="dim">&mdash;</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* The denominator, said out loud rather than left to arithmetic. An account
          is not a red — one agent can answer four at once — so the two numbers on
          this panel that look subtractable are not. */}
      <p className="sp-note">
        {remedies.accounts} account{remedies.accounts === 1 ? '' : 's'}, {fmtUsd(remedies.costUsd)} between them
        {remedies.unaccounted > 0
          ? ` · ${remedies.unaccounted} further dispatch${remedies.unaccounted === 1 ? '' : 'es'} filed nothing`
          : ''}
      </p>
      <MethodNote>
        <p>
          <b>An account is one agent&rsquo;s reckoning of one return, not one red.</b> A run that settled four reds at
          once files one, so this never sums to the verdict counts above.
        </p>
        <p>
          <b>Money is the filing agent&rsquo;s spend inside the window</b>, divided evenly where it filed more than one.
          {remedies.unaccounted > 0
            ? ' Every share here is a share of what was reported rather than of what happened.'
            : ''}
        </p>
      </MethodNote>
    </>
  );
}

function CauseTable({ kind }: { kind: RemedyKindHealth }): JSX.Element {
  if (kind.accounts === 0) {
    return <p className="empty">Nothing has been accounted for here in this window.</p>;
  }
  const rows = [...kind.byCause].sort((a, b) => b.accounts - a.accounts || b.costUsd - a.costUsd);
  const checks = kind.kind === 'ci';
  return (
    <table className="sp-tbl wide">
      <thead>
        <tr>
          <th>Cause</th>
          <th className="n">Accounts</th>
          <th className="n">Cost</th>
          <th className="n">Undocumented</th>
          {/* Only for CI, and dropped rather than blanked: a review round has no
              check to name, and a column of em dashes under an empty header reads
              as data that failed to arrive. */}
          {checks && <th>Reddest check</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((c: RemedyCauseTotal) => (
          <tr key={c.cause} className={c.accounts === 0 ? 'dim' : undefined}>
            <td>
              <span className="nm" title={c.blurb}>
                {c.label}
              </span>
              <span className="bl">{c.blurb}</span>
            </td>
            <td className="n b">{c.accounts}</td>
            <td className="n">{c.costUsd > 0 ? fmtUsd(c.costUsd) : <span className="dim">&mdash;</span>}</td>
            {/* The actionable cell: how many of this cause were things nobody had
                written down. High here is a cause an operator can retire rather
                than merely watch. */}
            <td className="n">
              {c.undocumented > 0 ? `${c.undocumented} of ${c.accounts}` : <span className="dim">&mdash;</span>}
            </td>
            {checks && (
              <td>
                {c.topCheck === null ? (
                  <span className="dim">&mdash;</span>
                ) : (
                  <span className="mono" title={`named on ${c.topCheck.accounts} of these accounts`}>
                    {c.topCheck.name}
                  </span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Lately({ remedies }: { remedies: RemedyInsights }): JSX.Element {
  return (
    <div>
      {remedies.recent.map((r) => (
        <div className="rm-row" key={r.id}>
          <HeadRow align="baseline" className="rm-head">
            {/* The pull request as a ref, never as text — a row that names one and
                offers no way there is the cockpit's most repeated dead end. */}
            <Ref to={r.ref} />
            <Tag>{r.causeLabel.toLowerCase()}</Tag>
            <span className="tag rm-guard" style={{ color: `var(--rm-${r.guard})` }}>
              {r.guardLabel.toLowerCase()}
            </span>
            {r.checks.length > 0 && <span className="bl mono">{r.checks.join(', ')}</span>}
            <span className="rm-when">{relTime(r.at)}</span>
          </HeadRow>
          <div>{r.summary}</div>
        </div>
      ))}
      <p className="sp-note">
        The {remedies.recent.length} most recent of {remedies.accounts} &mdash; testimony, not a reading the harness
        took.
      </p>
    </div>
  );
}
