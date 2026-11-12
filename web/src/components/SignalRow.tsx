import type { GoalWatch, WatchSourceDeclaration } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { expectation, WatchReadingLine } from './WatchDigest.js';
import { renderMarkdown } from './markdown.js';
import { HeadRow } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';
import { WatchSourceChip } from './WatchSourceChip.js';
import { AuthorChips } from './AssessorWatch.js';

// → docs/spec/17-cockpit.md

/**
 * One declared check on the Signals card: what it asks, what its dry run read, and the controls that
 * fit where it stands — edit and delete for a live or proposed check, a ruling for an agent's pending one.
 *
 * @public drawn by the Signals card
 */
export function SignalRow({
  check,
  sources,
  refUrls,
  onEdit,
  onDelete,
  onRule,
}: {
  check: GoalWatch;
  sources: WatchSourceDeclaration[];
  refUrls: Record<string, string>;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  onRule: (checkId: string, accept: boolean) => Promise<void>;
}) {
  const proposed = !check.live && check.authored === 'assessor';
  const tone = !check.live ? 'pending' : (check.dryRunVerdict ?? 'unread');
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
        {check.live || proposed ? (
          <WatchReadingLine check={check} className="cn-sig-read" />
        ) : (
          <p className="cn-sig-read">
            {check.proposal?.note ?? 'Declared by an agent.'} Nothing has been run: accepting is what puts this query to
            an environment.
          </p>
        )}
      </div>
      {check.live || proposed ? (
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
      ) : (
        <div className="cn-sig-ctrls">
          <AsyncButton usage="watch.accept" onClick={() => onRule(check.id, true)}>
            Accept &amp; run
          </AsyncButton>
          <AsyncButton usage="watch.reject" onClick={() => onRule(check.id, false)}>
            Decline
          </AsyncButton>
        </div>
      )}
    </div>
  );
}
