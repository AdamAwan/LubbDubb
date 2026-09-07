import { z } from 'zod';
import { describeLocalRun } from '../../localRun/describe.js';
import { toolSchema } from '../schema.js';
import { localValidationFixOriginParts, localValidationOriginParts } from '../../localValidation/origin.js';
import { toolError, toolJson } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const localRunRead: ToolFactory = ({ deps, task }) => ({
  description:
    "What the machine's dev environment is doing right now: whether it is up, its URL, the branch and commit " +
    'it has checked out, the ports it is holding, and the tail of the session bringing it up. Read it rather ' +
    'than guessing, and read it again rather than remembering — a bring-up takes minutes and this is the only ' +
    'thing that says where it has got to. It reports and nothing else: the environment belongs to the ' +
    'operator, and you cannot start, stop or restart it from here.',
  inputSchema: toolSchema(z.object({})),
  handler: () => {
    if (localValidationOriginParts(task.originRef) === null && localValidationFixOriginParts(task.originRef) === null)
      return toolError(
        "This tool belongs to a local validation, and you were not dispatched for one. The machine's dev " +
          "environment is the operator's, and what it has checked out is very likely not your branch.",
      );
    const local = deps.localRun?.();
    if (!local)
      return toolError('The local run is not wired on this deployment, so there is no environment to report on.');
    return toolJson(describeLocalRun(local.runner, local.watch));
  },
});
