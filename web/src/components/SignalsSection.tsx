import { useState } from 'react';
import type { GoalWatch, GoalWatchDeclaration, GoalWatchKind } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { expectation, WatchReadingLine } from './WatchDigest.js';
import { renderMarkdown } from './markdown.js';
import { HeadRow } from './panel.js';
import { Button } from './button.js';

/**
 * The goal's declared checks, on the goal's own page, with the controls that
 * change them.
 *
 * The plan sheet draws the same declarations read-only, and that is not a
 * duplicate surface: the sheet is where the plan's whole document is reviewed at
 * approval time, and this is where a live goal is operated weeks later. The
 * declaration is the only thing on the sheet that a person is still meant to act
 * on after it is approved — a query that turned out to name the wrong operation
 * is wrong for as long as it stands, and the plan is not being re-opened.
 *
 * **A saved check runs against an environment in the same call**, exactly as
 * accepting an agent's declaration does, and the refusals it comes back with are
 * drawn on the form that caused them. That is what stops the surface being a place
 * to write queries nobody has proved resolve.
 *
 * @public embedded by the goal page, which owns its chrome
 */
export function SignalsSection({
  signals,
  refUrls,
  onSave,
  onDelete,
  onRule,
}: {
  /** Every check on this goal, an agent's unruled declaration included, in the store's order. */
  signals: GoalWatch[];
  refUrls: Record<string, string>;
  /** Write one check. Answers with what the dry run refused, which is empty on a clean one. */
  onSave: (check: GoalWatchDeclaration) => Promise<string[]>;
  onDelete: (checkId: string) => Promise<void>;
  /** The ruling on a check an agent declared — the same control the plan sheet carries. */
  onRule: (checkId: string, accept: boolean) => Promise<void>;
}) {
  // One at a time, and the same slot for both: `null` is nothing open, a check id
  // is that row being edited, and a kind is a new check of that kind. Two pieces
  // of state would be free to disagree and draw two forms.
  const [open, setOpen] = useState<string | GoalWatchKind | null>(null);
  const taken = new Set(signals.map((c) => c.id));

  return (
    <div className="cn-sig">
      {signals.map((check) =>
        open === check.id ? (
          <CheckForm
            key={check.id}
            initial={check}
            taken={taken}
            onSave={onSave}
            onClose={() => setOpen(null)}
            onDelete={() => onDelete(check.id)}
          />
        ) : (
          <SignalRow
            key={check.id}
            check={check}
            refUrls={refUrls}
            onEdit={() => setOpen(check.id)}
            onDelete={() => onDelete(check.id)}
            onRule={onRule}
          />
        ),
      )}
      {(open === 'signal' || open === 'measure') && (
        <CheckForm kind={open} taken={taken} onSave={onSave} onClose={() => setOpen(null)} onDelete={null} />
      )}
      <div className="cn-sig-add">
        <Button
          family="console"
          onClick={() => setOpen('signal')}
          title="Something that should not be happening: an exception, a failure, a retry. Needs a second query proving the code path runs."
        >
          Add a signal
        </Button>
        <Button
          family="console"
          onClick={() => setOpen('measure')}
          title="One number: a percentile, a rate, a duration. Needs a threshold, or the baseline it is compared against."
        >
          Add a measure
        </Button>
        <span className="cn-sub">
          Saving puts the query to an environment once, with your credential — which is why it is asked.
        </span>
      </div>
    </div>
  );
}

/** One check at rest: what it asks, what it expects, and what the dry run read. */
function SignalRow({
  check,
  refUrls,
  onEdit,
  onDelete,
  onRule,
}: {
  check: GoalWatch;
  refUrls: Record<string, string>;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  onRule: (checkId: string, accept: boolean) => Promise<void>;
}) {
  // A row awaiting a ruling is toned by that rather than by a verdict: nothing has
  // been put to an environment, so `unread` would say the same thing about it as
  // about a live check nobody has run, and only one of those is somebody's to answer.
  const tone = !check.live ? 'pending' : (check.dryRunVerdict ?? 'unread');
  return (
    <div className={`cn-sig-row ${tone}`}>
      <span className="cn-sig-stripe" />
      <div className="cn-sig-body">
        <HeadRow className="cn-sig-head">
          <b className="cn-name">{check.title}</b>
          <i className="cn-chip">{check.kind}</i>
          <i className="cn-chip cn-lower" title="The author’s own id, and the merge key every writer folds on">
            {check.id}
          </i>
          {check.authored === 'operator' && (
            <i className="cn-chip cn-mute" title="Yours. A replan neither removes this nor writes over it.">
              yours
            </i>
          )}
          {!check.live && (
            <i className="cn-chip cn-warn" title="Declared by the agent that did the work, and not yet run">
              awaiting you
            </i>
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
        {check.live ? (
          <WatchReadingLine check={check} className="cn-sig-read" />
        ) : (
          <p className="cn-sig-read">
            {check.proposal?.note ?? 'Declared by an agent.'} Nothing has been run: accepting is what puts this query to
            an environment.
          </p>
        )}
      </div>
      <div className="cn-sig-ctrls">
        {check.live ? (
          <Button family="console" onClick={onEdit}>
            Edit
          </Button>
        ) : (
          <AsyncButton family="console" onClick={() => onRule(check.id, true)}>
            Accept &amp; run
          </AsyncButton>
        )}
        {check.live ? (
          <ConfirmButton
            family="console"
            label="Delete"
            confirmLabel="Delete it"
            title="Drop this check and the readings taken against it. A check the plan declares comes back on the next replan."
            onConfirm={onDelete}
          />
        ) : (
          <AsyncButton family="console" onClick={() => onRule(check.id, false)}>
            Decline
          </AsyncButton>
        )}
      </div>
    </div>
  );
}

/** The form's own state: every field a string, because that is what an input holds. */
interface Draft {
  kind: GoalWatchKind;
  id: string;
  title: string;
  query: string;
  presence: string;
  tolerate: string;
  under: string;
  over: string;
  baseline: boolean;
  unit: string;
  why: string;
}

function draftOf(check: GoalWatch): Draft {
  return {
    kind: check.kind,
    id: check.id,
    title: check.title,
    query: check.query,
    presence: check.presence ?? '',
    tolerate: String(check.tolerate),
    under: check.expectUnder === null ? '' : String(check.expectUnder),
    over: check.expectOver === null ? '' : String(check.expectOver),
    baseline: check.expectBaseline,
    unit: check.unit ?? '',
    why: check.why ?? '',
  };
}

function blankDraft(kind: GoalWatchKind): Draft {
  return {
    kind,
    id: '',
    title: '',
    query: '',
    presence: '',
    tolerate: '0',
    under: '',
    over: '',
    baseline: kind === 'measure',
    unit: '',
    why: '',
  };
}

/**
 * Writing one check.
 *
 * **The form states its own refusals before the server does**, and they are the
 * server's own rules said in the operator's words — a signal without a presence
 * query and a measure with nothing that could fail it are both refused by
 * `WatchCheckSchema`, and a form that let them be submitted would answer a click
 * with a 400 the operator has to translate. It is not a second opinion: what it
 * cannot know is whether the query resolves, which is what the dry run answers on
 * the way back.
 */
function CheckForm({
  initial,
  kind,
  taken,
  onSave,
  onClose,
  onDelete,
}: {
  /** The check being edited, or absent for a new one. */
  initial?: GoalWatch;
  /** The kind a new check is being written under. Read only where {@link initial} is absent. */
  kind?: GoalWatchKind;
  /** Every id the goal already carries — a new check may not take one. */
  taken: Set<string>;
  onSave: (check: GoalWatchDeclaration) => Promise<string[]>;
  onClose: () => void;
  /** Absent on a new check, which has nothing to delete. */
  onDelete: (() => Promise<void>) | null;
}) {
  const [draft, setDraft] = useState<Draft>(initial === undefined ? blankDraft(kind ?? 'signal') : draftOf(initial));
  // What came back from the dry run, kept until the next save: a query that
  // resolved against nothing is the failure this subsystem is least able to
  // notice later, and the form is where it is cheap to see.
  const [refusals, setRefusals] = useState<string[]>([]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const refusal = refuse(draft, taken, initial !== undefined);
  // A changed question has never been run, so the reading and — for a measure —
  // the baseline go with it. Said before the save rather than after, because the
  // baseline is the one thing here that cannot be retaken: it is a reading from
  // before the work arrived, and the work has arrived.
  const rereads =
    initial !== undefined && (initial.query !== draft.query || (initial.presence ?? '') !== draft.presence);

  return (
    <form
      className="cn-sig-row editing"
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <span className="cn-sig-stripe" />
      <div className="cn-sig-form">
        <label className="cn-sig-field">
          <span>Id</span>
          <input
            className="cn-in"
            value={draft.id}
            onChange={(e) => set('id', e.target.value)}
            disabled={initial !== undefined}
            placeholder="orders-throw"
            title={
              initial === undefined
                ? 'Lowercase kebab-case. Every writer merges on it, so it has to survive a replan.'
                : 'The merge key. A replan folds onto it, so it cannot change — delete the check and write another.'
            }
          />
        </label>
        <label className="cn-sig-field">
          <span>Title</span>
          <input
            className="cn-in"
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Order submission stops throwing"
          />
        </label>
        <label className="cn-sig-field">
          <span>Query</span>
          <textarea
            className="cn-in cn-sig-area"
            rows={2}
            value={draft.query}
            onChange={(e) => set('query', e.target.value)}
          />
        </label>
        {draft.kind === 'signal' ? (
          <>
            <label className="cn-sig-field">
              <span title="A second query, whose only job is to prove the code path runs at all">Presence</span>
              <textarea
                className="cn-in cn-sig-area"
                rows={2}
                value={draft.presence}
                onChange={(e) => set('presence', e.target.value)}
              />
            </label>
            <label className="cn-sig-field cn-sig-narrow">
              <span>Tolerate</span>
              <input
                className="cn-in"
                value={draft.tolerate}
                onChange={(e) => set('tolerate', e.target.value)}
                title="The count this must not exceed. Almost always zero — the thing should not be happening."
              />
            </label>
          </>
        ) : (
          <div className="cn-sig-expects">
            <label className="cn-sig-field cn-sig-narrow">
              <span>Under</span>
              <input
                className="cn-in"
                value={draft.under}
                onChange={(e) => set('under', e.target.value)}
                placeholder="500"
              />
            </label>
            <label className="cn-sig-field cn-sig-narrow">
              <span>Over</span>
              <input
                className="cn-in"
                value={draft.over}
                onChange={(e) => set('over', e.target.value)}
                placeholder="99.5"
              />
            </label>
            <label className="cn-sig-field cn-sig-narrow">
              <span>Unit</span>
              <input
                className="cn-in"
                value={draft.unit}
                onChange={(e) => set('unit', e.target.value)}
                placeholder="ms"
              />
            </label>
            <label
              className="cn-sig-check"
              title="Read lower-is-better. A number whose good news is bigger declares an “over” instead."
            >
              <input
                className="cn-sig-box"
                type="checkbox"
                checked={draft.baseline}
                onChange={(e) => set('baseline', e.target.checked)}
              />
              <span>No worse than the baseline</span>
            </label>
          </div>
        )}
        <label className="cn-sig-field">
          <span>Why (optional)</span>
          <input className="cn-in" value={draft.why} onChange={(e) => set('why', e.target.value)} />
        </label>
        {rereads && (
          <p className="cn-sig-warn">
            The question is changing, so the reading goes with it
            {initial?.expectBaseline === true && ', and the baseline with that — it was read before the work arrived'}.
          </p>
        )}
        {refusal !== null && <p className="cn-sig-warn">{refusal}</p>}
        {refusals.map((said) => (
          <p className="cn-sig-warn" key={said}>
            {said}
          </p>
        ))}
        <div className="cn-sig-ctrls">
          <AsyncButton
            tone="primary"
            family="console"
            disabled={refusal !== null}
            onClick={async () => {
              const said = await onSave(declaration(draft));
              setRefusals(said);
              // Held open on a refusal, because the refusal is about the text in
              // front of them: a form that closed would leave the operator with a
              // check the environment could not answer and nowhere it was said.
              if (said.length === 0) onClose();
            }}
          >
            Save &amp; run
          </AsyncButton>
          <Button family="console" onClick={onClose}>
            Cancel
          </Button>
          {onDelete !== null && (
            <ConfirmButton
              family="console"
              className="cn-sig-spacer"
              label="Delete"
              confirmLabel="Delete it"
              onConfirm={onDelete}
            />
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * Why this draft cannot be saved, or null.
 *
 * Every arm is a rule `WatchCheckSchema` already enforces, phrased for somebody
 * looking at the field rather than at a zod path. **A rule that is only here is a
 * rule the plan document does not have**, which is the drift this whole module is
 * written to avoid — so nothing is checked here that the server would accept.
 */
function refuse(draft: Draft, taken: Set<string>, editing: boolean): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(draft.id)) return 'The id is lowercase letters, digits and dashes.';
  if (!editing && taken.has(draft.id)) return `This goal already carries a check called “${draft.id}”.`;
  if (draft.title.trim() === '') return 'A title says what the check is for.';
  if (draft.query.trim() === '') return 'A check is a query.';
  if (draft.kind === 'signal') {
    if (draft.presence.trim() === '')
      return 'A signal needs a presence query. Without one, a typo that matches nothing reads as a clean release.';
    if (!/^\d+$/.test(draft.tolerate.trim())) return 'Tolerate is a whole number of rows — almost always 0.';
    return null;
  }
  if (draft.under.trim() !== '' && Number.isNaN(Number(draft.under))) return 'Under is a number.';
  if (draft.over.trim() !== '' && Number.isNaN(Number(draft.over))) return 'Over is a number.';
  if (draft.under.trim() === '' && draft.over.trim() === '' && !draft.baseline)
    return 'A measure needs a threshold or a baseline — one with neither can never fail.';
  return null;
}

/** The draft as the wire's own declaration. Only called on a draft {@link refuse} passed. */
function declaration(draft: Draft): GoalWatchDeclaration {
  const why = draft.why.trim() === '' ? {} : { why: draft.why.trim() };
  if (draft.kind === 'signal')
    return {
      kind: 'signal',
      id: draft.id,
      title: draft.title.trim(),
      query: draft.query.trim(),
      presence: draft.presence.trim(),
      tolerate: Number(draft.tolerate.trim()),
      ...why,
    };
  return {
    kind: 'measure',
    id: draft.id,
    title: draft.title.trim(),
    query: draft.query.trim(),
    expect: {
      ...(draft.under.trim() === '' ? {} : { under: Number(draft.under) }),
      ...(draft.over.trim() === '' ? {} : { over: Number(draft.over) }),
      ...(draft.baseline ? { noWorseThan: 'baseline' as const } : {}),
    },
    ...(draft.unit.trim() === '' ? {} : { unit: draft.unit.trim() }),
    ...why,
  };
}
