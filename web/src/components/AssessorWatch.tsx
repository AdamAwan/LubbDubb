import { useState } from 'react';
import type { GoalWatch, WatchPlanRecord } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set

/**
 * The assessor's watch, above the rows it wrote: its `note`, and the two answers to a proposed set. An
 * empty watch says why nothing is watched, so null is never left unsaid.
 *
 * @public embedded by the Signals card
 */
export function AssessorWatch({
  record,
  proposed,
  refUrls,
  onAccept,
  onSendBack,
}: {
  record: WatchPlanRecord | null;
  proposed: number;
  refUrls: Record<string, string>;
  onAccept: () => Promise<void>;
  onSendBack: (words: string) => Promise<void>;
}) {
  const [words, setWords] = useState<string | null>(null);
  if (record === null) return null;
  if (record.authoredAt === null)
    return record.sentBackAt === null ? null : (
      <div className="cn-sheet-gate">
        <span className="cn-sub">
          Sent back — <i>{record.sentBackWords}</i>. An agent is writing it again with your words.
        </span>
      </div>
    );
  const waiting = record.acceptedAt === null;
  if (!waiting && record.emptyReason === null) return null;
  return (
    <div className="cn-sheet-gate">
      <div className="cn-sig-body">
        <b>{headline(waiting, proposed)}</b>
        {record.emptyReason !== null && <p className="cn-sig-expect">{record.emptyReason}</p>}
        {waiting && record.note !== null && <div className="cn-sig-why">{renderMarkdown(record.note, refUrls)}</div>}
        {words !== null && (
          <textarea
            className="cn-in cn-sig-area"
            rows={2}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            placeholder="What the next author should do differently"
          />
        )}
      </div>
      {waiting && <Answers words={words} setWords={setWords} onAccept={onAccept} onSendBack={onSendBack} />}
    </div>
  );
}

function headline(waiting: boolean, proposed: number): string {
  if (!waiting) return 'Nothing to watch';
  if (proposed === 0) return 'The assessor declared nothing to watch';
  return `The assessor wrote ${proposed === 1 ? 'one check' : `${proposed} checks`} — nothing runs until you accept`;
}

function Answers({
  words,
  setWords,
  onAccept,
  onSendBack,
}: {
  words: string | null;
  setWords: (words: string | null) => void;
  onAccept: () => Promise<void>;
  onSendBack: (words: string) => Promise<void>;
}) {
  if (words === null)
    return (
      <div className="cn-sig-ctrls">
        <AsyncButton
          usage="watch.accept"
          onClick={onAccept}
          title="The checks go live together and run on a schedule against your telemetry, with your credential, once this arrives."
        >
          Accept
        </AsyncButton>
        <Button usage="watch.expand" onClick={() => setWords('')}>
          Send back
        </Button>
      </div>
    );
  return (
    <div className="cn-sig-ctrls">
      <AsyncButton
        usage="watch.reject"
        disabled={words.trim() === ''}
        onClick={async () => {
          await onSendBack(words.trim());
          setWords(null);
        }}
      >
        Send back
      </AsyncButton>
      <Button usage="watch.expand" onClick={() => setWords(null)}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * Who wrote a check and where it stands: the operator's own, an agent's pending declaration, the
 * assessor's proposed set, and where the assessor said a check departs from the plan's hint.
 *
 * @public drawn in each Signals row's head
 */
export function AuthorChips({ check }: { check: GoalWatch }) {
  const proposed = !check.live && check.authored === 'assessor';
  return (
    <>
      {check.authored === 'operator' && (
        <Tag title="Yours. A replan neither removes this nor writes over it.">yours</Tag>
      )}
      {!check.live && !proposed && (
        <Tag tone="amber" fill title="Declared by the agent that did the work, and not yet run">
          awaiting you
        </Tag>
      )}
      {proposed && (
        <Tag tone="amber" fill title="Written by the assessor; it runs once the set is accepted">
          proposed
        </Tag>
      )}
      {check.changedFromHint !== null && (
        <Tag tone="violet" title={check.changedFromHint}>
          changed from plan
        </Tag>
      )}
    </>
  );
}
