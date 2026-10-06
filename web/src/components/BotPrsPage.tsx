import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AssessedBotPr,
  BotPrOutcome,
  BotPrOutcomeKind,
  BotPrRiskLevel,
  BotPrRiskStanding,
  BotPrsPayload,
  UpdateKind,
} from '../types.js';
import { api } from '../api.js';
import { AsyncButton } from './AsyncButton.js';
import { ExtLink, relTime, timeLeft } from './util.js';
import { Tag, type TagTone } from './tag.js';

// → docs/spec/37-bot-prs.md#the-tab

const REFRESH_MS = 60_000;

const GROUPS: readonly { kind: UpdateKind; label: string; note: string }[] = [
  { kind: 'major', label: 'Major', note: 'Breaking by definition — read the changelog before these go in.' },
  { kind: 'minor', label: 'Minor', note: 'New features, nothing removed, if the package keeps to semver.' },
  { kind: 'patch', label: 'Patch', note: 'Fixes only. The ones a green build should be enough for.' },
  { kind: 'unknown', label: 'Unclassified', note: 'Neither the title nor the body named a version to compare.' },
];

const KIND_TONE: Record<UpdateKind, TagTone> = { major: 'red', minor: 'amber', patch: 'green', unknown: 'grey' };

const RISK_TONE: Record<BotPrRiskLevel, TagTone> = { low: 'green', medium: 'amber', high: 'red' };

const OUTCOME: Record<BotPrOutcomeKind, { label: string; tone: TagTone }> = {
  adapted: { label: 'adapted to it', tone: 'green' },
  'upstream-bug': { label: 'upstream bug', tone: 'red' },
  'intended-break': { label: 'needs a migration', tone: 'amber' },
  unclear: { label: 'unclear', tone: 'grey' },
};

const CI_TONE: Record<AssessedBotPr['ciStatus'], TagTone> = {
  passing: 'green',
  failing: 'red',
  pending: 'amber',
  unknown: 'grey',
};

export function BotPrsPage({ now }: { now: number }): JSX.Element {
  const { reading, failed, reload } = useBotPrs();

  if (failed && reading === null) {
    return <p className="empty">The bot pull requests could not be read. The rest of the cockpit is unaffected.</p>;
  }
  if (reading === null) return <p className="empty">Reading bot pull requests…</p>;

  if (!reading.configured) {
    return (
      <div className="bp">
        <Head />
        <p className="empty">
          No bot is named. Set <code>botPrs.authors</code> — regular expressions over the author, such as{' '}
          <code>^Renovate Bot$</code> — in <code>lubbdubb.project.json</code> and restart.
        </p>
      </div>
    );
  }

  const prs = reading.pullRequests;
  return (
    <div className="bp">
      <Head />
      <Summarise standing={reading.risk} now={now} reload={reload} />
      {reading.error !== null && (
        <p className="bp-error">
          The last read failed: {reading.error}.{' '}
          {reading.readAt === null
            ? 'Nothing has been read yet.'
            : `Showing what was read ${relTime(reading.readAt, now)}.`}
        </p>
      )}
      <Strip prs={prs} now={now} />
      {prs.length === 0 ? (
        <p className="empty">No open pull request is by a named bot.</p>
      ) : (
        GROUPS.map((group) => {
          const rows = prs.filter((pr) => pr.update.kind === group.kind);
          if (rows.length === 0) return null;
          return (
            <section key={group.kind} className="bp-group">
              <h3>
                <Tag tone={KIND_TONE[group.kind]} lower>
                  {group.label}
                </Tag>{' '}
                <span className="bp-n">{rows.length}</span>
              </h3>
              <p className="bp-note">{group.note}</p>
              {rows.map((pr) => (
                <Row key={pr.number} pr={pr} now={now} reload={reload} />
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}

function Head(): JSX.Element {
  return (
    <header className="bp-head">
      <h2>Bot PRs</h2>
      <p className="bp-blurb">
        Open pull requests raised by the bots <code>botPrs.authors</code> names, grouped by how big a jump each one is.
        Add yourself as an optional reviewer to take one on, so nobody else picks it up. An agent can read them for risk
        — advice only: the harness never approves or merges one.
      </p>
    </header>
  );
}

function Summarise({
  standing,
  now,
  reload,
}: {
  standing: BotPrRiskStanding;
  now: number;
  reload: () => void;
}): JSX.Element {
  const [said, setSaid] = useState<string | null>(null);
  const { run } = standing;
  const out = run !== null && run.status !== 'done';
  return (
    <div className="bp-summarise">
      <AsyncButton
        size="small"
        usage="bot-pr.create"
        disabled={out}
        title="Send one agent to read every classified pull request it has not read on its current head, up to 20, majors first"
        pendingLabel="Gathering…"
        onRefused={setSaid}
        onClick={async () => {
          setSaid(null);
          const { prs } = await api.summariseBotPrs();
          setSaid(`${prs} sent to be read. The verdicts appear here as the agent writes them.`);
          reload();
        }}
      >
        Summarise risk
      </AsyncButton>
      {out ? (
        <span>
          Reading {run.prs} now, {run.trigger === 'operator' ? 'as asked' : 'on schedule'} {relTime(run.createdAt, now)}
          .
        </span>
      ) : standing.nextRunAt !== null ? (
        <span>Next scheduled read {timeLeft(standing.nextRunAt, now)}.</span>
      ) : (
        <span>
          No schedule is set: <code>botPrs.riskSchedule</code> takes a cron expression.
        </span>
      )}
      {said !== null && <span>{said}</span>}
    </div>
  );
}

function Strip({ prs, now }: { prs: AssessedBotPr[]; now: number }): JSX.Element {
  const failing = prs.filter((pr) => pr.ciStatus === 'failing').length;
  const majors = prs.filter((pr) => pr.update.kind === 'major').length;
  const unclaimed = prs.filter((pr) => pr.reviewers.length === 0).length;
  const decide = prs.filter((pr) => awaitsDecision(pr)).length;
  const mine = prs.filter((pr) => pr.viewerReviewing).length;
  const oldest = prs
    .map((pr) => pr.createdAt)
    .filter((at): at is string => at !== null)
    .sort()[0];
  return (
    <div className="bp-strip">
      <span>
        <b>{prs.length}</b> open
      </span>
      {failing > 0 && <Tag tone="red">{failing} failing CI</Tag>}
      {majors > 0 && <Tag tone="amber">{majors} major</Tag>}
      {decide > 0 && <Tag tone="red">{decide} to close or take on</Tag>}
      {unclaimed > 0 && <Tag tone="grey">{unclaimed} nobody has taken</Tag>}
      {mine > 0 && <Tag tone="accent">{mine} yours</Tag>}
      {failing === 0 && majors === 0 && prs.length > 0 && <Tag tone="green">nothing needs you</Tag>}
      {oldest !== undefined && <span className="bp-oldest">oldest opened {relTime(oldest, now)}</span>}
    </div>
  );
}

function Row({ pr, now, reload }: { pr: AssessedBotPr; now: number; reload: () => void }): JSX.Element {
  const { from, to } = pr.update;
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <div className="bp-row">
      <div className="bp-main">
        <div className="bp-title">{pr.url === null ? pr.title : <ExtLink href={pr.url}>{pr.title}</ExtLink>}</div>
        <div className="bp-meta">
          <span>PR {pr.number}</span>
          <span>{pr.author}</span>
          {to !== null && <span className="bp-ver">{from === null ? `→ ${to}` : `${from} → ${to}`}</span>}
          {pr.createdAt !== null && <span>opened {relTime(pr.createdAt, now)}</span>}
        </div>
        <div className="bp-who">
          <span className="bp-who-l">Optional reviewers</span>
          {pr.reviewers.length === 0 ? (
            <span className="bp-nobody">nobody yet</span>
          ) : (
            pr.reviewers.map((person) => (
              <Tag key={person.id} tone="grey">
                {person.name}
              </Tag>
            ))
          )}
          {pr.viewerReviewing ? (
            <Tag tone="accent">you’re on it</Tag>
          ) : (
            <AsyncButton
              size="small"
              ghost
              usage="pr.edit"
              title="Add yourself as an optional reviewer, so the others can see it is taken"
              pendingLabel="Adding…"
              onRefused={setRefusal}
              onClick={async () => {
                setRefusal(null);
                await api.claimBotPr(pr.number);
                reload();
              }}
            >
              Add me
            </AsyncButton>
          )}
          {refusal !== null && <span className="bp-refusal">{refusal}</span>}
        </div>
        {pr.risk !== null && (
          <div className="bp-risk">
            <Tag tone={RISK_TONE[pr.risk.risk]} lower title="An agent's reading of this head: advice, not approval">
              {pr.risk.risk} risk
            </Tag>
            <span className="bp-risk-why">{pr.risk.summary}</span>
          </div>
        )}
        {pr.outcome !== null && <Outcome pr={pr} outcome={pr.outcome} reload={reload} />}
      </div>
      <Tag tone={CI_TONE[pr.ciStatus]} lower title="CI on the pull request's head">
        CI {pr.ciStatus}
      </Tag>
    </div>
  );
}

function awaitsDecision(pr: AssessedBotPr): boolean {
  return pr.outcome !== null && pr.outcome.outcome !== 'adapted' && pr.outcome.headSha === pr.headSha;
}

function Outcome({
  pr,
  outcome,
  reload,
}: {
  pr: AssessedBotPr;
  outcome: BotPrOutcome;
  reload: () => void;
}): JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);
  const { label, tone } = OUTCOME[outcome.outcome];
  const current = outcome.headSha === pr.headSha;
  return (
    <div className="bp-outcome">
      <Tag tone={current ? tone : 'grey'} lower title="What the agent fixing CI on this pull request found">
        {label}
      </Tag>
      <span className="bp-outcome-why">
        {outcome.summary}
        {outcome.fixedIn !== null && ` Fixed in ${outcome.fixedIn}.`}
        {!current && ' (on an earlier head)'}
      </span>
      {outcome.upstreamUrl !== null && <ExtLink href={outcome.upstreamUrl}>upstream</ExtLink>}
      {awaitsDecision(pr) && (
        <AsyncButton
          size="small"
          ghost
          usage="pr.edit"
          title="Close this pull request (abandon it on Azure DevOps). The bot leaves this version alone and raises the next one"
          pendingLabel="Closing…"
          onRefused={setRefusal}
          onClick={async () => {
            setRefusal(null);
            await api.closeBotPr(pr.number);
            reload();
          }}
        >
          Close and wait for the next
        </AsyncButton>
      )}
      {refusal !== null && <span className="bp-refusal">{refusal}</span>}
    </div>
  );
}

function useBotPrs(): { reading: BotPrsPayload | null; failed: boolean; reload: () => void } {
  const [reading, setReading] = useState<BotPrsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);

  const reload = useCallback((): void => {
    api.getBotPrs().then(
      (payload) => {
        if (!live.current) return;
        setReading(payload);
        setFailed(false);
      },
      () => {
        if (live.current) setFailed(true);
      },
    );
  }, []);

  useEffect(() => {
    live.current = true;
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [reload]);

  return { reading, failed, reload };
}
