import { useState } from 'react';
import type { LessonView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import { relTime } from './util.js';
import { Ref } from './refs.js';

/**
 * What the fleet has learned about working this repository — and the gate in
 * front of it (issue #355).
 *
 * The panel is not a nicety on the lesson store; it is the half that makes the
 * other half safe. A store of assertions with no surface to read them on can
 * only be pruned by someone who already knows what is in it, and the failure
 * this whole feature has to avoid is a block of forty stale lines nobody has
 * read, silently making every agent worse, with no test able to see it. So the
 * three sections below are the three questions an operator can be asked here:
 * *what wants a decision*, *what is vouched for*, and *what did we stop
 * believing*.
 *
 * **Promotion is the only thing that puts a claim in front of an agent**, and
 * since #27 phase 3 it does so through the knowledge base: a promoted lesson is
 * mirrored in as an injected fleet claim, and *that* is what the fleet's
 * system-prompt block renders, newest-vouched first, up to a character cap. One
 * block is delivered, so the `sent to agents` chip below is the knowledge block's
 * own answer read back through the fact this lesson became — never a second
 * rendering of this table, which would be a chip about a row nobody sends.
 *
 * The drop is why the chip exists at all. It is visible here and on the Knowledge
 * page and nowhere else; retiring a promoted lesson is one of the two ways to make
 * room for one that is over the cap.
 */
export function LessonsSection({
  lessons,
  now,
  refUrls,
  onPropose,
  onPromote,
  onRetire,
}: {
  lessons: LessonView[];
  now: number;
  refUrls: Record<string, string>;
  onPropose: (text: string, originRef: string | null) => Promise<unknown>;
  onPromote: (id: string) => Promise<unknown> | unknown;
  onRetire: (id: string) => Promise<unknown> | unknown;
}) {
  // Proposals first — they are the ones waiting on the reader. Then what is
  // vouched for, which is the list that would be rendered, so its length is the
  // number an operator is really managing. Then the retired tail, drawn rather
  // than dropped: "we stopped believing this" is information, and a row that
  // vanished on being pruned would make the surface look lossy.
  const proposed = lessons.filter((l) => l.status === 'proposed');
  const promoted = lessons.filter((l) => l.status === 'promoted');
  const retired = lessons.filter((l) => l.status === 'retired');
  return (
    <div className="lessons">
      <LessonComposer onPropose={onPropose} />
      <p className="muted small lesson-note">
        A lesson is about <em>working</em> this repository — what the suite needs first, where a subsystem&rsquo;s tests
        sit, which kind of ticket always arrives under-specified. A fact about the code belongs in the
        repository&rsquo;s own docs; a defect belongs in Findings; something true only of one goal belongs on that
        goal&rsquo;s notepad and dies with it.
      </p>
      <LessonSection
        title="Proposed"
        blurb="Written down and read by nobody else. Promote one to vouch for it."
        lessons={proposed}
        now={now}
        refUrls={refUrls}
        onPromote={onPromote}
        onRetire={onRetire}
      />
      <LessonSection
        title="Promoted"
        blurb="Vouched for, and appended to every agent's system prompt at its next launch — newest promotion first, until the character cap is spent. What is over the cap is marked below and reaches nobody; retire something to make room."
        lessons={promoted}
        now={now}
        refUrls={refUrls}
        onPromote={onPromote}
        onRetire={onRetire}
      />
      <LessonSection
        title="Retired"
        blurb="Pruned, and kept visible so the list you are reading is the whole list."
        lessons={retired}
        now={now}
        refUrls={refUrls}
        onPromote={onPromote}
        onRetire={onRetire}
      />
    </div>
  );
}

/**
 * Writing one down. Two fields, and the second is the provenance: the goal it
 * was learned on, which is what lets a reader in six months date the claim
 * against the repository it is about. Optional, because an operator writing down
 * what they already know has no goal behind it — and a defaulted one would date
 * the lesson to work that did not teach it.
 *
 * A failed post keeps the text, the one outcome worth writing code to prevent.
 */
function LessonComposer({ onPropose }: { onPropose: (text: string, originRef: string | null) => Promise<unknown> }) {
  const [text, setText] = useState('');
  const [goal, setGoal] = useState('');
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (text.trim().length === 0) return;
    setFailed(false);
    try {
      // Typed as `41` or `issue:41`; the harness's colon form is what every ref
      // in the cockpit is, so the bare number is normalised into one here rather
      // than stored as a second spelling nothing can link.
      const number = /^#?(\d+)$/.exec(goal.trim())?.[1];
      const ref = goal.trim() === '' ? null : number ? `issue:${number}` : goal.trim();
      await onPropose(text.trim(), ref);
      setText('');
      setGoal('');
    } catch (err) {
      setFailed(true);
      // Rethrown so the button flashes its own error ring, as everywhere else:
      // swallowing it would leave the control reporting a success the line
      // below denies.
      throw err;
    }
  }

  return (
    <div className="lesson-compose">
      <label className="rb-label" htmlFor="lesson-text">
        What did working this repository teach?
      </label>
      <textarea
        id="lesson-text"
        className="rb-text"
        rows={3}
        value={text}
        placeholder="The web bundle has to be built before the suite passes — `npm run build:web` first, or the console tests fail on a stale dist."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter submits, matching every other composer in the cockpit.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="lesson-compose-foot">
        <label className="muted small" htmlFor="lesson-goal">
          Learned on
        </label>
        <input
          id="lesson-goal"
          className="lesson-goal"
          value={goal}
          placeholder="issue:41 — optional"
          onChange={(e) => setGoal(e.target.value)}
        />
        <span className="spacer" />
        <AsyncButton className="primary" disabled={text.trim().length === 0} onClick={submit}>
          Write it down
        </AsyncButton>
      </div>
      {failed && (
        <p className="launch-error" role="alert">
          That didn&rsquo;t go through. Your text is still here — try again.
        </p>
      )}
    </div>
  );
}

function LessonSection({
  title,
  blurb,
  lessons,
  now,
  refUrls,
  onPromote,
  onRetire,
}: {
  title: string;
  blurb: string;
  lessons: LessonView[];
  now: number;
  refUrls: Record<string, string>;
  onPromote: (id: string) => Promise<unknown> | unknown;
  onRetire: (id: string) => Promise<unknown> | unknown;
}) {
  return (
    <section className="lesson-section">
      <h3 className="lesson-head">
        {title} <span className="muted small">· {lessons.length}</span>
      </h3>
      <p className="muted small">{blurb}</p>
      {lessons.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        lessons.map((lesson) => (
          <LessonCard
            key={lesson.id}
            lesson={lesson}
            now={now}
            refUrls={refUrls}
            onPromote={onPromote}
            onRetire={onRetire}
          />
        ))
      )}
    </section>
  );
}

function LessonCard({
  lesson,
  now,
  refUrls,
  onPromote,
  onRetire,
}: {
  lesson: LessonView;
  now: number;
  refUrls: Record<string, string>;
  onPromote: (id: string) => Promise<unknown> | unknown;
  onRetire: (id: string) => Promise<unknown> | unknown;
}) {
  const retired = lesson.status === 'retired';
  return (
    <div className={`lesson-card${retired ? ' resolved' : ''}`}>
      {/* Markdown, and handed the ref map so an issue named inside the sentence
          is still a way there — the same treatment a finding's detail gets. The
          renderer emits React children, so nothing in it is executable. */}
      <div className="lesson-text">{renderMarkdown(lesson.text, refUrls)}</div>
      <div className="lesson-foot">
        {/* Provenance, always and on every card. Which goal taught it and when
            are the two things a reader needs to judge whether it still holds,
            and they are exactly what a rendered block of assertions strips. */}
        <span className="muted">
          {lesson.originRef ? (
            <>
              learned on <Ref to={lesson.originRef} />
            </>
          ) : (
            'not learned on a goal'
          )}{' '}
          · {relTime(lesson.createdAt, now)}
        </span>
        {/* Whether agents are getting this one. Per row rather than as a count,
            because "two are over the cap" leaves the operator to work out which
            two before they can retire anything — and the drop is the one thing
            here that is invisible to the agent by design. */}
        {lesson.status === 'promoted' &&
          (lesson.rendered ? (
            <span className="chip small ok" title="In the block every agent reads at its next launch">
              sent to agents
            </span>
          ) : (
            <span
              className="chip small warn"
              title="Over the block's character cap, so no agent sees it. Retire an older promoted lesson to make room."
            >
              over the cap
            </span>
          ))}
        <span className="lesson-actions">
          {lesson.status === 'proposed' && (
            <AsyncButton
              className="ghost"
              onClick={() => onPromote(lesson.id)}
              title="Vouch for this — it joins the block every agent reads at its next launch"
            >
              Promote
            </AsyncButton>
          )}
          {/* Two-step, because retiring is the only irreversible act here: a
              retired lesson is not promoted back, it is written again. */}
          {!retired && (
            <ConfirmButton
              className="ghost"
              label="Retire"
              confirmLabel="Retire it?"
              title="Stop believing this. It stays in the list, muted, and cannot be promoted again"
              onConfirm={() => onRetire(lesson.id)}
            />
          )}
        </span>
      </div>
    </div>
  );
}
