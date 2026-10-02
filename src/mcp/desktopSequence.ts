import { z } from 'zod';
import { issueOriginRef } from '../issueOrigins.js';
import { desktopIssueRef } from '../validation/desktop.js';
import { toolSchema } from './schema.js';
import { issueWatchGateReason } from '../dispatcher/issuePickup.js';
import { sequenceableFeatures, validateSequenceSubmission } from '../sequence/sequence.js';
import { watchLabelFor } from '../watchLabels.js';
import { toolJson, toolError } from './protocol.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import type { FeatureSequence, Issue } from '../types.js';

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
      order: describeSequence(sequence),
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

const sequenceAnswer: DesktopToolFactory = (deps, session) => ({
  description:
    'Accept or decline the order that stands on a Feature — usually one the sequencer proposed and nobody ' +
    'has answered. "accept" makes it **hold work** from the next pulse: a story behind another will not ' +
    'start until that one has pushed a branch. "decline" says the stories are independent and releases ' +
    'every hold; it is a real answer, stored, and the fleet will not propose again until the Feature gains ' +
    'or loses a story. Read it with sequence_read first, and only answer the way the operator has said to. ' +
    'To change the order rather than answer it, use sequence_amend.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The Feature, or any story under it, e.g. 500.'),
      answer: z
        .enum(['accept', 'decline'])
        .describe('"accept" holds work behind the order; "decline" releases every story under the Feature.'),
    }),
  ),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    if (args.answer !== 'accept' && args.answer !== 'decline')
      return toolError('answer must be "accept" or "decline".');
    const found = featureFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const before = deps.store.sequences.getFeatureSequence(found.originRef);
    const answered = deps.store.sequences.answerFeatureSequence(
      found.originRef,
      args.answer === 'accept' ? 'accepted' : 'declined',
      session.label,
    );
    if (answered === null)
      return toolError(
        `Feature #${found.number} has no order to answer — none was proposed, or it has just been re-proposed. ` +
          'Call sequence_read for what stands now.',
      );
    return toolJson({
      feature: found.number,
      was: before?.status ?? null,
      order: describeSequence(answered),
      means:
        answered.status === 'declined'
          ? 'every story under this Feature is eligible again, in whatever order the priority labels rank them. The fleet will not propose an order again until the Feature gains or loses a story.'
          : answered.edges.length === 0
            ? 'the order is accepted and holds nothing — it has no edges, so every story is eligible.'
            : 'the order holds from the next pulse. A story behind another will not start until that one has pushed a branch.',
    });
  },
});

export interface FoundFeature {
  number: number;
  originRef: string;
  feature: Issue | null;
  stories: Issue[];
  observedAt: string | null;
}

export function describeSequence(sequence: FeatureSequence | null): Record<string, unknown> | null {
  return sequence === null
    ? null
    : {
        status: sequence.status,
        reason: sequence.reason,
        unsure: sequence.unsure,
        answeredBy: sequence.answeredBy,
        edges: sequence.edges,
      };
}

export function featureFor(
  deps: DesktopToolDeps,
  issue: number,
): ({ ok: true } & FoundFeature) | { ok: false; error: string } {
  const world = deps.store.world.getWorldBaseline();
  const issues = world?.issues ?? [];
  const self = issues.find((i) => i.number === issue);
  const number = self?.parent?.number ?? issue;
  const stories = issues.filter((i) => i.parent?.number === number);
  if (stories.length === 0) {
    return {
      ok: false,
      error:
        `#${issue} resolves to Feature #${number}, and the harness can see no stories under it. Check the ` +
        'number, or that the stories carry the watch tag.',
    };
  }
  return {
    ok: true,
    number,
    originRef: issueOriginRef('root', number),
    feature: issues.find((i) => i.number === number) ?? null,
    stories,
    observedAt: world?.takenAt ?? null,
  };
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
  sequence_answer: sequenceAnswer,
} satisfies Record<string, DesktopToolFactory>;
