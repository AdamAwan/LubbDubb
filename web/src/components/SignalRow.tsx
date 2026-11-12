import type { GoalWatch, WatchSourceDeclaration } from '../types.js';
import { ConfirmButton } from './ConfirmButton.js';
import { expectation, WatchReadingLine } from './WatchDigest.js';
import { renderMarkdown } from './markdown.js';
import { HeadRow } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';
import { WatchSourceChip } from './WatchSourceChip.js';
import { AuthorChips } from './AssessorWatch.js';
import { isProposed } from '../view/watchChecks.js';

// → docs/spec/17-cockpit.md

/**
 * One declared check on the Signals card: what it asks, what its dry run read, and edit and delete. Where
 * the assessor said it departs from the plan's hint, its words are drawn under the query.
 *
 * @public drawn by the Signals card
 */
export function SignalRow({
  check,
  waitingOnYou,
  sources,
  refUrls,
  onEdit,
  onDelete,
}: {
  check: GoalWatch;
  /** Its baseline is asked of a person, who has not answered yet. */
  waitingOnYou: boolean;
  sources: WatchSourceDeclaration[];
  refUrls: Record<string, string>;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const tone = isProposed(check) ? 'pending' : (check.dryRunVerdict ?? 'unread');
  return (
    <div className={`cn-sig-row ${tone}`}>
      <span className="cn-sig-stripe" />
      <div className="cn-sig-body">
        <HeadRow className="cn-sig-head">
          <b className="cn-name">{check.title}</b>
          <Tag>{check.kind}</Tag>
          <WatchSourceChip source={check.source} sources={sources} />
          <Tag lower title="The author’s own id, and the merge key every writer folds on">
            {check.id}
          </Tag>
          <AuthorChips check={check} />
          {waitingOnYou && (
            <Tag
              tone="amber"
              fill
              title="Only a person can run this source: its baseline is asked of you under Needs you"
            >
              waiting on you
            </Tag>
          )}
        </HeadRow>
        <p className="cn-sig-expect">{expectation(check)}</p>
        <pre className="cn-sig-query">{check.query}</pre>
        {check.presence !== null && (
          <pre className="cn-sig-query" title="The second query, whose only job is to prove the code path runs at all">
            {check.presence}
          </pre>
        )}
        {check.why !== null && <div className="cn-sig-why">{renderMarkdown(check.why, refUrls)}</div>}
        {check.changedFromHint !== null && <p className="cn-sig-expect">{check.changedFromHint}</p>}
        <WatchReadingLine check={check} className="cn-sig-read" />
      </div>
      <div className="cn-sig-ctrls">
        <Button usage="watch.expand" onClick={onEdit}>
          Edit
        </Button>
        <ConfirmButton
          usage="watch.waive"
          label="Delete"
          confirmLabel="Delete it"
          title="Drop this check and the readings taken against it. A check the plan declares comes back on the next replan."
          onConfirm={onDelete}
        />
      </div>
    </div>
  );
}
