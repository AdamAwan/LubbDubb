import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { FeatureHold, FeatureHolds } from '../view/featureHolds.js';
import { Ref } from './refs.js';
import { Button } from './button.js';
import { Tag } from './tag.js';
import { relAge } from './util.js';

export function Courts({ holds, yoursOnly }: { holds: FeatureHolds; yoursOnly?: boolean }): JSX.Element | null {
  const you = holds.you.length;
  // A row has one line to say what a Feature is, and the fleet's and the world's
  // counts are the two things on the brief that ask nothing of anybody. They are the
  // first to go where the space they take is the headline's.
  const fleet = yoursOnly === true ? 0 : holds.fleet.length;
  const world = yoursOnly === true ? 0 : holds.world.length;
  if (you + fleet + world === 0) return null;
  return (
    <span className="cn-fb-courts">
      {you > 0 && (
        <Tag tone={holds.you.some(isRed) ? 'red' : 'amber'} fill>
          you {you}
        </Tag>
      )}
      {fleet > 0 && <span className="cn-fb-court-quiet">fleet {fleet}</span>}
      {world > 0 && <span className="cn-fb-court-quiet">world {world}</span>}
    </span>
  );
}

const COURT_WORD = { you: 'you', fleet: 'fleet', world: 'world' } as const;

const RED_KINDS: ReadonlySet<string> = new Set(['escalation', 'permission', 'recovery']);

function isRed(hold: FeatureHold): boolean {
  return hold.tone === 'red' || RED_KINDS.has(hold.kind);
}

export function Holds({
  holds,
  stories,
  now,
  actions,
}: {
  holds: FeatureHolds;
  stories: readonly { number: number; title: string }[];
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  const groups: { court: keyof typeof COURT_WORD; rows: FeatureHold[]; empty: string }[] = [
    { court: 'you', rows: holds.you, empty: 'Nothing here is waiting on you.' },
    { court: 'fleet', rows: holds.fleet, empty: '' },
    { court: 'world', rows: holds.world, empty: '' },
  ];
  const any = groups.some((g) => g.rows.length > 0);
  if (!any) return <p className="cn-fb-quiet cn-fb-empty">Nothing is in the way.</p>;
  return (
    <div className="cn-fb-holds">
      {groups.map(({ court, rows, empty }) =>
        rows.length === 0 ? (
          empty === '' ? null : (
            <p key={court} className="cn-fb-quiet cn-fb-empty">
              {empty}
            </p>
          )
        ) : (
          <section key={court} className={`cn-fb-court cn-fb-court-${court}`}>
            <h5>
              {COURT_WORD[court]} <span className="cn-fb-quiet">{rows.length}</span>
            </h5>
            {rows.map((hold) => (
              <HoldRow
                key={`${hold.court}:${hold.kind}:${hold.ref ?? ''}:${hold.needId ?? hold.title}`}
                hold={hold}
                story={stories.find((s) => s.number === hold.goal) ?? null}
                now={now}
                actions={actions}
              />
            ))}
          </section>
        ),
      )}
    </div>
  );
}

function HoldRow({
  hold,
  story,
  now,
  actions,
}: {
  hold: FeatureHold;
  story: { number: number; title: string } | null;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  const open = openHold(hold, actions);
  const suffix = story === null ? '' : ` · ${story.title}`;
  const said = suffix !== '' && hold.title.endsWith(suffix) ? hold.title.slice(0, -suffix.length) : hold.title;
  return (
    <div className={`cn-fb-hold cn-fb-hold-${hold.court}${isRed(hold) ? ' cn-fb-hold-red' : ''}`}>
      <div className="cn-fb-hold-body">
        {(story !== null || hold.ref !== null) && <HoldAbout holdRef={hold.ref} story={story} />}
        <div className="cn-fb-hold-title">{said}</div>
        {(hold.detail !== null || hold.since !== null) && (
          <div className="cn-fb-quiet">
            {hold.detail !== null && <span className="cn-fb-said-inline">{hold.detail}</span>}
            {hold.detail !== null && hold.since !== null && ' · '}
            {hold.since !== null && relAge(hold.since, now)}
          </div>
        )}
      </div>
      {open !== null && (
        <Button size="small" onClick={open}>
          {hold.needId !== null ? 'Answer' : 'Open'}
        </Button>
      )}
    </div>
  );
}

function HoldAbout({
  holdRef,
  story,
}: {
  holdRef: string | null;
  story: { number: number; title: string } | null;
}): JSX.Element {
  const storyRef = story === null ? null : `issue:${story.number}`;
  return (
    <div className="cn-fb-hold-about">
      <span className="cn-refs">
        {storyRef !== null && <Ref to={storyRef} />}
        {holdRef !== null && holdRef !== storyRef && <Ref to={holdRef} />}
      </span>
      {story !== null && <span className="cn-fb-hold-story">{story.title}</span>}
    </div>
  );
}

function openHold(hold: FeatureHold, actions: CockpitActions): (() => void) | null {
  if (hold.needId !== null) {
    const id = hold.needId;
    return () => actions.openPanel({ ask: id });
  }
  const pr = /^pr:(\d+)$/.exec(hold.ref ?? '');
  if (pr) {
    const n = Number(pr[1]);
    return () => actions.selectPr(n);
  }
  if (hold.ref !== null && /^issue:\d+$/.test(hold.ref)) {
    const ref = hold.ref;
    return () => actions.selectGoal(ref);
  }
  return null;
}
