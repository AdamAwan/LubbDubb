import { z } from 'zod';
import { issueOriginRef } from '../issueOrigins.js';
import { desktopIssueRef } from '../validation/desktop.js';
import { toolSchema } from './schema.js';
import { issueWatchGateReason } from '../dispatcher/issuePickup.js';
import { sequenceableFeatures, validateSequenceSubmission } from '../sequence/sequence.js';
import { watchLabelFor } from '../watchLabels.js';
import { toolJson, toolError } from './protocol.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import type { Issue } from '../types.js';

// → docs/spec/11-mcp-tools.md

const sequenceRead: DesktopToolFactory = (deps) => ({
  description:
    'Read the order the stories under a Feature are worked in: which stories wait on which, why the ' +
    'sequencer said so, and whether anybody has accepted it. Pass the Feature number, or the number of any ' +
    'story under it — a story resolves to its parent, because an order is a statement about a Feature. Call ' +
    'this before sequence_amend: an amendment replaces the whole order, so you need to see what stands.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The Feature, or any story under it, e.g. 500.'),
    }),
  ),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const found = featureFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const sequence = deps.store.sequences.getFeatureSequence(found.originRef);
    return toolJson({
      feature: found.number,
      stories: found.stories.map((s) => ({ number: s.number, title: s.title, state: s.workItemState ?? s.state })),
      order:
        sequence === null
          ? null
          : {
              status: sequence.status,
              reason: sequence.reason,
              unsure: sequence.unsure,
              answeredBy: sequence.answeredBy,
              edges: sequence.edges,
            },
      next:
        sequence === null
          ? 'No order stands. sequence_amend writes one, and it lands accepted — so only write one you and the operator have agreed.'
          : 'sequence_amend replaces this whole order. Keep every edge you are not deliberately changing.',
    });
  },
});

const sequenceAmend: DesktopToolFactory = (deps, session) => ({
  description:
    'Rewrite the order the stories under a Feature are worked in, as the whole order rather than a patch — ' +
    'keep every edge you are not deliberately changing, since what you send replaces what stands. It lands ' +
    '**accepted**, so it holds work immediately: a story you put behind another will not start until that one ' +
    'has pushed a branch. Only write one the operator has agreed to. An empty order is how you say the ' +
    'stories are independent, and it releases everything the previous order held.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The Feature, or any story under it, e.g. 500.'),
      order: z
        .array(
          z.object({
            issue: z.number().describe('The story that waits.'),
            waitsOn: z.array(z.number()).describe('The stories it waits on.'),
            why: z.string().describe('One line on why this edge — what the first produces.'),
          }),
        )
        .describe(
          'One entry per story that waits on another. A story you do not list waits on nothing and starts ' +
            'immediately, so an empty list releases the whole order.',
        ),
      reason: z
        .string()
        .describe(
          'Why this order, in a few sentences — the whole of what the next person to read the Feature gets. ' +
            'This is the half a drag-to-reorder would have lost, which is why there is no drag.',
        ),
    }),
  ),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const found = featureFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const parsed = validateSequenceSubmission(
      args,
      found.stories.filter((s) => s.state === 'open').map((s) => s.number),
    );
    if (!parsed.ok) return toolError(`Order rejected: ${parsed.error}`);

    const standing = standingFor(deps, found.number);
    const stored = deps.store.sequences.recordFeatureSequence({
      originRef: found.originRef,
      status: 'accepted',
      reason: String(args.reason ?? '').trim(),
      unsure: null,
      standingKey: standing.key,
      edges: parsed.submission.edges.map((e) => ({ ...e, source: 'operator' as const })),
      members: standing.members,
      agentId: null,
      taskId: null,
    });
    const answered = deps.store.sequences.answerFeatureSequence(found.originRef, 'accepted', session.label) ?? stored;
    return toolJson({
      feature: found.number,
      accepted: true,
      edges: answered.edges.length,
      means:
        answered.edges.length === 0
          ? 'the order is released — every story under this Feature is eligible again, in whatever order the priority labels rank them.'
          : 'the order holds from the next pulse. A story behind another will not start until that one has pushed a branch, and the fleet will not propose a different order until the Feature gains or loses a story.',
    });
  },
});

function featureFor(
  deps: DesktopToolDeps,
  issue: number,
): { ok: true; number: number; originRef: string; stories: Issue[] } | { ok: false; error: string } {
  const issues = deps.store.world.getWorldBaseline()?.issues ?? [];
  const self = issues.find((i) => i.number === issue);
  const number = self?.parent?.number ?? issue;
  const stories = issues.filter((i) => i.parent?.number === number);
  if (stories.length === 0) {
    return {
      ok: false,
      error:
        `#${issue} resolves to Feature #${number}, and the harness can see no stories under it. An order is a ` +
        'statement about the stories a Feature has, so there is nothing here to order. Check the number, or ' +
        'that the stories carry the watch tag.',
    };
  }
  return { ok: true, number, originRef: issueOriginRef('root', number), stories };
}

function standingFor(deps: DesktopToolDeps, feature: number): { key: string; members: number[] } {
  const config = deps.briefConfig();
  const policy = {
    watchLabel: watchLabelFor(config.labelPrefix),
    requireOwnLabel: config.ownWorkOnly && config.userId !== undefined,
    priorityLabels: {},
    defaultPriority: 0,
  };
  const found = sequenceableFeatures(
    deps.store.world.getWorldBaseline()?.issues ?? [],
    config.issueContainerTypes,
    (issue) => issueWatchGateReason(issue, policy) === null,
    config.issueSequenceMaxChildren,
  ).find((f) => f.feature.number === feature);
  return {
    key: found?.key ?? '',
    members:
      found?.members ??
      (deps.store.world.getWorldBaseline()?.issues ?? [])
        .filter((i) => i.parent?.number === feature)
        .map((i) => i.number)
        .sort((a, b) => a - b),
  };
}

export const DESKTOP_SEQUENCE_TOOLS = {
  sequence_read: sequenceRead,
  sequence_amend: sequenceAmend,
} satisfies Record<string, DesktopToolFactory>;
