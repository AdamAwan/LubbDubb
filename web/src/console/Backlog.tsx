import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { watchBucket } from '../worldBuckets.js';
import { groupByFeature, groupProgress, isContainerType, type IssueGroup } from '../issueGroups.js';

/**
 * The backlog: every open item the tracker returned, in the one group that says
 * what the harness is doing about it and what you can do about that.
 *
 * A nav view rather than a permanent one, because triage is periodic — nothing
 * here blocks an agent, which is the whole difference between this surface and
 * the rail.
 *
 * Two rules run through it. **Which items the harness will work is
 * {@link watchBucket}'s answer**, the World panel's own predicate, read once here
 * rather than re-derived from the labels — a second reading of the same tags is
 * how two surfaces start disagreeing about what is watched. And **nothing is
 * re-decided**: the pickup reason and the assay summary are the server's
 * sentences, quoted, never parsed and never reworded.
 */
type BacklogGroup = 'watched' | 'intake' | 'unwatched' | 'ignored';

const GROUP_ORDER: BacklogGroup[] = ['watched', 'intake', 'unwatched', 'ignored'];

const GROUP_LABEL: Record<BacklogGroup, string> = {
  watched: 'Watched',
  intake: 'Blocked at intake',
  unwatched: 'Unwatched',
  ignored: 'Ignored',
};

const GROUP_HINT: Record<BacklogGroup, string> = {
  watched: 'The harness will pick these up',
  intake: 'An unclear assay stops dispatch — override to unblock',
  unwatched: 'Nobody has opted these in · newest first',
  ignored: 'Tagged leave-alone · the dispatcher skips these',
};

const GROUP_EMPTY: Record<BacklogGroup, string> = {
  watched: 'Nothing is watched.',
  intake: 'Nothing is held at intake.',
  unwatched: 'Every open item has been triaged.',
  ignored: 'Nothing is ignored.',
};

/** How many rows a group draws before it states a remainder instead. */
const GROUP_LIMIT = 25;

interface BacklogGroups {
  watched: Issue[];
  intake: Issue[];
  unwatched: Issue[];
  ignored: Issue[];
}

/**
 * Which group one item belongs to.
 *
 * Intake is pulled *out* of Watched rather than greyed inside it: an `unclear`
 * assay is the one intake reading that stops dispatch, and among the watched rows
 * it reads as a detail rather than as the thing holding all the work.
 *
 * An ignored item is never intake, whatever a stale verdict says. "Leave this
 * alone" is the operator's own instruction and outranks a reading about a goal
 * nobody is going to work.
 */
function groupOf(issue: Issue, watchLabel: string, ignoreLabel: string): BacklogGroup {
  const bucket = watchBucket(issue.labels, { watchLabel, ignoreLabel, defaultWatched: false });
  if (bucket !== 'ignored' && issue.assay?.verdict === 'unclear') return 'intake';
  return bucket;
}

/**
 * Every open item, in exactly one group.
 *
 * One pass and one assignment per item rather than four filters: an item matching
 * two predicates would draw twice, with two toggles, and the second would be a
 * different answer to the same question.
 *
 * Closed items are left out altogether — the backlog is what triage acts on, and
 * a closed ticket is neither watchable nor ignorable.
 *
 * Exported for the nav's unwatched count, which must be the count of the rows the
 * Unwatched group actually draws.
 */
export function backlogGroups(view: CockpitView): BacklogGroups {
  const { watchLabel, ignoreLabel } = view.state.config;
  const groups: BacklogGroups = { watched: [], intake: [], unwatched: [], ignored: [] };
  for (const issue of view.state.world.issues) {
    if (issue.state !== 'open') continue;
    groups[groupOf(issue, watchLabel, ignoreLabel)].push(issue);
  }
  // "Newest first" is the number's order: the tracker times no item on the
  // snapshot, and the number is the only monotonic thing it does give.
  groups.unwatched.sort((a, b) => b.number - a.number);
  groups.ignored.sort((a, b) => b.number - a.number);
  groups.watched.sort((a, b) => a.number - b.number);
  return groups;
}

export function Backlog({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const groups = backlogGroups(view);
  return (
    <div className="cn-backlog">
      {GROUP_ORDER.map((group) => (
        <Group key={group} group={group} issues={groups[group]} view={view} actions={actions} />
      ))}
    </div>
  );
}

/**
 * One group, drawn whether or not anything is in it — a group that vanishes when
 * quiet is indistinguishable from one that broke, and its count is the reading an
 * operator glances at before deciding whether to triage at all.
 */
function Group({
  group,
  issues,
  view,
  actions,
}: {
  group: BacklogGroup;
  issues: Issue[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { containerTypes } = view.state.config;
  const shown = issues.slice(0, GROUP_LIMIT);
  const rest = issues.length - shown.length;
  // The tree is arranged over the rows this group *draws*, not over the whole
  // group: a heading standing above the limit's cut would promise children that
  // are in the remainder, and the count beside it already says how many there are.
  const tree = groupByFeature(shown, (issue) => isContainerType(issue, containerTypes));
  return (
    <>
      <div className="cn-grpname">
        {GROUP_LABEL[group]}
        <i className="cn-n">{issues.length}</i>
        <span className="cn-hint">{GROUP_HINT[group]}</span>
      </div>
      <section className="cn-card">
        <div className="cn-rows">
          {issues.length === 0 && <p className="cn-empty">{GROUP_EMPTY[group]}</p>}
          {tree === null
            ? shown.map((issue) => <Row key={issue.id} issue={issue} group={group} view={view} actions={actions} />)
            : tree.map((treeGroup, i) => (
                <FeatureBlock
                  // A headless group has no feature to key on, and there is at
                  // most one of each kind, so the kind is the key there.
                  key={treeGroup.feature?.number ?? treeGroup.kind}
                  block={treeGroup}
                  group={group}
                  view={view}
                  actions={actions}
                  first={i === 0}
                />
              ))}
          {rest > 0 && <p className="cn-empty">…{rest} more</p>}
        </div>
      </section>
    </>
  );
}

/**
 * One feature and the work under it, or one headless run of rows.
 *
 * **A feature is a heading, never a row.** Nothing is ever dispatched at a
 * container, so listing one among the items an operator is triaging asks them to
 * remember which is which on every read; drawing it above its children says it
 * structurally, and the fold makes a long feature collapsible to that one line.
 *
 * **Open by default.** The backlog's job is to show what is waiting, and a
 * surface that hides it until clicked reports an empty board. Folding is the
 * operator's own act, and it is remembered in the address bar rather than in this
 * component, so the back button and a reload both restore it.
 *
 * The two headless kinds draw no heading at all. `untracked` is a flat tracker's
 * every issue — filing those under a heading would claim a hierarchy the provider
 * never had — and `orphans` is the one gap worth naming, so it gets a label and
 * no controls, because there is no item there to operate on.
 */
function FeatureBlock({
  block,
  group,
  view,
  actions,
  first,
}: {
  block: IssueGroup;
  group: BacklogGroup;
  view: CockpitView;
  actions: CockpitActions;
  first: boolean;
}): JSX.Element {
  const rows = block.issues.map((issue) => (
    <Row key={issue.id} issue={issue} group={group} view={view} actions={actions} nested={block.kind === 'feature'} />
  ));

  if (block.kind === 'untracked') return <>{rows}</>;
  if (block.kind === 'orphans') {
    return (
      <>
        <div className={`cn-subhead ${first ? '' : 'cn-subhead-gap'}`}>
          <b className="cn-name">No parent feature</b>
          <span className="cn-sub">Nothing records why these are being done · link them in the tracker</span>
        </div>
        {rows}
      </>
    );
  }

  const feature = block.feature;
  const featureIssue = block.featureIssue;
  const collapsed = feature !== null && view.collapsedFeatures.has(feature.number);
  const { shown, children } = groupProgress(block);
  // Both numbers, and only when they differ: "3 children" above two rows reads as
  // a row that failed to draw, and "2" above a feature with three hides one.
  const count = children !== null && children !== shown ? `${shown} of ${children} shown` : `${shown} shown`;

  return (
    <>
      <div className={`cn-subhead ${first ? '' : 'cn-subhead-gap'}`}>
        <button
          type="button"
          className="cn-fold"
          aria-expanded={!collapsed}
          onClick={() => feature !== null && actions.collapseFeature(feature.number, !collapsed)}
          title={collapsed ? 'Show the work under this feature' : 'Fold this feature away'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {featureIssue === null ? (
          // A feature the world does not hold as an issue of its own — the usual
          // case under a tag or assignee filter. It is a label reconstructed from
          // a child's `parent`, so there is nothing here to open or to tag.
          <span className="cn-grow cn-goal-row">
            <b className="cn-name">
              #{feature?.number} {feature?.title}
            </b>
            <span className="cn-sub">
              {feature?.issueType} · {feature?.workItemState} · not in the filtered item list · {count}
            </span>
          </span>
        ) : (
          <button
            type="button"
            className="cn-grow cn-goal-row"
            onClick={() => actions.selectGoal(`issue:${featureIssue.number}`)}
            title="Open this feature's page — its children, its plan and anything it is asking you"
          >
            <b className="cn-name">
              #{featureIssue.number} {featureIssue.title}
            </b>
            <span className="cn-sub">
              {featureIssue.issueType} · {featureIssue.workItemState ?? featureIssue.state} · {count}
            </span>
          </button>
        )}
        {featureIssue !== null && <WatchToggle issue={featureIssue} group={group} view={view} actions={actions} />}
      </div>
      {!collapsed && rows}
      {!collapsed && rows.length === 0 && <p className="cn-empty cn-nested">Nothing under it in this group.</p>}
    </>
  );
}

/**
 * One item: what it is, what the harness is doing about it in the harness's own
 * words, and the one control that changes that.
 *
 * **The name opens the goal's page**, through the same `selectGoal` a queue row
 * and an overview row call — one way into a goal, from everywhere that lists one.
 * It is the name rather than the whole row, which is how the overview does it,
 * because a backlog row carries controls of its own and a button cannot hold
 * them. That is also why the number is drawn plainly here instead of through
 * `refLink`: a link inside a button is a second destination for one click.
 *
 * The gate labels are dropped from the chips. Which group a row is filed under
 * already states its watch state, and the toggle beside it states it again — a
 * third copy on the row is the noise that made the World panel unreadable.
 */
function Row({
  issue,
  group,
  view,
  actions,
  nested = false,
}: {
  issue: Issue;
  group: BacklogGroup;
  view: CockpitView;
  actions: CockpitActions;
  /** Indented under a feature heading, rather than sitting flush in a flat list. */
  nested?: boolean;
}): JSX.Element {
  const { config } = view.state;
  const assay = issue.assay;
  // The assayer's sentence, quoted whole. It is the only account of why this goal
  // is held, so a paraphrase here would be the only account there is, and wrong.
  const detail =
    group === 'intake' && assay !== null
      ? `Assay: ${assay.verdict} — “${assay.summary}”`
      : (issue.pickup.reasons[0] ?? null);
  const labels = issue.labels.filter((label) => label !== config.watchLabel && label !== config.ignoreLabel);

  return (
    <div className={`cn-row ${group === 'ignored' ? 'cn-spent' : ''} ${nested ? 'cn-nested' : ''}`}>
      {group === 'intake' && <i className="cn-lamp cn-wait" />}
      <button
        type="button"
        className="cn-grow cn-goal-row"
        onClick={() => actions.selectGoal(`issue:${issue.number}`)}
        title="Open this goal — its plan, its ticket, its pull requests and anything it is asking you"
      >
        <b className="cn-name">
          #{issue.number} {issue.title}
        </b>
        <span className={`cn-sub cn-wrap ${group === 'intake' ? 'cn-held' : ''}`}>
          {issue.issueType !== undefined && `${issue.issueType} · `}
          {issue.workItemState ?? issue.state}
          {detail !== null && ` · ${detail}`}
        </span>
      </button>
      {labels.map((label) => (
        <i className="cn-lbl" key={label}>
          {label}
        </i>
      ))}
      {group === 'intake' && (
        <AsyncButton
          className="ghost"
          onClick={() => actions.setIssueAssay(issue.number, 'workable')}
          title="Work it anyway — the harness stops holding pickup and runs a cycle now"
        >
          Override → workable
        </AsyncButton>
      )}
      <WatchToggle issue={issue} group={group} view={view} actions={actions} />
    </div>
  );
}

/**
 * The one control on a row or a feature heading, and what it costs.
 * `setIssueWatched` writes *both* tags — watching clears the ignore tag,
 * un-watching adds it — so the titles say what the click does rather than what
 * the label reads.
 *
 * **On a container it cascades**, and the title says so with the number it will
 * write. A container is still never dispatched at, but watching one is no longer
 * the empty click it once was: the tags go on every descendant, which is what
 * "work this feature" has always meant, and un-watching walks the same tree. That
 * is why the control is live in both directions here, where it used to be
 * disabled in the direction that would opt the item in.
 *
 * A deployment with the gate off (`labelPrefix: ''`) is still refused: there is
 * no tag to write in either direction, and a button that writes nothing is worse
 * than one that says why.
 */
function WatchToggle({
  issue,
  group,
  view,
  actions,
}: {
  issue: Issue;
  group: BacklogGroup;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { watchLabel, ignoreLabel, containerTypes } = view.state.config;
  const watched = group === 'watched' || group === 'intake';
  const off = watchLabel === '' ? 'No watch label configured — the watch/ignore gate is off' : null;
  // The heading's own children, which is what the cascade reaches first. The
  // server walks the whole tree; the count here is the one the operator can see,
  // and it is stated as "and its N children" rather than as a total the row
  // cannot back up.
  const kids = isContainerType(issue, containerTypes) ? (issue.children?.length ?? 0) : 0;
  const also = kids === 0 ? '' : ` and its ${kids} child item${kids === 1 ? '' : 's'}`;

  const label = watched ? 'Watching' : group === 'ignored' ? 'Un-ignore' : 'Watch';
  const title = watched
    ? `Drop #${issue.number}${also}: remove "${watchLabel}" and tag "${ignoreLabel}", so the harness leaves it alone`
    : `Tag #${issue.number}${also} "${watchLabel}" so the harness picks it up${group === 'ignored' ? `, and drop "${ignoreLabel}"` : ''}`;

  return (
    <AsyncButton
      className="ghost"
      disabled={off !== null}
      onClick={() => actions.setIssueWatched(issue.number, !watched)}
      title={off ?? title}
    >
      {label}
    </AsyncButton>
  );
}
