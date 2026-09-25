import { z } from 'zod';
import { applyIssueWatch } from '../issueWatch.js';
import { toolSchema } from './schema.js';
import { applyProfilePin } from '../intake/profilePin.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { desktopIssueRef } from '../validation/desktop.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/11-mcp-tools.md

type WatchOutcome = Awaited<ReturnType<typeof applyIssueWatch>>;

const GOAL_CONTROL_INPUT = toolSchema(
  z.object({
    issue: z.number().describe('The goal number, e.g. 284.'),
    watched: z
      .boolean()
      .describe(
        'true tags the ticket so the harness picks it up; false takes the tag off so nothing further is ' +
          'dispatched for it. Cascades to every ticket under a container.',
      )
      .optional(),
    priority: z
      .boolean()
      .describe(
        'true ranks everything dispatched under this goal ahead of the natural order until it is cleared; ' +
          'false clears the mark.',
      )
      .optional(),
    profile: z
      .string()
      .describe(
        'The model profile this goal\'s work runs on, by name, or "" to clear the pin. This is the answer ' +
          "the appraiser's profile question is waiting for, and giving it settles that question whichever " +
          'name you pick — including keeping the one the goal already had.',
      )
      .optional(),
  }),
);

function pinProfile(deps: DesktopToolDeps, issue: number, profile: string): ReturnType<typeof applyProfilePin> {
  return applyProfilePin(
    {
      store: deps.store,
      sink: deps.connector,
      errors: deps.errors,
      labelPrefix: deps.labelPrefix,
      agentModels: deps.agentModels,
    },
    issue,
    profile.trim() || null,
  );
}

function writeWatch(deps: DesktopToolDeps, issue: number, watched: boolean): Promise<WatchOutcome> {
  return applyIssueWatch(
    {
      store: deps.store,
      sink: deps.connector,
      errors: deps.errors,
      labelPrefix: deps.labelPrefix,
      issueContainerTypes: deps.issueContainerTypes,
    },
    issue,
    watched,
    `while ${watched ? 'watching' : 'dropping'} #${issue} from the desktop channel`,
  );
}

function watchRefused(outcome: WatchOutcome): boolean {
  return Boolean(outcome.label) && outcome.failed.length > 0 && outcome.landed.length === 0;
}

function watchRefusal(issue: number, outcome: WatchOutcome, priorityWritten: boolean): string {
  return (
    `The provider refused the watch tag on #${issue}: ${outcome.failed[0]?.message ?? 'unknown error'}. ` +
    `Nothing was tagged${priorityWritten ? ', though the priority mark above was written' : ''}.`
  );
}

function describeWatch(outcome: WatchOutcome, watched: boolean): Record<string, unknown> {
  if (!outcome.label)
    return {
      watched,
      wrote: 0,
      note: 'This deployment configures no labelPrefix, so the watch gate is off and every ticket is worked. There was no tag to write.',
    };
  return {
    watched,
    wrote: outcome.landed.length,
    cascaded: Math.max(outcome.targets.length - 1, 0),
    kept: outcome.failed.map((f) => `#${f.number}: ${f.message}`),
  };
}

function goalControlReply(
  issue: number,
  watch: Record<string, unknown> | null,
  priority: boolean | null,
  profile: { profile: string | null; answered: boolean } | null,
): Record<string, unknown> {
  return {
    issue,
    watch,
    priority,
    profile: profile === null ? undefined : profile.profile,
    profileQuestionAnswered: profile === null ? undefined : profile.answered,
    means:
      'this changes what the harness picks up next and in what order. Nothing running was stopped: an agent ' +
      'already working this goal carries on, and un-watching only stops the next dispatch.' +
      (profile?.answered === true
        ? ' The profile question the appraisal was holding this goal on is answered, so it is released.'
        : ''),
  };
}

export const goalControl: DesktopToolFactory = (deps) => ({
  description:
    'Say whether the harness should work a goal, and whether it should work it first. `watched` puts the ' +
    'watch tag on the ticket (and every ticket beneath it) or takes it off — that is what opts work in and ' +
    "out. `priority` is the harness's own mark and only re-orders its queue. Neither starts or stops an agent " +
    'that is already running.',
  inputSchema: GOAL_CONTROL_INPUT,
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const wantsWatch = typeof args.watched === 'boolean';
    const wantsPriority = typeof args.priority === 'boolean';
    const wantsProfile = args.profile !== undefined;
    if (!wantsWatch && !wantsPriority && !wantsProfile)
      return toolError('Nothing to do — give `watched`, `priority` or `profile`. To read the goal, call goal_read.');

    let profile: { profile: string | null; answered: boolean } | null = null;
    if (wantsProfile) {
      if (typeof args.profile !== 'string') return toolError('profile must be a string, or "" to clear the pin.');
      const pinned = await pinProfile(deps, ref.issue, args.profile);
      if (!pinned.ok) return toolError(pinned.error);
      profile = { profile: pinned.profile, answered: pinned.answered };
    }

    let priority: boolean | null = null;
    if (wantsPriority) {
      deps.store.priority.setGoalPriority(issueConclusionOrigin(ref.issue), args.priority as boolean);
      priority = args.priority as boolean;
    }

    let watch: Record<string, unknown> | null = null;
    if (wantsWatch) {
      const watched = args.watched as boolean;
      const outcome = await writeWatch(deps, ref.issue, watched);
      if (watchRefused(outcome)) return toolError(watchRefusal(ref.issue, outcome, priority !== null));
      watch = describeWatch(outcome, watched);
    }

    await deps.runCycle();
    return toolJson(goalControlReply(ref.issue, watch, priority, profile));
  },
});
