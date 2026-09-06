import type { GoalWatch, GoalWatchInput, WatchReadingVerdict } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

/**
 * The post-deploy watch, as the plan sheet draws it: each declared check with its
 * query, what it expects, and what the dry run read against the environment.
 *
 * Read-only, and on the sheet rather than beside the goal's own surfaces for
 * {@link ValidationDigest}'s reason: the plan is where these are *defined*, and
 * approving the plan is what authorises the query to be run against the
 * operator's telemetry with the operator's own credential.
 *
 * **The one control here is the ruling on an agent's declaration**, and it is the
 * same argument from the other end. A check `watch_declare` wrote arrived after
 * the approval, so it draws as a pending change with accept and decline beside
 * it — nothing has been put to an environment, and accepting is what does it.
 *
 * **Nothing renders where nothing was declared.** No empty card, no row of
 * question marks: a goal that declared no checks reads null, and null is a third
 * fact rather than a synonym for clean — a surface that folded the two would
 * report the whole fleet as verified.
 *
 * @public embedded by the plan sheet, which owns its chrome
 */
export function WatchDigest({
  watches,
  refUrls,
  onRule,
}: {
  watches: GoalWatch[];
  refUrls: Record<string, string>;
  onRule: ((checkId: string, accept: boolean) => void) | null;
}) {
  if (watches.length === 0) return null;
  return (
    <>
      <span className="pm-section-label">
        After it ships <i className="k">{watches.length === 1 ? '1 check' : `${watches.length} checks`}</i>
      </span>
      {watches.map((check) => (
        <div className={`pm-wrow ${check.live ? (check.dryRunVerdict ?? 'unread') : 'unread'}`} key={check.id}>
          <div>
            <div className="pm-vhead">
              <span className="pm-vtitle">{check.title}</span>
              <Tag>{check.kind}</Tag>
              <Tag lower title="The author's own id, and the merge key on a replan">
                {check.id}
              </Tag>
              {!check.live && (
                <Tag tone="amber" title="Declared by the agent that did the work, and not yet run">
                  awaiting you
                </Tag>
              )}
            </div>
            <div className="pm-wbody">
              <div>
                <b>Query</b>
                <pre className="pm-wquery">{check.query}</pre>
              </div>
              {check.presence !== null && (
                <div>
                  <b title="A second query, whose only job is to prove the code path runs at all">Presence</b>
                  <pre className="pm-wquery">{check.presence}</pre>
                </div>
              )}
              <div>
                <b>Expect</b>
                <p className="pm-wexpect">{expectation(check)}</p>
              </div>
            </div>
            {check.why && <div className="pm-wwhy">{renderMarkdown(check.why, refUrls)}</div>}
            {check.live && <WatchReadingLine check={check} />}
            <Pending check={check} onRule={onRule} />
          </div>
        </div>
      ))}
    </>
  );
}

export function expectation(check: GoalWatchInput & { baselineValue?: number | null }): string {
  if (check.kind !== 'measure')
    return check.tolerate === 0
      ? 'No matching rows at all.'
      : `No more than ${check.tolerate} matching row${check.tolerate === 1 ? '' : 's'}.`;
  const unit = check.unit === null ? '' : ` ${check.unit}`;
  const parts: string[] = [];
  if (check.expectUnder !== null) parts.push(`under ${check.expectUnder}${unit}`);
  if (check.expectOver !== null) parts.push(`over ${check.expectOver}${unit}`);
  if (check.expectBaseline) {
    const before = check.baselineValue;
    parts.push(
      before === null || before === undefined
        ? 'no worse than its baseline (not taken yet)'
        : `no worse than the ${before}${unit} read before the work arrived`,
    );
  }
  return `${parts.join(', and ')}.`;
}

export function WatchReadingLine({ check, className = 'pm-wread' }: { check: GoalWatch; className?: string }) {
  if (check.dryRunVerdict === null || check.dryRunEnvironment === null)
    return (
      <p className={`${className} muted small`}>
        Not yet put to an environment. Nothing has been read, which is not the same as nothing being wrong.
      </p>
    );
  return (
    <p className={`${className} ${check.dryRunVerdict}`}>
      <b>{check.dryRunEnvironment}</b> · {readingWords(check.dryRunVerdict, check.dryRunRows, check.baselineValue)}
      {check.dryRunDetail !== null && <span className="pm-wdetail"> — {check.dryRunDetail}</span>}
    </p>
  );
}

function Pending({ check, onRule }: { check: GoalWatch; onRule: ((id: string, accept: boolean) => void) | null }) {
  const proposal = check.proposal;
  if (proposal === null) return null;
  const declaration = proposal.declaration;
  return (
    <div className="pm-wpending">
      <b>
        {check.live ? 'Pending change, from the agent that did the work' : 'Declared by the agent that did the work'}
      </b>
      <p className="pm-wdetail">{proposal.note}</p>
      {check.live && (
        <>
          <pre className="pm-wquery">{declaration.query}</pre>
          {declaration.presence !== null && <pre className="pm-wquery">{declaration.presence}</pre>}
          <p className="pm-wexpect">{expectation(declaration)}</p>
        </>
      )}
      <p className="pm-wdetail">
        Nothing here has been run. Accepting puts it to an environment once — with your credential, which is why it is
        asked — and, for a measure, takes the baseline it is compared against.
      </p>
      {onRule !== null && (
        <div className="pm-wrule">
          <Button size="small" onClick={() => onRule(check.id, true)}>
            Accept
          </Button>
          <Button ghost size="small" onClick={() => onRule(check.id, false)}>
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}

function readingWords(verdict: WatchReadingVerdict, rows: number | null, baseline: number | null): string {
  if (verdict === 'unknown') return 'the watch could not read this environment';
  if (verdict === 'zero') return 'the query resolved and matched nothing';
  if (baseline !== null) return `the query is live and read ${baseline}, which is the baseline`;
  return rows === null
    ? 'the query is live and matching'
    : `the query is live and matched ${String(rows)} row${rows === 1 ? '' : 's'}`;
}
