import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { OpenPullRequest } from '../types.js';
import { buildGoalPage } from '../view/goalPage.js';
import { buildGoalTrack } from '../view/goalStages.js';
import { goalIssue } from '../view/goalRefs.js';
import { rackByGoal, type RackGoal } from '../view/prRack.js';
import { Ref, refLabel } from '../components/refs.js';
import type { PanelRowModel, RowGroup } from './PanelRow.js';
import { prRow } from './prRow.js';
import { Track } from '../components/track.js';

// → docs/spec/17-cockpit.md#grouped-by-goal-stacks-as-a-tree

export function goalPrRows(
  prs: readonly OpenPullRequest[],
  view: CockpitView,
  actions: CockpitActions,
  dress: (pr: OpenPullRequest, row: PanelRowModel) => PanelRowModel = (_pr, row) => row,
): PanelRowModel[] {
  const goals = rackByGoal(view.state, prs);
  const byGoal = goals.some((g) => g.goal !== null);
  return goals.flatMap((g) => {
    const group = byGoal ? goalBand(g, view) : undefined;
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
