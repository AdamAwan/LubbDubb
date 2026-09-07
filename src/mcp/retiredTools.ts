import { z } from 'zod';
import { RETIRED_TOOL_NAMES, retiredToolMessage } from './names.js';
import { toolSchema } from './schema.js';
import { toolError, type McpTool } from './protocol.js';

// → docs/spec/11-mcp-tools.md

export function retiredTools(): McpTool[] {
  return RETIRED_TOOL_NAMES.map((name) => ({
    name,
    hidden: true,
    description: retiredToolMessage(name),
    inputSchema: toolSchema(z.object({})),
    handler: () => toolError(retiredToolMessage(name)),
  }));
}
