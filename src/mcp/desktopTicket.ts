import { z } from 'zod';
import { ticketFilingTarget } from '../tickets/target.js';
import { toolSchema } from './schema.js';
import { toolJson } from './protocol.js';
import type { DesktopToolFactory } from './desktopContext.js';

// → docs/spec/11-mcp-tools.md

const TICKET_TARGET_NEXT =
  'File through job_create with kind "code" — it puts the item on this tracker carrying the tag, the type ' +
  'and the assignee above, none of which a hand-written "gh issue create" or "az boards work-item create" ' +
  'gets right by accident, and each of which fails silently: the item is created, it reads as filed, and ' +
  'nothing is ever dispatched for it. Read "blockers" before drafting and "cautions" before promising the ' +
  'operator it will be picked up.';

export const ticketTarget: DesktopToolFactory = (deps) => ({
  description:
    'Where a ticket filed from here lands, and what it will carry: the tracker this harness reads issues ' +
    'from, the watch tag that decides whether anything is ever dispatched for it, who it is assigned to, the ' +
    'work item type, which types are containers rather than work, and the states an item has to be in to be ' +
    'picked up. Call this before drafting a ticket, and before telling anybody where one went.',
  inputSchema: toolSchema(z.object({})),
  handler: () => toolJson({ ...ticketFilingTarget(deps.briefConfig()), next: TICKET_TARGET_NEXT }),
});
