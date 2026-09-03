import { describeLocalRun } from '../../localRun/describe.js';
import { localValidationFixOriginParts, localValidationOriginParts } from '../../localValidation/origin.js';
import { toolError, toolJson } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const localRunRead: ToolFactory = ({ deps, task }) => ({
  description:
    "What the machine's dev environment is doing right now: whether it is up, its URL, the branch and commit " +
    'it has checked out, the ports it is holding, and the tail of the session bringing it up. Read it rather ' +
    'than guessing, and read it again rather than remembering — a bring-up takes minutes and this is the only ' +
    'thing that says where it has got to. It reports and nothing else: the environment belongs to the ' +
    'operator, and you cannot start, stop or restart it from here.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    // Fenced to the two dispatches this feature makes, and to nothing else. Not
    // because the reading is sensitive — it is on the cockpit's own page — but
    // because a tool advertised to every agent is a tool every agent may reach for,
    // and an agent building a plan part has no business consulting an environment
    // running somebody else's branch.
    if (localValidationOriginParts(task.originRef) === null && localValidationFixOriginParts(task.originRef) === null)
      return toolError(
        "This tool belongs to a local validation, and you were not dispatched for one. The machine's dev " +
          "environment is the operator's, and what it has checked out is very likely not your branch.",
      );
    const local = deps.localRun?.();
    if (!local)
      return toolError('The local run is not wired on this deployment, so there is no environment to report on.');
    // Deliberately outside the `_status` envelope: this is a reading of a machine
    // rather than of the agent's own dispatch, and folding the fleet's status into
    // it would put two unrelated answers in one payload.
    return toolJson(describeLocalRun(local.runner, local.watch));
  },
});
