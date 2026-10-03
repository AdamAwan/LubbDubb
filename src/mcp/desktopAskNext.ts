import { z } from 'zod';
import type { AskRow } from '../asks/askRow.js';
import { answerWith } from './askAnswers.js';
import { askCard } from './askCard.js';
import type { DesktopSession, DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/11-mcp-tools.md#the-next-ask-loop

function skippedBy(session: DesktopSession, extra: unknown): Set<string> {
  const skipped = new Set(session.skipped ?? []);
  if (Array.isArray(extra)) for (const id of extra) if (typeof id === 'string') skipped.add(id);
  return skipped;
}

function cockpitLink(deps: DesktopToolDeps, id: string): string | null {
  return deps.cockpitUrl === null ? null : `${deps.cockpitUrl}/?ask=${encodeURIComponent(id)}`;
}

function describeRow(row: AskRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    urgency: row.urgency,
    group: row.group,
    holding: row.holding,
    raisedAt: row.raisedAt,
    goalRef: row.goalRef,
    originRef: row.originRef,
    agent: row.agentId === null ? null : { id: row.agentId, label: row.agentLabel },
    ...(row.prNumber === undefined ? {} : { prNumber: row.prNumber }),
    ...(row.note === undefined ? {} : { note: row.note }),
    ...(row.placementField === undefined ? {} : { placementField: row.placementField }),
    ...(row.verb === undefined ? {} : { verb: row.verb }),
    ...(row.refusal === undefined ? {} : { refusal: row.refusal }),
  };
}

/** The question itself, for the kinds whose row is an agent's question — the title is one line of it. */
function questionOf(deps: DesktopToolDeps, row: AskRow): Record<string, unknown> | null {
  if (row.subject.type !== 'escalation' || row.subject.proposalId !== null) return null;
  const escalation = deps.store.escalations.getEscalation(row.subject.escalationId);
  if (escalation === null) return null;
  return {
    prompt: escalation.prompt,
    questions: escalation.context.questions ?? null,
    permission: escalation.context.permission ?? null,
  };
}

const notStanding = (id: string) =>
  toolError(
    `No standing ask "${id}". It has been answered or has otherwise gone — call ask_next for the one in front now.`,
  );

const ASK_NEXT_NEXT =
  'Put this to the operator as a short card — drawn from `card` as a widget where you can draw one, looking ' +
  'like Focus mode but with no position in the queue: what is asked, who is waiting, what it holds up. ' +
  'Read more only where it helps them decide. Any view is yours, labelled as yours — the operator decides, ' +
  'and nothing is sent until they answer or explicitly pick an option. Then call `answerWith.tool` with ' +
  'their answer, or ask_skip if they want it later. An answer refused as already settled means somebody ' +
  'answered it elsewhere: move on.';

export const askNext: DesktopToolFactory = (deps, session) => ({
  description:
    'The next thing the operator has to answer — the head of "Needs you" in the order the cockpit’s Focus mode ' +
    'walks it — with where it stands in the queue, `card`: what Focus mode draws for it, and `answerWith`: the ' +
    'exact tool and arguments that answer ' +
    'it on this channel, or the cockpit page where it is answered instead. Asks skipped in this session are ' +
    'passed over. `id` hands back that one ask instead of the head. Records nothing, decides nothing.',
  inputSchema: toolSchema(
    z.object({
      id: z
        .string()
        .describe('Optional. An ask id to hand back instead of the head — the one the operator picked.')
        .optional(),
      skip: z
        .array(z.string())
        .describe('Optional. Ask ids to pass over for this call only, on top of those skipped with ask_skip.')
        .optional(),
    }),
  ),
  handler: (args) => {
    const queue = deps.askQueue();
    const skipped = skippedBy(session, args.skip);
    const waiting = queue.filter((row) => !skipped.has(row.id));
    const passedOver = queue.filter((row) => skipped.has(row.id)).map((row) => row.id);
    const picked = typeof args.id === 'string' ? args.id.trim() : '';
    const head = picked === '' ? waiting[0] : queue.find((row) => row.id === picked);
    if (picked !== '' && head === undefined) return notStanding(picked);
    if (head === undefined) {
      return toolJson({
        empty: true,
        total: queue.length,
        skipped: passedOver,
        said:
          queue.length === 0
            ? 'Nothing in "Needs you" is waiting on the operator.'
            : `Nothing left but the ${queue.length} ask${queue.length === 1 ? '' : 's'} skipped in this session. ` +
              'ask_skip with `undo: true` brings one back.',
      });
    }
    const question = questionOf(deps, head);
    return toolJson({
      position: queue.indexOf(head) + 1,
      total: queue.length,
      remaining: waiting.length,
      skipped: passedOver.length,
      ask: describeRow(head),
      card: askCard(deps, head, queue),
      ...(question === null ? {} : { question }),
      answerWith: answerWith(head, {
        link: cockpitLink(deps, head.id),
        profileNames: deps.profileNames(),
        proposalKind: (id) => deps.store.escalations.getProposal(id)?.kind ?? null,
      }),
      next: ASK_NEXT_NEXT,
    });
  },
});

export const askSkip: DesktopToolFactory = (deps, session) => ({
  description:
    'Pass over one ask for the rest of this session, so ask_next moves on to the one after it. It is held by ' +
    'this connection alone: nothing is written, the cockpit still shows the ask, and a new session starts ' +
    'with it back at its place. `undo: true` brings a skipped ask back.',
  inputSchema: toolSchema(
    z.object({
      id: z.string().describe('The ask id, from ask_next.'),
      undo: z.boolean().describe('Optional. true un-skips it, so ask_next can hand it back.').optional(),
    }),
  ),
  handler: (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (id === '') return toolError('id required — take it from ask_next.');
    const skipped = (session.skipped ??= new Set());
    if (args.undo === true) {
      const had = skipped.delete(id);
      return toolJson({ id, skipped: false, said: had ? 'Back in the queue.' : 'It was not skipped.' });
    }
    const standing = deps.askQueue().some((row) => row.id === id);
    if (!standing) return notStanding(id);
    skipped.add(id);
    return toolJson({
      id,
      skipped: true,
      said: 'Passed over for this session only. The cockpit still shows it, and nothing was answered.',
    });
  },
});
