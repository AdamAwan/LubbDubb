import { useState } from 'react';
import type { PlanAtom, PlanPartView } from '../types.js';
import {
  addPart,
  dropPart,
  groupingCost,
  initialGrouping,
  moveAtom,
  regroupCycle,
  unchangedFrom,
} from '../cockpit/regroup.js';
import type { RegroupPart } from '../cockpit/regroup.js';
import { AsyncButton } from './AsyncButton.js';
import { buttonClass } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md#regrouping-the-atoms

export function PlanRegroup({
  parts,
  atoms,
  onRegroup,
  onClose,
}: {
  parts: PlanPartView[];
  atoms: PlanAtom[];
  onRegroup: (
    groups: { slug: string; atoms: string[]; title?: string; scope?: string }[],
  ) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const start = initialGrouping(parts, atoms);
  const [groups, setGroups] = useState<RegroupPart[]>(start);
  const [adding, setAdding] = useState<{ slug: string; title: string; scope: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const byAtom = new Map(atoms.map((a) => [a.slug, a]));
  const cycle = regroupCycle(atoms, groups);
  const cost = groupingCost(groups);
  const settled = unchangedFrom(start, groups);
  const newSlug = (adding?.slug ?? '').trim();
  const canAdd =
    /^[a-z0-9][a-z0-9-]*$/.test(newSlug) &&
    !groups.some((g) => g.slug === newSlug) &&
    (adding?.title ?? '').trim() !== '' &&
    (adding?.scope ?? '').trim() !== '';

  return (
    <div className="pr-group">
      <p className="pr-lead">
        The atoms are what the work is; the parts are where the merge boundaries fall through it. Moving one changes
        nothing about the work — only which pull request carries it. Nothing is written until you save, and what you
        save goes back to you for approval.
      </p>

      {/* The one refusal that has to be loud: a grouping that puts two parts in a
          cycle is a part held pending forever with nothing red. It is drawn before
          the save it blocks, not after it. */}
      {cycle !== null && (
        <div className="pr-cycle" role="alert">
          <b>These two parts would wait on each other</b>
          <span>{cycle.sentence}</span>
        </div>
      )}
      {refused !== null && (
        <div className="pr-cycle" role="alert">
          <b>The harness refused this grouping</b>
          <span>{refused}</span>
        </div>
      )}

      <div className="pr-cost">
        {cost.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>

      <div className="pr-parts">
        {groups.map((group) => (
          <div className={`pr-part${group.added ? ' added' : ''}`} key={group.slug}>
            <div className="pr-part-head">
              <span className="pr-part-title">{group.title}</span>
              <Tag lower>{group.slug}</Tag>
              <span className="spacer" />
              {group.added && (
                <button
                  type="button"
                  className={buttonClass({ ghost: true, size: 'small' })}
                  disabled={group.atoms.length > 0}
                  title={
                    group.atoms.length > 0
                      ? 'Move its atoms somewhere else first — dropping a part cannot decide where its work goes.'
                      : 'Drop this part again'
                  }
                  onClick={() => setGroups(dropPart(groups, group.slug))}
                >
                  Drop
                </button>
              )}
            </div>
            {group.atoms.length === 0 ? (
              <p className="empty small">Nothing in this part yet.</p>
            ) : (
              group.atoms.map((slug) => (
                <div className="pr-atom" key={slug}>
                  <div className="pr-atom-said">
                    <span className="pr-atom-title">{byAtom.get(slug)?.title ?? slug}</span>
                    <Tag lower>{slug}</Tag>
                    {(byAtom.get(slug)?.dependsOn ?? []).length > 0 && (
                      <span className="muted small">after {(byAtom.get(slug)?.dependsOn ?? []).join(', ')}</span>
                    )}
                  </div>
                  <label className="pr-move">
                    <span className="muted small">move to</span>
                    <select
                      value=""
                      aria-label={`Move ${slug} to another part`}
                      onChange={(e) => {
                        if (e.target.value !== '') setGroups(moveAtom(groups, slug, e.target.value));
                      }}
                    >
                      <option value="">…</option>
                      {groups
                        .filter((other) => other.slug !== group.slug)
                        .map((other) => (
                          <option key={other.slug} value={other.slug}>
                            {other.slug}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      {adding === null ? (
        <button
          type="button"
          className={buttonClass({ ghost: true, size: 'small' })}
          onClick={() => setAdding({ slug: '', title: '', scope: '' })}
        >
          Add a part
        </button>
      ) : (
        <div className="pr-add">
          <input
            value={adding.slug}
            placeholder="slug — lowercase, hyphens"
            aria-label="The new part's slug"
            onChange={(e) => setAdding({ ...adding, slug: e.target.value })}
          />
          <input
            value={adding.title}
            placeholder="title"
            aria-label="The new part's title"
            onChange={(e) => setAdding({ ...adding, title: e.target.value })}
          />
          <input
            value={adding.scope}
            placeholder="what this part achieves"
            aria-label="What the new part achieves"
            onChange={(e) => setAdding({ ...adding, scope: e.target.value })}
          />
          <button
            type="button"
            className={buttonClass({ size: 'small' })}
            disabled={!canAdd}
            onClick={() => {
              setGroups(addPart(groups, { slug: newSlug, title: adding.title.trim(), scope: adding.scope.trim() }));
              setAdding(null);
            }}
          >
            Add
          </button>
          <button type="button" className={buttonClass({ ghost: true, size: 'small' })} onClick={() => setAdding(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className="pr-bar">
        <AsyncButton
          tone="primary"
          disabled={settled || cycle !== null}
          title={
            cycle !== null
              ? 'Two parts would wait on each other — move one of the two atoms first.'
              : settled
                ? 'Nothing has moved yet.'
                : 'Write this grouping back as an amended plan, for you to approve'
          }
          onRefused={setRefused}
          onClick={async () => {
            setRefused(null);
            await onRegroup(
              groups.map((g) =>
                g.added
                  ? { slug: g.slug, atoms: g.atoms, title: g.title, scope: g.scope }
                  : { slug: g.slug, atoms: g.atoms },
              ),
            );
            onClose();
          }}
        >
          Save this grouping
        </AsyncButton>
        <button type="button" className={buttonClass({ ghost: true })} onClick={() => setGroups(start)}>
          Put it back
        </button>
      </div>
    </div>
  );
}
