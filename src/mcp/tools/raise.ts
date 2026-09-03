import { extractKeys, gateKeys } from '../../obstacles/keys.js';
import { buildObstacleWorld, reportedChecks } from '../../obstacles/world.js';
import { lookupFor, ownBreakage, validateRaisedObstacle } from '../../obstacles/intake.js';
import { corroborationGoal } from '../../knowledge/knowledge.js';
import { toolError } from '../protocol.js';
import type { ObstacleKind } from '../../types.js';
import type { ToolFactory } from './context.js';

/**
 * The one door: anything in an agent's way that is not its goal, and anything true
 * of this repository that the repository does not say.
 *
 * **What this replaces is a question the agent was never in a position to answer.**
 * Filing an observation used to mean choosing between `report_finding` (and then
 * which of its four kinds), `knowledge_propose`, `knowledge_notice`,
 * `knowledge_contradict` and a retrospective's `lessons` field — six doors sorted
 * by *what an operator would do about it*, which is knowledge the operator has and
 * the agent does not. The intake collapsed those to one; the obstacle board
 * (`docs/spec/27-obstacles.md`) keeps the one door and reshapes what is asked
 * through it.
 *
 * The routing, and the whole of it — no kind, no lifetime word, no destination.
 * One boolean the agent can always answer, *would a fix make this go away?*:
 *
 * - true → an **obstacle**, something broken now that a fix ends
 * - false, or unsaid → a **note**, something true of the repository that the
 *   repository does not say, which ends by being written down
 *
 * Both land on the same board through the same `recordObstacleSighting`, and both
 * calls are the lookup.
 *
 * **Reporting is the lookup.** There is no search tool: an agent does not search on
 * a hunch, and searching would require it to guess the words somebody else used —
 * the failure a search tool had. It calls something the moment it is in pain, so
 * the pain call returns the answer, in one round trip, with no model call and
 * nothing to wait for. The report is filed either way and never held pending a
 * reply.
 *
 * **The gate is the same on both arms.** A row reaches nobody until a second
 * independent voice has said it. Making it easier to file costs nothing, because
 * filing has never been what puts a sentence in front of the fleet.
 */
export const raise: ToolFactory = ({ deps, agent, task, ok }) => {
  // The goal, never the origin and never the agent: `pr:412:ci` and
  // `pr:412:comments` are two origins of one observation, and the count of
  // independent voices is the whole of what carries a row to `standing`.
  const goalRef = corroborationGoal(task.originRef);
  return {
    description:
      'Raise something that is in your way and is not your goal, or something true of this repository that ' +
      'the repository does not say. A check failing for reasons nothing to do with your change, a base branch ' +
      'somebody else broke, a bug in code nobody is touching, a seam this repository does not document.\n\n' +
      'Call it the moment you are in pain, not at the end. **The call is the lookup**: it answers with whether ' +
      'anybody else has hit this, who owns it if anyone does, and what they saw — in one round trip, with ' +
      'nothing to wait for. There is no search tool, because searching would mean guessing the words somebody ' +
      'else used.\n\n' +
      'You do not have to work out what kind of thing it is. Answer one question — would a fix make this go ' +
      'away? — and the harness works out the rest from what you wrote and the dispatch you are on.\n\n' +
      'It reaches no other agent on your say-so, it queues no work and it dispatches nobody. Raise it and ' +
      'carry straight on: do not go fixing what you just reported.\n\n' +
      'Not the place for: what you are doing right now (note_progress), a note to the other agents on your ' +
      'own goal (scratch_append), or something you need answered before you can continue (escalate — this ' +
      'parks nobody and is not a way to wait).',
    inputSchema: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          description:
            'One line, in your own words, saying what you hit. State the thing, not what to do about it. ' +
            'Write it for whoever reads it next month rather than for whoever is reading your own task: the ' +
            'harness knows your goal from your credential and takes any mention of it back out.',
        },
        why_not_mine: {
          type: 'string',
          description:
            'Why this is not your own change doing — and for something you are simply writing down, what you ' +
            'actually saw that makes it true: the command, the error, the file. Required, and nothing ' +
            'validates it: writing it down is what makes you check before you answer, and it is what an ' +
            'operator reads when the routing turns out wrong.',
        },
        fix_makes_it_go_away: {
          type: 'boolean',
          description:
            'True if a fix would end it — a red check, a wedged runner, a bug nobody is on. False if it is ' +
            'something true of this repository that a fix would not change, which ends by being written down ' +
            'rather than by being fixed. It is the only classification asked of you, and it is the only one ' +
            'you are in a position to make.',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional. What identifies it, as "check:<name>", "test:<file> > <name>", "path:<file>", ' +
            '"signature:<first line of the error>" or "cmd:<command>". Leave it out and the harness reads ' +
            'them out of what you wrote and the dispatch you are on. Anything that names nothing real is ' +
            'dropped and your report is kept — nothing here is ever refused for a key.',
        },
        blocks_me: {
          type: 'boolean',
          description:
            'True only if this stops you finishing the task you were dispatched for — the base will not ' +
            'build, the thing you must change is behind it. Not "it is annoying" and not "it made this ' +
            'slower": say true and you will be told to conclude `blocked`, which parks your goal until the ' +
            'obstacle clears rather than failing it. Everything else, carry on and work around it.',
        },
        until: {
          type: 'number',
          description:
            'Only if what you saw will STOP being true: how many hours you expect it to last. A check timing ' +
            'out all afternoon, a registry refusing installs. A backstop and never the mechanism — what ends ' +
            'it is the world clearing it or somebody fixing it.',
        },
      },
      required: ['what', 'why_not_mine'],
    },
    handler: (args) => {
      const raised = validateRaisedObstacle(args, goalRef);
      if (!raised.ok) return toolError(`Not raised: ${raised.error}`);
      const report = raised.report;
      // The one classification asked of the agent, and the whole of the routing:
      // *would a fix make this go away?* Anything else — including saying nothing
      // — is a note, which is something true of the repository that ends by being
      // written down rather than by being fixed. It is a column on the row and
      // never a second door: an agent choosing a shelf is an agent choosing wrongly.
      const kind: ObstacleKind =
        (args as Record<string, unknown> | undefined)?.fix_makes_it_go_away === true ? 'obstacle' : 'note';
      const world = buildObstacleWorld({
        reported: reportedChecks(deps.store.getWorldBaseline()),
        dispatchChecks: task.ciChecks ?? [],
        branchPaths: goalRef === null ? [] : deps.store.listGoalFiles(goalRef).map((file) => file.path),
        repoRoot: deps.repoRoot ?? null,
      });
      const keys = gateKeys(
        extractKeys({ what: report.what, evidence: report.whyNotMine, world, declared: report.keys }),
        world,
      );
      // **An agent may not report its own breakage.** The harness holds the diff
      // already, so this is the only enforcement of *fix what you broke* that is
      // not a sentence in a prompt — and a sentence in a prompt is not an
      // enforcement. It refuses, names the file, and records nothing.
      const mine = ownBreakage(
        keys,
        deps.store.listFiles(agent.id).map((file) => file.path),
      );
      if (mine !== null) {
        return toolError(
          `Not raised: your own session wrote ${mine}, so this is yours to fix rather than to report. ` +
            `Nothing was recorded. If what you hit is genuinely elsewhere, raise it naming that instead — ` +
            `and if it is in your diff, fix it: an agent fixes what its own session broke.`,
        );
      }
      const outcome = deps.store.recordObstacleSighting(
        { what: report.what, kind, keys, untilHours: report.untilHours },
        {
          agentId: agent.id,
          taskId: task.id,
          goalRef,
          sessionId: agent.sessionId,
          transition: null,
          words: report.words,
          whyNotMine: report.whyNotMine,
        },
      );
      return ok({
        recorded: true,
        id: outcome.obstacle.id,
        ...lookupFor({
          obstacle: outcome.obstacle,
          voices: outcome.voices,
          sightings: deps.store.listObstacleSightings(outcome.obstacle.id),
          mine: outcome.sightingId,
          near: outcome.near,
          blocksMe: report.blocksMe,
        }),
      });
    },
  };
};
