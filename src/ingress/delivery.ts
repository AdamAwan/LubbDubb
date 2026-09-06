import { z } from 'zod';
import { issueReadRef, prReadRef } from '../world/readPlan.js';

// → docs/spec/30-ingress.md

interface IngressEffect {
  refs: string[];
  summary: string;
}

const NOTHING = (summary: string): IngressEffect => ({ refs: [], summary });

const MAX_REFS = 16;

const EntityNumber = z.number().int().positive().max(2_147_483_647);

const Payload = z.object({}).passthrough();

export function githubEffect(event: string, payload: unknown): IngressEffect {
  const body = Payload.safeParse(payload);
  if (!body.success) return NOTHING(`${event} (no object payload)`);
  const data = body.data;

  switch (event) {
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
    case 'pull_request_review_thread': {
      const shape = z.object({
        number: EntityNumber.optional(),
        pull_request: z.object({ number: EntityNumber }).optional(),
      });
      const read = shape.safeParse(data);
      const number = read.success ? (read.data.pull_request?.number ?? read.data.number) : undefined;
      return refs(event, number === undefined ? [] : [prReadRef(number)]);
    }
    case 'issues':
    case 'issue_comment': {
      const shape = z.object({
        issue: z.object({ number: EntityNumber, pull_request: z.unknown().optional() }),
      });
      const read = shape.safeParse(data);
      if (!read.success) return NOTHING(`${event} (no issue number)`);
      const { number, pull_request: pr } = read.data.issue;
      return refs(event, [pr === undefined ? issueReadRef(number) : prReadRef(number)]);
    }
    case 'check_run':
    case 'check_suite':
    case 'workflow_run': {
      const list = z.object({ pull_requests: z.array(z.object({ number: EntityNumber })).optional() });
      const shape = z.object({
        check_run: list.optional(),
        check_suite: list.optional(),
        workflow_run: list.optional(),
      });
      const read = shape.safeParse(data);
      if (!read.success) return NOTHING(`${event} (no pull requests)`);
      const inner = read.data.check_run ?? read.data.check_suite ?? read.data.workflow_run;
      return refs(
        event,
        (inner?.pull_requests ?? []).map((p) => prReadRef(p.number)),
      );
    }
    default:
      return NOTHING(event);
  }
}

const PULL_BRANCH = /^refs\/pull\/(\d{1,9})\/(?:merge|head)$/;

export function azureEffect(payload: unknown): IngressEffect {
  const body = z.object({ eventType: z.string().max(200), resource: Payload.optional() }).safeParse(payload);
  if (!body.success) return NOTHING('(no eventType)');
  const { eventType, resource } = body.data;
  if (resource === undefined) return NOTHING(eventType);

  if (eventType.startsWith('git.pullrequest.')) {
    const read = z
      .object({
        pullRequestId: EntityNumber.optional(),
        pullRequest: z.object({ pullRequestId: EntityNumber }).optional(),
      })
      .safeParse(resource);
    const number = read.success ? (read.data.pullRequestId ?? read.data.pullRequest?.pullRequestId) : undefined;
    return refs(eventType, number === undefined ? [] : [prReadRef(number)]);
  }
  if (eventType.includes('git-pullrequest-comment')) {
    const read = z.object({ pullRequest: z.object({ pullRequestId: EntityNumber }) }).safeParse(resource);
    return refs(eventType, read.success ? [prReadRef(read.data.pullRequest.pullRequestId)] : []);
  }
  if (eventType.startsWith('workitem.')) {
    const read = z.object({ id: EntityNumber.optional(), workItemId: EntityNumber.optional() }).safeParse(resource);
    const number = read.success ? (read.data.id ?? read.data.workItemId) : undefined;
    return refs(eventType, number === undefined ? [] : [issueReadRef(number)]);
  }
  if (eventType === 'build.complete') {
    const read = z.object({ sourceBranch: z.string().max(400).optional() }).safeParse(resource);
    const branch = read.success ? (read.data.sourceBranch ?? '') : '';
    const number = PULL_BRANCH.exec(branch)?.[1];
    return refs(eventType, number === undefined ? [] : [prReadRef(Number(number))]);
  }
  return NOTHING(eventType);
}

function refs(summary: string, found: string[]): IngressEffect {
  return { refs: [...new Set(found)].slice(0, MAX_REFS), summary };
}
