import { RETIRED_TOOL_NAMES, retiredToolMessage } from './names.js';
import { toolError, type McpTool } from './protocol.js';

/**
 * The withdrawn names, still answering — with a refusal that names `raise`.
 *
 * A module of its own, beside `tools.ts` and `desktopTools.ts`, because it is
 * neither: those two assemble the tools a channel *advertises*, and these are
 * advertised nowhere. Keeping them out of `tools.ts` is also what keeps the rule
 * that file is held to intact — one module per advertised tool, and no body in
 * the registry.
 *
 * **Hidden, so `tools/list` never offers them.** An agent must not be given five
 * doors onto one observation; that is what the withdrawal was for.
 *
 * **Dispatchable, so a call is answered rather than lost.** This is the whole
 * reason the names outlived their implementations. An operator's prompt override
 * written before the intake still says `report_finding`, and a name that is
 * simply gone comes back as an unknown method — which reaches the agent as a
 * broken channel rather than an out-of-date prompt, and appears in no reading
 * anywhere. Answered, it is a sentence the agent can act on *and* a recorded
 * call, so the Insights MCP tab names the deployment still reaching for it.
 *
 * **Nothing is forwarded.** A call shaped for a retired schema is not a `raise`
 * call, and quietly turning it into one would file a claim nobody wrote — with
 * the agent believing something else had happened. The message is the whole of
 * the handler.
 *
 * → `docs/spec/11-mcp-tools.md#retired-tools`
 */
export function retiredTools(): McpTool[] {
  return RETIRED_TOOL_NAMES.map((name) => ({
    name,
    hidden: true,
    description: retiredToolMessage(name),
    inputSchema: { type: 'object', properties: {} },
    handler: () => toolError(retiredToolMessage(name)),
  }));
}
