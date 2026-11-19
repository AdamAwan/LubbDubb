import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { OpenPullRequest } from '../types.js';
import { buildGoalPage, type GoalTrack } from '../view/goalPage.js';
import { buildGoalTrack } from '../view/goalStages.js';
import { goalIssue } from '../view/goalRefs.js';
import { rackByGoal, type RackGoal } from '../view/prRack.js';
import { Ref, refLabel } from '../components/refs.js';
import type { PanelRowModel, RowGroup } from './PanelRow.js';
import { prRow } from './prRow.js';

// → docs/spec/17-cockpit.md#grouped-by-goal-stacks-as-a-tree

export function goalPrRows(
  prs: readonly OpenPullRequest[],
  view: CockpitView,
  actions: CockpitActions,
  {
    dress = (_pr, row) => row,
    lone,
  }: { dress?: (pr: OpenPullRequest, row: PanelRowModel) => PanelRowModel; lone?: RowGroup } = {},
): PanelRowModel[] {
  const goals = rackByGoal(view.state, prs);
  const byGoal = goals.some((g) => g.goal !== null);
  return goals.flatMap((g) => {
    const group = byGoal ? goalBand(g, view) : lone;
    return g.rungs.map((rung) => ({
      ...dress(rung.pr, prRow(rung.pr, view, actions, { goal: !byGoal, on: rung.base })),
      ...(group === undefined ? {} : { group }),
      depth: rung.depth,
    }));
  });
}

function goalBand(g: RackGoal, view: CockpitView): RowGroup {
  if (g.goal === null) return { key: 'goal:none', label: 'No goal', note: `${g.rungs.length}` };
  const issue = goalIssue(view.state, g.goal);
  const page = buildGoalPage(view.state, g.goal, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  return {
    key: `goal:${g.goal}`,
    tone: 'title',
    label: issue?.title ?? refLabel(g.goal),
    refs: <Ref to={g.goal} title={`Open the goal these pull requests are delivering — ${refLabel(g.goal)}`} />,
    note:
      track === null || track.total === 0 ? (
        `${g.rungs.length} open`
      ) : (
        <>
          <Track track={track} />
          {track.merged} of {track.total} merged
        </>
      ),
  };
}

export function Track({ track }: { track: GoalTrack }): JSX.Element {
  const segs = [
    ...Array<string>(track.merged).fill('cn-done'),
    ...Array<string>(track.now).fill('cn-live'),
    ...Array<string>(track.held).fill('cn-block'),
    ...Array<string>(track.waiting).fill(''),
  ];
  return (
    <span className="cn-track" title={trackTitle(track)}>
      {segs.map((tone, i) => (
        <i className={`cn-seg ${tone}`} key={i} />
      ))}
    </span>
  );
}

function trackTitle(track: GoalTrack): string {
  const parts = [
    track.merged > 0 ? `${track.merged} merged` : '',
    track.now > 0 ? `${track.now} in progress` : '',
    track.held > 0 ? `${track.held} blocked` : '',
    track.waiting > 0 ? `${track.waiting} not started` : '',
  ].filter((part) => part !== '');
  return `${track.total} ${track.total === 1 ? 'part' : 'parts'} — ${parts.join(', ')}`;
}
