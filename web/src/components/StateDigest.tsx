import type { StateQuery } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

/**
 * The goal's state queries, as the plan sheet draws them: each declared query
 * with the presence query beside it and whatever the dry run read.
 *
 * Read-only, for {@link WatchDigest}'s reason — the plan is where these are
 * defined, and it is the sheet on the goal that puts one to an environment. A
 * query is not runnable anywhere until an operator has read it and accepted it
 * against that environment, so nothing here is a verdict about the data.
 *
 * **Nothing renders where nothing was declared.**
 *
 * @public embedded by the plan sheet, which owns its chrome
 */
export function StateDigest({ queries, refUrls }: { queries: StateQuery[]; refUrls: Record<string, string> }) {
  if (queries.length === 0) return null;
  return (
    <>
      <span className="pm-section-label">
        The data is right <i className="k">{queries.length === 1 ? '1 query' : `${queries.length} queries`}</i>
      </span>
      {queries.map((query) => (
        <div className={`pm-wrow ${query.dryRunVerdict ?? 'unread'}`} key={query.id}>
          <div>
            <div className="pm-vhead">
              <span className="pm-vtitle">{query.title}</span>
              <Tag>state</Tag>
              <Tag lower title="The author's own id, and the merge key on a replan">
                {query.id}
              </Tag>
              {query.authored === 'agent' && (
                <Tag tone="amber" title="Declared by the agent that did the work, from the diff it was holding">
                  declared at conclude
                </Tag>
              )}
            </div>
            <div className="pm-wbody">
              <div>
                <b>Query</b>
                <pre className="pm-wquery">{query.query}</pre>
              </div>
              <div>
                <b title="A second query, whose only job is to prove the rows exist to be asked about">Presence</b>
                <pre className="pm-wquery">{query.presence}</pre>
              </div>
              <div>
                <b>Dry run</b>
                <p className="pm-wexpect">{dryRun(query)}</p>
              </div>
            </div>
            {query.why !== null && <div className="pm-wwhy">{renderMarkdown(query.why, refUrls)}</div>}
          </div>
        </div>
      ))}
    </>
  );
}

function dryRun(query: StateQuery): string {
  if (query.dryRunVerdict === null) return 'Not put to an environment yet.';
  const where = query.dryRunEnvironment === null ? '' : ` against ${query.dryRunEnvironment}`;
  const rows = query.dryRunRows === null ? '' : ` — ${query.dryRunRows} row${query.dryRunRows === 1 ? '' : 's'}`;
  return `${query.dryRunVerdict}${where}${rows}.`;
}
