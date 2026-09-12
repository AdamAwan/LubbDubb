import type { Config } from '../config/config.js';
import type { ActionSink } from '../sink/actionSink.js';
import { ticketAssignee } from '../ticketAssignment.js';
import { bugFilingType, filingType } from '../ticketTypes.js';

// → docs/spec/13-jobs-and-tickets.md

interface TicketFiling {
  title: string;
  body: string;
  labels?: string[];
  bug?: boolean;
  relatedTo?: number;
}

export type TicketFiler = (input: TicketFiling) => Promise<string>;

export function ticketFiler(config: Config, sink: ActionSink): TicketFiler {
  return async (input) => {
    const result = await sink.createIssue({
      title: input.title,
      body: input.body,
      labels: input.labels ?? [],
      type: input.bug ? bugFilingType(config) : filingType(config),
      assignee: ticketAssignee(config),
      relatedTo: input.relatedTo ?? null,
    });
    if (!result.ok || !result.ref) throw new Error('the tracker accepted the item but did not say what it created');
    return result.ref;
  };
}
