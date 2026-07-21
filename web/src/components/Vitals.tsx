import type { AppState } from '../types.js';

/**
 * The at-a-glance vitals strip: the handful of numbers that tell you whether the
 * harness needs you right now. Derived entirely from the current snapshot so it
 * stays in lock-step with the rest of the cockpit.
 */
export function Vitals({ state, liveAgents, cap }: { state: AppState; liveAgents: number; cap: number }) {
  const needsYou = state.escalations.filter((e) => e.status === 'open').length;
  const waiting = state.agents.filter((a) => a.status === 'waiting').length;
  const redPrs = state.world.pullRequests.filter((p) => p.ciStatus === 'failing').length;
  const conflicted = state.world.pullRequests.filter(
    (p) => !p.merged && (p.mergeableState === 'dirty' || p.mergeableState === 'behind'),
  ).length;
  const openComments = state.world.pullRequests.reduce(
    (n, p) => n + p.unresolvedComments.filter((c) => !c.handled).length,
    0,
  );
  const grooming = state.world.stories.filter(
    (s) => !s.description || !s.acceptanceCriteria || s.wafPillars.length === 0,
  ).length;
  const meetingsToPrep = state.world.calendar.filter((c) => !c.prepDone && c.prepDocs.length > 0).length;

  const items: { label: string; value: number; tone?: 'urgent' | 'warn' | 'ok'; hint: string }[] = [
    { label: 'Running', value: liveAgents, tone: liveAgents ? 'ok' : undefined, hint: `${liveAgents} of ${cap} slots` },
    { label: 'Needs you', value: needsYou, tone: needsYou ? 'urgent' : undefined, hint: 'open escalations' },
    { label: 'Parked', value: waiting, tone: waiting ? 'warn' : undefined, hint: 'agents awaiting input' },
    { label: 'CI red', value: redPrs, tone: redPrs ? 'urgent' : undefined, hint: 'PRs with failing CI' },
    {
      label: 'Conflicts',
      value: conflicted,
      tone: conflicted ? 'urgent' : undefined,
      hint: 'PRs behind / conflicting with base',
    },
    {
      label: 'Comments',
      value: openComments,
      tone: openComments ? 'warn' : undefined,
      hint: 'unhandled review comments',
    },
    { label: 'Grooming', value: grooming, tone: grooming ? 'warn' : undefined, hint: 'stories missing detail' },
    { label: 'Prep', value: meetingsToPrep, tone: meetingsToPrep ? 'warn' : undefined, hint: 'meetings needing prep' },
  ];

  return (
    <div className="vitals">
      {items.map((it) => (
        <div key={it.label} className={`vital ${it.tone ?? ''}`} title={it.hint}>
          <span className="vital-value">{it.value}</span>
          <span className="vital-label">{it.label}</span>
        </div>
      ))}
    </div>
  );
}
