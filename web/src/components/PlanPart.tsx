import type { AcceptanceCriterion, PlanAtom, PlanPartView, QueueItem } from '../types.js';
import { ConfirmButton } from './ConfirmButton.js';
import { ProfilePicker } from './ProfilePicker.js';
import { Ref } from './refs.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function PartBlock({
  part,
  atoms,
  seq,
  queue,
  focused,
  onPartProfile,
  onRestart,
  profiles,
  defaultProfile,
}: {
  part: PlanPartView;
  atoms: PlanAtom[];
  seq: number;
  queue: QueueItem | undefined;
  focused: boolean;
  onPartProfile: (profile: string | null) => Promise<unknown> | unknown;
  onRestart: (() => Promise<unknown> | unknown) | undefined;
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
}) {
  return (
    <div className={`pm-part${focused ? ' on' : ''}`}>
      <span className="pm-seq">{seq}</span>
      <div>
        <PartHead
          part={part}
          queue={queue}
          onPartProfile={onPartProfile}
          onRestart={onRestart}
          profiles={profiles}
          defaultProfile={defaultProfile}
        />
        <PartFields part={part} atoms={atoms} />
        {/*
          Spelled out rather than left as an `on <slug>` chip: the stack edge is
          what decides which branch this part is cut from, and getting it wrong is
          the one planning mistake that is expensive to undo.
        */}
        <div className="pm-stack">{stackLine(part)}</div>
      </div>
    </div>
  );
}

function PartHead({
  part,
  queue,
  onPartProfile,
  onRestart,
  profiles,
  defaultProfile,
}: {
  part: PlanPartView;
  queue: QueueItem | undefined;
  onPartProfile: (profile: string | null) => Promise<unknown> | unknown;
  onRestart: (() => Promise<unknown> | unknown) | undefined;
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
}) {
  return (
    <div className="pm-part-head">
      <span className="pm-part-title">{part.title}</span>
      <Tag lower>{part.slug}</Tag>
      <Tag>{part.status.replace('_', ' ')}</Tag>
      {/* This is the surface plan approval exists for: seeing that step 3 is
          "write it up" rather than "build it" is what an operator is approving.
          Shown only when the kind is not code, which is the default. */}
      {kindOf(part) && (
        <Tag title={part.status === 'concluded' ? 'What it produced' : 'What it will produce'}>{kindOf(part)}</Tag>
      )}
      {part.size !== null && (
        <Tag lower title="How big this is to review, as the planner judged it">
          {part.size.toUpperCase()}
        </Tag>
      )}
      {/* Which model profile this part runs on (#342) — the planner's own
          sizing of the part it just cut, edited. Beside the size chip because
          they are the same judgement about the same thing: how much this part
          is going to take. */}
      <ProfilePicker
        profiles={profiles}
        value={part.profile ?? null}
        defaultProfile={defaultProfile}
        inheritLabel="Inherit"
        onPick={(profile) => void onPartProfile(profile)}
      />
      {part.prNumber !== null && (
        <Tag>
          <Ref to={`pr:${part.prNumber}`} />
        </Tag>
      )}
      {queue && <QueueTag queue={queue} />}
      {/* Only where it applies: a part in review has a pull request open and no
          agent on it (an agent still working is `dispatched`), which is exactly
          the state an amendment overtakes. Two clicks, because closing somebody's
          open pull request is not undoable from here. */}
      {onRestart && part.status === 'in_review' && part.prNumber !== null && (
        <ConfirmButton
          size="small"
          label="↺ restart"
          confirmLabel="close the PR and restart"
          title={`Close PR #${part.prNumber}, drop its branch, and put "${part.slug}" back to ready so it is worked again against the plan as it stands now.`}
          onConfirm={onRestart}
        />
      )}
    </div>
  );
}

function QueueTag({ queue }: { queue: QueueItem }) {
  return (
    <Tag
      tone={
        queue.status === 'dispatching'
          ? 'green'
          : queue.status === 'capped' || queue.status === 'unapproved'
            ? 'amber'
            : undefined
      }
      title={queue.reason}
    >
      {queue.status === 'dispatching' ? '▶ now' : queue.status}
    </Tag>
  );
}

function PartFields({ part, atoms }: { part: PlanPartView; atoms: PlanAtom[] }) {
  return (
    <>
      {part.scope !== '' && (
        <div className="pm-field">
          <b>what this achieves</b>
          {part.scope}
        </div>
      )}
      {atoms.length > 0 && <Atoms atoms={atoms} />}
      {part.outsideScope.length > 0 && (
        <div className="pm-drift">
          <b>wrote outside its scope</b>
          {part.outsideScope.map((path) => (
            <code key={path}>{path}</code>
          ))}
        </div>
      )}
      {part.acceptanceCriteria.length > 0 && <Acceptance criteria={part.acceptanceCriteria} />}
      {/* A concluded part left a record rather than a pull request, so this is the
          only place its outcome is readable at all. */}
      {part.status === 'concluded' && part.outcomeSummary && (
        <div className="pm-field">
          <b>
            {part.outcomeKind ?? 'concluded'}
            {part.expectedKind && part.expectedKind !== part.outcomeKind ? ` (planned as ${part.expectedKind})` : ''}
          </b>
          {part.outcomeSummary}
        </div>
      )}
      {part.status === 'blocked' && part.blockedReason && (
        <div className="pm-drift">
          <b>held</b>
          {part.blockedReason}
        </div>
      )}
    </>
  );
}

function Atoms({ atoms }: { atoms: PlanAtom[] }) {
  return (
    <div className="pm-atoms">
      <span className="pm-section-label">
        {atoms.length} atom{atoms.length === 1 ? '' : 's'} — each one could land and be rolled back on its own
      </span>
      {atoms.map((atom) => (
        <div className="pm-atom" key={atom.slug}>
          <div className="pm-atom-head">
            <span className="pm-atom-title">{atom.title}</span>
            <Tag lower>{atom.slug}</Tag>
            {atom.dependsOn.length > 0 && <span className="muted small">after {quoteList(atom.dependsOn)}</span>}
          </div>
          <div className="pm-atom-intent">{atom.intent}</div>
          {atom.acceptance !== null && (
            <div className="pm-field">
              <b>done when</b>
              {atom.acceptance}
            </div>
          )}
          {atom.touches.length > 0 && (
            <div className="pm-atom-paths">
              {atom.touches.map((path) => (
                <code key={path}>{path}</code>
              ))}
            </div>
          )}
          {/* A route the planner weighed and did not take. Drawn as what it is —
              a reason from before the code existed — rather than as a claim about
              what the code now does. */}
          {atom.rejected.map((r) => (
            <div className="pm-atom-not" key={r.route}>
              <b>not</b>
              <span>
                {r.route} <i>{r.because}</i>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function stackLine(part: PlanPartView): string {
  if (part.expectedKind === 'human') {
    return part.dependsOn.length === 0
      ? 'a step for a person — no branch is cut for it'
      : `a step for a person, once ${quoteList(part.dependsOn)} ${part.dependsOn.length === 1 ? 'is' : 'are'} done`;
  }
  if (part.dependsOn.length === 0) return 'stacks on nothing — starts from the default branch';
  if (part.dependsOn.length === 1) return `stacks on ${quoteList(part.dependsOn)} — based on that part's branch`;
  return `rejoins ${quoteList(part.dependsOn)} — starts only once every one of them has merged, from the default branch`;
}

function quoteList(slugs: string[]): string {
  const quoted = slugs.map((s) => `“${s}”`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

function Acceptance({ criteria }: { criteria: AcceptanceCriterion[] }) {
  return (
    <div className="pm-accept">
      <b>done when</b>
      <div>
        {criteria.map((c) => (
          <span className={`pm-crit${c.met ? ' met' : ''}`} key={c.text}>
            <span>{c.text}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function kindOf(part: PlanPartView): string | null {
  const kind = part.status === 'concluded' ? (part.outcomeKind ?? 'concluded') : (part.expectedKind ?? null);
  return kind && kind !== 'code' ? kind : null;
}
