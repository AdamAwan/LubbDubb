import { z } from 'zod';
import { issueOrigin } from '../plans/planning.js';
import { desktopIssueRef } from '../validation/desktop.js';
import { describeSequence, featureFor, type FoundFeature } from './desktopSequence.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson } from './protocol.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import type { Issue } from '../types.js';

// → docs/spec/11-mcp-tools.md#talking-about-a-feature

const featureRead: DesktopToolFactory = (deps) => ({
  description:
    "Read a Feature as the harness holds it: its ticket, the summariser's account of how it is going, the " +
    'order its stories are worked in, and every story under it with where each one is up to — its state, ' +
    'its plan, and whether the goal check is holding it. Pass the Feature number, or any story under it. ' +
    'Call this first when the operator wants to talk about a Feature; goal_read on one story is the way ' +
    'into its detail. Records nothing.',
  inputSchema: toolSchema(z.object({ issue: z.number().describe('The Feature, or any story under it, e.g. 500.') })),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const found = featureFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    return toolJson({
      ...featureRecord(deps, found),
      next:
        'Answer from this record. goal_read <story> for one story in detail; sequence_read / sequence_amend to ' +
        'change the order; job_create to add a story the Feature is missing. A summary of null means the ' +
        'summariser has not written one — say so rather than composing your own.',
    });
  },
});

function featureRecord(deps: DesktopToolDeps, found: FoundFeature): Record<string, unknown> {
  const summary = deps.store.tickets.getFeatureSummary(found.originRef);
  return {
    feature: {
      number: found.number,
      title: found.feature?.title ?? null,
      body: found.feature?.body ?? null,
      state: found.feature?.workItemState ?? found.feature?.state ?? null,
      url: found.feature?.url ?? null,
    },
    observedAt: found.observedAt,
    summary:
      summary === null
        ? null
        : {
            headline: summary.headline,
            standing: summary.standing,
            usable: summary.usable,
            blocked: summary.blocked,
            remaining: summary.remaining,
            writtenAt: summary.updatedAt,
          },
    order: describeSequence(deps.store.sequences.getFeatureSequence(found.originRef)),
    stories: found.stories.map((s) => storyLine(deps, s)),
  };
}

function storyLine(deps: DesktopToolDeps, s: Issue): Record<string, unknown> {
  const origin = issueOrigin(s.number);
  const plan = deps.store.plans.getPlanByOrigin(origin);
  const appraisal = deps.store.verdicts.getAppraisal(origin);
  return {
    number: s.number,
    title: s.title,
    state: s.workItemState ?? s.state,
    plan: plan === null ? null : plan.status,
    held: appraisal?.verdict === 'unclear' ? appraisal.summary : null,
  };
}

export const DESKTOP_FEATURE_TOOLS = {
  feature_read: featureRead,
} satisfies Record<string, DesktopToolFactory>;
