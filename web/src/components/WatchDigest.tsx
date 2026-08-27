import type { GoalWatch, WatchReadingVerdict } from '../types.js';
import { renderMarkdown } from './markdown.js';

/**
 * The post-deploy watch, as the plan sheet draws it: each declared check with its
 * query, what it expects, and what the dry run read against the environment.
 *
 * Read-only, and on the sheet rather than beside the goal's own surfaces for
 * {@link ValidationDigest}'s reason: the plan is where these are *defined*, and
 * approving the plan is what authorises the query to be run against the
 * operator's telemetry with the operator's own credential.
 *
 * **Nothing renders where nothing was declared.** No empty card, no row of
 * question marks: a goal that declared no checks reads null, and null is a third
 * fact rather than a synonym for clean — a surface that folded the two would
 * report the whole fleet as verified.
 *
 * @public embedded by the plan sheet, which owns its chrome
 */
export function WatchDigest({ watches, refUrls }: { watches: GoalWatch[]; refUrls: Record<string, string> }) {
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
              <span className="chip small">{check.kind}</span>
              <span className="chip small mono" title="The author's own id, and the merge key on a replan">
                {check.id}
              </span>
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
                <p className="pm-wexpect">
                  {check.tolerate === 0
                    ? 'No matching rows at all.'
                    : `No more than ${check.tolerate} matching row${check.tolerate === 1 ? '' : 's'}.`}
                </p>
              </div>
            </div>
            {check.why && <div className="pm-wwhy">{renderMarkdown(check.why, refUrls)}</div>}
            <Reading check={check} />
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * What the environment said the one time it was asked.
 *
 * **An `unknown` says why in words, and never in the vocabulary of a clean one.**
 * A failed observation, a timeout, a result that came back without the id echo and
 * a presence query answering zero are all the watch failing to *read* the
 * environment — and only a reading that came back can say anything about the work.
 */
function Reading({ check }: { check: GoalWatch }) {
  if (check.dryRunVerdict === null || check.dryRunEnvironment === null)
    return (
      <p className="pm-wread muted small">
        Not yet put to an environment. Nothing has been read, which is not the same as nothing being wrong.
      </p>
    );
  return (
    <p className={`pm-wread ${check.dryRunVerdict}`}>
      <b>{check.dryRunEnvironment}</b> · {readingWords(check.dryRunVerdict, check.dryRunRows)}
      {check.dryRunDetail !== null && <span className="pm-wdetail"> — {check.dryRunDetail}</span>}
    </p>
  );
}

/** The three readings in the operator's words. `unknown` is never phrased as an absence of trouble. */
function readingWords(verdict: WatchReadingVerdict, rows: number | null): string {
  if (verdict === 'unknown') return 'the watch could not read this environment';
  if (verdict === 'zero') return 'the query resolved and matched nothing';
  return rows === null
    ? 'the query is live and matching'
    : `the query is live and matched ${String(rows)} row${rows === 1 ? '' : 's'}`;
}
