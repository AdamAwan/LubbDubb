import { z } from 'zod';
import { toolSchema } from './schema.js';
import type { PrAssignDesk } from '../pr/prAssignAsk.js';
import type { PrPerson, PullRequest } from '../types.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson, type ToolCallResult } from './protocol.js';

// → docs/spec/11-mcp-tools.md#every-ask-in-needs-you-and-what-answers-it-here

function pick(shortlist: readonly PrPerson[], person: string): PrPerson | undefined {
  const wanted = person.trim().toLowerCase();
  return (
    shortlist.find((p) => p.id === person.trim()) ??
    shortlist.find((p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted)
  );
}

function readArgs(
  args: Record<string, unknown>,
): { ok: true; pr: number; person: string | undefined; decline: boolean } | { ok: false; error: string } {
  if (typeof args.pr !== 'number' || !Number.isInteger(args.pr) || args.pr <= 0)
    return { ok: false, error: 'pr must be the pull request number, e.g. 312.' };
  const person = typeof args.person === 'string' && args.person.trim() ? args.person : undefined;
  const decline = args.decline === true;
  if (person !== undefined && decline) return { ok: false, error: 'Give one of `person` or `decline`, not both.' };
  return { ok: true, pr: args.pr, person, decline };
}

function decline(desk: PrAssignDesk, pr: number): ToolCallResult {
  const declined = desk.decline(pr);
  if (!declined.ok) return toolError(`Nothing was changed: ${declined.refusal}.`);
  return toolJson({
    pr,
    assigned: null,
    means: 'the ask is answered with nobody. Nothing was written to the tracker, and it will not be asked again.',
  });
}

function settled(deps: DesktopToolDeps, result: ToolCallResult): ToolCallResult {
  if (result.isError !== true) deps.changed({ type: 'world:changed' });
  return result;
}

function readShortlist(desk: PrAssignDesk, pr: number, shortlist: PrPerson[]): ToolCallResult {
  return toolJson({
    pr,
    answered: desk.answered(pr),
    shortlist,
    next:
      shortlist.length === 0
        ? 'There is no shortlist yet — ask the operator who, and pass their name or id as `person`.'
        : 'Put the shortlist to the operator, then call again with `person`, or `decline: true` for nobody.',
    others: 'The shortlist is a hint. Anyone the tracker knows can be named as `person`, by id or name.',
  });
}

async function assign(
  desk: PrAssignDesk,
  pr: number,
  person: string,
  open: readonly PullRequest[],
  shortlist: PrPerson[],
): Promise<ToolCallResult> {
  const found = pick(shortlist, person) === undefined ? await desk.search(person.trim()) : [];
  const chosen = pick(shortlist, person) ?? pick(found, person);
  if (chosen === undefined)
    return toolError(
      `The tracker has nobody that is exactly "${person}". ` +
        (found.length === 0
          ? 'Its search found nobody either.'
          : `Its search found: ${found.map((p) => `${p.name} (${p.id})`).join(', ')}. Call again with one of those ids.`),
    );
  const assigned = await desk.assign(pr, chosen.id, open, person.trim());
  if (!assigned.ok) return toolError(`Nothing was assigned: ${assigned.refusal}.`);
  return toolJson({
    pr,
    assigned: { id: chosen.id, name: chosen.name },
    means: `PR #${pr} is ASSIGNED to ${chosen.name} on the tracker, and they can see it. The ask is answered.`,
  });
}

export const prAssign: DesktopToolFactory = (deps) => ({
  description:
    'Answer "this pull request is ready — want to assign it to someone?". Given `person`, the pull request ' +
    'is **assigned on the tracker** to them — anyone the tracker knows, by id or name; the shortlist the ' +
    "harness learnt from who the operator's pull requests usually go to is a hint, not the limit. Given " +
    '`decline: true`, nobody is assigned and the ask goes away. Given neither, nothing changes and the ' +
    'reply is the shortlist to suggest. Only assign on the ' +
    "operator's say-so: the person is told.",
  inputSchema: toolSchema(
    z.object({
      pr: z.number().describe('The pull request number, e.g. 312.'),
      person: z
        .string()
        .describe('Optional. The person to assign, by id or name — from the shortlist or anyone the tracker knows.')
        .optional(),
      decline: z
        .boolean()
        .describe('Optional. true answers the ask with "nobody" — nothing is written to the tracker.')
        .optional(),
    }),
  ),
  handler: async (args) => {
    const parsed = readArgs(args);
    if (!parsed.ok) return toolError(parsed.error);
    const open = deps.store.world.getWorldBaseline()?.pullRequests ?? [];
    if (!open.some((p) => p.number === parsed.pr))
      return toolError(`PR #${parsed.pr} is not an open pull request in the last world snapshot.`);
    const desk = deps.prAssign();
    if (parsed.decline) return settled(deps, decline(desk, parsed.pr));
    const shortlist = desk.offered(open).map((p) => ({ id: p.id, name: p.name }));
    if (parsed.person === undefined) return readShortlist(desk, parsed.pr, shortlist);
    return settled(deps, await assign(desk, parsed.pr, parsed.person, open, shortlist));
  },
});
