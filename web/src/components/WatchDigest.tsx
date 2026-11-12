import type { GoalWatch, GoalWatchInput, WatchReadingVerdict, WatchSourceDeclaration } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { Tag } from './tag.js';
import { WatchSourceChip } from './WatchSourceChip.js';

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
 * The assessor's set, written after the merge, is accepted on the goal's own
 * page, not here: a proposed check draws its dry run like any other.
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
  sources,
  refUrls,
}: {
  watches: GoalWatch[];
  /** The deployment's watch sources. Without them only a check that names its source draws one, by name. */
  sources?: WatchSourceDeclaration[];
  refUrls: Record<string, string>;
}) {
  if (watches.length === 0) return null;
  return (
    <>
      <span className="pm-section-label">
        After it ships <i className="k">{watches.length === 1 ? '1 check' : `${watches.length} checks`}</i>
      </span>
      {watches.map((check) => (
        <div className={`pm-wrow ${check.dryRunVerdict ?? 'unread'}`} key={check.id}>
          <div>
            <div className="pm-vhead">
              <span className="pm-vtitle">{check.title}</span>
              <Tag>{check.kind}</Tag>
              {sources !== undefined ? (
                <WatchSourceChip source={check.source} sources={sources} />
              ) : (
                check.source !== null && <Tag lower>{check.source}</Tag>
              )}
              <Tag lower title="The author's own id, and the merge key on a replan">
                {check.id}
              </Tag>
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
            <WatchReadingLine check={check} />
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

function readingWords(verdict: WatchReadingVerdict, rows: number | null, baseline: number | null): string {
  if (verdict === 'unknown') return 'the watch could not read this environment';
  if (verdict === 'zero') return 'the query resolved and matched nothing';
  if (baseline !== null) return `the query is live and read ${baseline}, which is the baseline`;
  return rows === null
    ? 'the query is live and matching'
    : `the query is live and matched ${String(rows)} row${rows === 1 ? '' : 's'}`;
}
