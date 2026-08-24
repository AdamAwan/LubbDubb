import { GOAL_ASSAY_VERDICT_HELP, GOAL_ASSAY_VERDICTS, validateGoalAssay } from '../goalAssay.js';
import { truncateAreaPaths } from '../../intake/placement.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const assayIssue: ToolFactory = ({ deps, agent, ok }) => {
  // The deployment's own profiles, cheapest first. Empty when no `agentModels` is
  // configured, and then the argument is neither offered nor required — there is
  // nothing to choose between, and a tool that asked anyway would be asking the
  // agent to invent a vocabulary.
  const profiles = deps.profiles ?? [];
  const names = profiles.map((p) => p.name);
  // The project's area tree as the harness last read it, capped. Empty for a
  // tracker with no such concept (GitHub, the fake) and for a deployment whose
  // first read has not landed yet — and then the argument is neither offered nor
  // accepted, exactly as an absent `agentModels` retires the profile.
  const tree = deps.areaPaths?.() ?? null;
  const areas = tree === null ? { paths: [], omitted: 0 } : truncateAreaPaths(tree);
  return {
    description:
      'Say whether the ISSUE you were dispatched to assay can be worked from at all. You are standing in ' +
      'front of the work, not doing it: nothing has been dispatched for this issue yet, and your verdict ' +
      'decides whether anything is. Read the ticket against the repository you are in. Say "workable" ' +
      'if there is an identifiable goal an agent could start on — the bar is *actionable*, not *good*, ' +
      'and a large or opinionated ticket is still workable. Say "unclear" only when starting would be ' +
      'guessing: nobody could tell what "done" means, the ticket contradicts itself or the repository, ' +
      'or it refers to things that do not exist. An "unclear" verdict stops the harness scheduling ' +
      'anything for this issue until the ticket is edited, someone comments on it, or a human overrides ' +
      'you — so it is a question you are asking a person, and your summary is the whole of what they ' +
      'have to answer. Do not implement anything and do not open a pull request.' +
      (names.length > 0
        ? ' You also size the work: say which model profile the rest of this issue should run on. ' +
          'This deployment has, cheapest first — ' +
          profiles.map((p) => `"${p.name}": ${p.description}`).join('; ') +
          '. Judge what the ticket would actually take against this repository, not how long the ' +
          'ticket is. If your answer differs from what is already set for this issue, a human is ' +
          'asked to confirm it before anything is dispatched, so say what you think rather than ' +
          'what you expect to be agreed with.'
        : '') +
      ' You also say where this item belongs on the backlog, if it is not already filed. Both are optional' +
      ' and both are only a proposal: a human confirms each in one click, and the harness does the write —' +
      ' never you, and never a shell command. Omit either where the item already has one or where you' +
      ' cannot support an answer from what you have read. Getting it wrong costs nothing; guessing' +
      ' confidently is what costs, because a plausible answer is the one nobody checks.' +
      (areas.paths.length > 0
        ? ` This project's areas are: ${areas.paths.join(', ')}.` +
          (areas.omitted > 0
            ? ` (${areas.omitted} more are not listed here — if none of the above is right, omit area_path` +
              ` rather than picking the nearest.)`
            : '')
        : ''),
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...GOAL_ASSAY_VERDICTS],
          description: GOAL_ASSAY_VERDICTS.map((v) => `${v}: ${GOAL_ASSAY_VERDICT_HELP[v]}`).join('. '),
        },
        summary: {
          type: 'string',
          description:
            'For "unclear": precisely what you would need in order to start, phrased for the person who ' +
            'wrote the ticket — the specific question, not "it is vague". For "workable": one sentence ' +
            'saying what you understood the goal to be, so a wrong reading is visible before an agent ' +
            'acts on it.',
        },
        ...(names.length > 0
          ? {
              profile: {
                type: 'string',
                enum: names,
                description:
                  'Which model profile this issue\'s work should run on. Required with "workable"; ' +
                  'ignored with "unclear", since a goal nobody can start from has no work to size. ' +
                  profiles.map((p) => `${p.name}: ${p.description}`).join('. '),
              },
            }
          : {}),
        parent: {
          type: 'integer',
          description:
            'The number of the container work item this issue should hang off, if it has none and you can ' +
            'say which. The open containers the harness can see are listed under "Related tracker items" ' +
            'in your prompt, and you are not limited to them — a board is narrowed by tag and assignee, so ' +
            'the right one may not be listed. Omit it entirely if the item already belongs to something, ' +
            'or if none of them fit.',
        },
        ...(areas.paths.length > 0
          ? {
              area_path: {
                type: 'string',
                enum: [...areas.paths],
                description:
                  'The area path this issue should be filed under, if it is still on the project root. ' +
                  'This is what puts it on a team board, so an item left unfiled is invisible to whoever ' +
                  'plans the backlog. Choose from the list; omit it if none of them is right.',
              },
            }
          : {}),
      },
      required: ['status', 'summary'],
    },
    handler: (args) => {
      const parsed = validateGoalAssay(args, names, areas.paths);
      if (!parsed.ok) return toolError(`Assay rejected: ${parsed.error}`);
      // Structural identity, and here it decides whether there is anything to
      // assay at all: an agent already doing the work is refused rather than
      // scoped down, because it would be parking an issue it is mid-way through.
      const result = deps.agents.recordAssay(agent.id, parsed.verdict, parsed.summary, parsed.profile, {
        parent: parsed.parent,
        areaPath: parsed.areaPath,
      });
      if (!result.ok) return toolError(result.error);
      return ok({
        assayed: true,
        issue: result.issueOrigin,
        status: result.verdict,
        profile: parsed.profile,
        parent: parsed.parent,
        areaPath: parsed.areaPath,
        note:
          parsed.verdict === 'workable'
            ? 'Recorded. The issue proceeds exactly as it would have — this verdict schedules nothing ' +
              'itself, it only stops the assay being asked again for this version of the ticket.' +
              (parsed.parent !== null || parsed.areaPath !== null
                ? ' Your placement suggestions are held for a human to confirm. They hold nothing up and ' +
                  'they disappear on their own if the item turns out to already have one, so there is ' +
                  'nothing further for you to do about them.'
                : '') +
              (result.profileHeld === true
                ? ' Your profile differs from what is set for this issue, so nothing is dispatched for it ' +
                  'until a human confirms which to use. That is one click and it is not a rejection.'
                : '')
            : 'Recorded. Nothing is dispatched for this issue while the verdict stands. It ends by ' +
              'itself the moment the ticket is edited or anything happens on it, and an operator can ' +
              'clear it outright. The ticket is not closed and nothing is rejected — that stays a ' +
              'human decision.',
      });
    },
  };
};
