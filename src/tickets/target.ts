import type { Config } from '../config/config.js';
import { trackerCoordinates } from '../mcp/findings.js';
import { ticketAssignee } from './ticketAssignment.js';
import { bugFilingType, filingType } from './ticketTypes.js';
import { watchLabelFor } from '../watchLabels.js';

// → docs/spec/13-jobs-and-tickets.md

interface TicketFilingTarget {
  tracker: string | null;
  provider: string;
  canFile: boolean;
  watchLabel: string | null;
  labelAuthorship: 'own' | 'anyone';
  assignee: string | null;
  storyType: string | null;
  bugType: string | null;
  containerTypes: string[];
  parentedTypes: string[];
  pickupStates: string[] | null;
  blockers: string[];
  cautions: string[];
}

export function ticketFilingTarget(config: Config): TicketFilingTarget {
  const tracker = trackerCoordinates(config);
  const label = watchLabelFor(config.labelPrefix);
  const watchLabel = label === '' ? null : label;
  const ownLabel = config.ownWorkOnly && config.userId !== undefined;
  const assignee = ticketAssignee(config);
  const pickupStates = config.issuePickupStates ?? null;

  const blockers: string[] = [];
  const cautions: string[] = [];

  if (tracker === null) {
    blockers.push(
      `The issues provider is "${config.integrations.issues}" with no configuration behind it, so this ` +
        'harness has no tracker to file into and nothing filed anywhere else can be read back.',
    );
  }
  if (watchLabel === null) {
    cautions.push(
      'labelPrefix is empty, so the watch gate is off and the harness acts on every open issue. There is no ' +
        'tag to carry and none is written.',
    );
  } else if (ownLabel) {
    cautions.push(
      `ownWorkOnly is on, so the watch label counts only where "${config.userId}" added it. A "${watchLabel}" ` +
        'put on by anybody else reads as unwatched and the goal is never picked up — file through job_create, ' +
        "which tags it under the harness's own credential.",
    );
  }
  if (assignee === null && ownLabel) {
    cautions.push('userId is set but the provider cannot take an assignee, so the item is filed unassigned.');
  }
  if (pickupStates !== null && pickupStates.length > 0) {
    cautions.push(
      `Only items in ${pickupStates.map((s) => `"${s}"`).join(', ')} are picked up. A new item that lands in ` +
        'some other state waits there until somebody moves it.',
    );
  }

  return {
    tracker,
    provider: config.integrations.issues,
    canFile: tracker !== null,
    watchLabel,
    labelAuthorship: ownLabel ? 'own' : 'anyone',
    assignee,
    storyType: filingType(config),
    bugType: bugFilingType(config),
    containerTypes: config.issueContainerTypes,
    parentedTypes: config.issueParentedTypes,
    pickupStates,
    blockers,
    cautions,
  };
}
