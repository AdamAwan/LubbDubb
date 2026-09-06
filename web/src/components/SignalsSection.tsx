import { useState } from 'react';
import type { GoalWatch, GoalWatchDeclaration, GoalWatchKind } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { expectation, WatchReadingLine } from './WatchDigest.js';
import { renderMarkdown } from './markdown.js';
import { HeadRow } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

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
  signals: GoalWatch[];
  refUrls: Record<string, string>;
  onSave: (check: GoalWatchDeclaration) => Promise<string[]>;
  onDelete: (checkId: string) => Promise<void>;
  onRule: (checkId: string, accept: boolean) => Promise<void>;
}) {
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
          onClick={() => setOpen('signal')}
          title="Something that should not be happening: an exception, a failure, a retry. Needs a second query proving the code path runs."
        >
          Add a signal
        </Button>
        <Button
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
  const tone = !check.live ? 'pending' : (check.dryRunVerdict ?? 'unread');
  return (
    <div className={`cn-sig-row ${tone}`}>
      <span className="cn-sig-stripe" />
      <div className="cn-sig-body">
        <HeadRow className="cn-sig-head">
          <b className="cn-name">{check.title}</b>
          <Tag>{check.kind}</Tag>
          <Tag lower title="The author’s own id, and the merge key every writer folds on">
            {check.id}
          </Tag>
          {check.authored === 'operator' && (
            <Tag title="Yours. A replan neither removes this nor writes over it.">yours</Tag>
          )}
          {!check.live && (
            <Tag tone="amber" fill title="Declared by the agent that did the work, and not yet run">
              awaiting you
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
          <Button onClick={onEdit}>Edit</Button>
        ) : (
          <AsyncButton onClick={() => onRule(check.id, true)}>Accept &amp; run</AsyncButton>
        )}
        {check.live ? (
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete it"
            title="Drop this check and the readings taken against it. A check the plan declares comes back on the next replan."
            onConfirm={onDelete}
          />
        ) : (
          <AsyncButton onClick={() => onRule(check.id, false)}>Decline</AsyncButton>
        )}
      </div>
    </div>
  );
}

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

function CheckForm({
  initial,
  kind,
  taken,
  onSave,
  onClose,
  onDelete,
}: {
  initial?: GoalWatch;
  kind?: GoalWatchKind;
  taken: Set<string>;
  onSave: (check: GoalWatchDeclaration) => Promise<string[]>;
  onClose: () => void;
  onDelete: (() => Promise<void>) | null;
}) {
  const [draft, setDraft] = useState<Draft>(initial === undefined ? blankDraft(kind ?? 'signal') : draftOf(initial));
  const [refusals, setRefusals] = useState<string[]>([]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const refusal = refuse(draft, taken, initial !== undefined);
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
            disabled={refusal !== null}
            onClick={async () => {
              const said = await onSave(declaration(draft));
              setRefusals(said);
              if (said.length === 0) onClose();
            }}
          >
            Save &amp; run
          </AsyncButton>
          <Button onClick={onClose}>Cancel</Button>
          {onDelete !== null && (
            <ConfirmButton className="cn-sig-spacer" label="Delete" confirmLabel="Delete it" onConfirm={onDelete} />
          )}
        </div>
      </div>
    </form>
  );
}

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
