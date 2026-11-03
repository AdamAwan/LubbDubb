import { z } from 'zod';
import {
  DISCUSSION_AUTHORS,
  DISCUSSIONS_OFF,
  failure,
  type DiscussionSettlement,
  type DiscussionSubject,
} from '../discussions/discussionFile.js';
import { openQuestions } from '../discussions/entries.js';
import { DISCUSSION_KINDS, isOneOf } from '../discussions/parse.js';
import { readDiscussion } from '../discussions/related.js';
import { discussionSubject } from '../discussions/subject.js';
import type { DiscussionEntry } from '../types.js';
import { desktopIssueRef } from '../validation/desktop.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson, type ToolCallResult } from './protocol.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';

// → docs/spec/40-discussions.md#the-desktop-tools

const OFF = `${DISCUSSIONS_OFF} Say so — there is no file to read or write until the operator names a folder.`;

const issueArg = z.number().describe('The story or Feature number, e.g. 142.');

const ACTIONS = ['answer', 'accept', 'park', 'drop', 'supersede'] as const;

function changed(deps: DesktopToolDeps): void {
  deps.changed({ type: 'dirty', sections: ['goals', 'queue'] });
}

function entryLine(entry: DiscussionEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    state: entry.state,
    date: entry.date,
    author: entry.author,
    body: entry.body,
    answer: entry.answer,
    supersedes: entry.supersedes,
    ...(entry.unreadable ? { unreadable: true, heading: entry.heading } : {}),
  };
}

function subjectFor(
  deps: DesktopToolDeps,
  number: number,
): { ok: true; subject: DiscussionSubject } | { ok: false; error: string } {
  const issues = deps.store.world.getWorldBaseline()?.issues ?? [];
  if (!issues.some((i) => i.number === number) && deps.discussions.locate(number) === null) {
    return {
      ok: false,
      error:
        `The harness holds nothing about #${number}: the last world snapshot does not list it and it has no ` +
        'discussion file. Check the number, or that the ticket carries the watch tag.',
    };
  }
  return { ok: true, subject: discussionSubject(issues, number, deps.issueContainerTypes) };
}

const discussionRead: DesktopToolFactory = (deps) => ({
  description:
    "Read the discussion kept for a story or a Feature — the operator's running record of notes, ideas, " +
    "questions and decisions, kept as a Markdown file. For a story it also carries its Feature's standing " +
    "decisions and open questions; for a Feature, its stories' open questions. Call this first whenever the " +
    'operator wants to talk a story or Feature through, and open with what is still open. Records nothing, ' +
    'except an id on any entry written by hand without one, so it can be settled.',
  inputSchema: toolSchema(z.object({ issue: issueArg })),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    if (!deps.discussions.enabled) return toolError(OFF);
    const issues = deps.store.world.getWorldBaseline()?.issues ?? [];
    const read = (): ReturnType<typeof readDiscussion> =>
      readDiscussion(deps.discussions, issues, ref.issue, deps.issueContainerTypes);
    const first = read();
    const named = [ref.issue, ...first.reading.related.map((r) => r.number)].map((n) => deps.discussions.identify(n));
    const { reading, frontMatter } = named.some((r) => r.ok && r.changed) ? read() : first;
    return toolJson({
      issue: ref.issue,
      kind: reading.kind,
      title: reading.title,
      file: reading.path,
      published: frontMatter?.published ?? null,
      pulled: frontMatter?.pulled ?? null,
      open: openQuestions(reading.entries).map(entryLine),
      entries: reading.entries.map(entryLine),
      related: reading.related.map((n) => ({
        number: n.number,
        kind: n.kind,
        title: n.title,
        standingDecisions: n.standingDecisions.map(entryLine),
        openQuestions: n.openQuestions.map(entryLine),
      })),
      next:
        reading.path === null
          ? 'Nothing is written down yet. The first discussion_add creates the file.'
          : 'Open with what is still open, not a recap. Write down only what the conversation settles, and ' +
            'show each write to the operator before making it.',
    });
  },
});

const discussionAdd: DesktopToolFactory = (deps) => ({
  description:
    "Write one entry into a story's or Feature's discussion: a note, an idea, a question, or a decision. " +
    'Show the operator exactly what you will write and make the call only on their yes — a decision written ' +
    'here is handed to every agent that works the story. An idea that is your own suggestion, which the ' +
    "operator wants kept, goes in with suggested: true so it is labelled as Claude's, not theirs. An open " +
    'question holds new work on the story until it is answered.',
  inputSchema: toolSchema(
    z.object({
      issue: issueArg,
      kind: z.enum(DISCUSSION_KINDS).describe('What the entry is.'),
      body: z.string().describe('The entry, in Markdown, as the operator agreed it.'),
      suggested: z
        .boolean()
        .describe("Optional, ideas only. True when the idea is Claude's suggestion rather than the operator's.")
        .optional(),
    }),
  ),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    if (!deps.discussions.enabled) return toolError(OFF);
    const kind = args.kind;
    if (!isOneOf(kind, DISCUSSION_KINDS)) return toolError(`kind must be one of ${DISCUSSION_KINDS.join(', ')}.`);
    const body = String(args.body ?? '').trim();
    if (body === '') return toolError('body is empty — there is nothing to write down.');
    if (args.suggested === true && kind !== 'idea')
      return toolError(`suggested is for ideas only. A ${kind} is written as the operator's, or not at all.`);
    const found = subjectFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const author = args.suggested === true ? DISCUSSION_AUTHORS.claudeSuggested : DISCUSSION_AUTHORS.operatorViaClaude;
    const write = deps.discussions.add(found.subject, { kind, body, author });
    if (!write.ok) return toolError(write.error);
    changed(deps);
    return toolJson({
      issue: ref.issue,
      written: entryLine(write.entry),
      file: write.path,
      means:
        kind === 'question'
          ? 'the question is open, so new work on this story waits until it is answered.'
          : kind === 'decision'
            ? 'every agent dispatched for this story from now on is handed this decision.'
            : 'it is in the file; agents read it on their next dispatch.',
    });
  },
});

const discussionSettle: DesktopToolFactory = (deps) => ({
  description:
    'Settle one entry in a discussion: answer an open question, accept, park or drop an idea, or supersede a ' +
    'decision with a new one (the old one stays as history). Name the entry by its id from discussion_read. ' +
    'Show the operator what you will write and make the call only on their yes. Answering the last open ' +
    'question on a story is what lets its next dispatch start.',
  inputSchema: toolSchema(
    z.object({
      issue: issueArg,
      entry: z.string().describe('The entry id, e.g. "q-21bc" (a leading ^ is fine).'),
      action: z.enum(ACTIONS).describe('What to do with it.'),
      text: z
        .string()
        .describe(
          'The answer, for answer; the new decision, for supersede; an optional line under the idea for ' +
            'accept, park or drop — for a filed story, "Became [[<n> <title>]]".',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    if (!deps.discussions.enabled) return toolError(OFF);
    const id = String(args.entry ?? '')
      .trim()
      .replace(/^\^/, '');
    if (id === '') return toolError('entry is empty — name the entry by its id from discussion_read.');
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    const action = args.action;
    if (!isOneOf(action, ACTIONS)) return toolError(`action must be one of ${ACTIONS.join(', ')}.`);
    let settlement: DiscussionSettlement;
    if (action === 'answer' || action === 'supersede') {
      if (text === '')
        return toolError(`${action} needs text: the ${action === 'answer' ? 'answer' : 'new decision'}.`);
      settlement =
        action === 'answer'
          ? { action, answer: text }
          : { action, body: text, author: DISCUSSION_AUTHORS.operatorViaClaude };
    } else {
      settlement = text === '' ? { action } : { action, note: text };
    }
    const write = deps.discussions.settle(ref.issue, id, settlement);
    if (!write.ok) return toolError(write.error);
    changed(deps);
    return toolJson({ issue: ref.issue, settled: id, written: entryLine(write.entry), file: write.path });
  },
});

const discussionPublish: DesktopToolFactory = (deps) => ({
  description:
    "Post the discussion's summary to the ticket, as one comment. Pass only the final text the operator has " +
    'read and approved in this conversation — this tool composes nothing. Draft it from discussion_read ' +
    '(standing decisions, accepted ideas, answered questions, what is still open; never notes or dropped ' +
    'ideas), let the operator change it until they are happy, then call this. Publishing again edits the same ' +
    'comment rather than adding one.',
  inputSchema: toolSchema(
    z.object({
      issue: issueArg,
      body: z.string().describe('The summary exactly as the operator approved it, in Markdown.'),
    }),
  ),
  handler: async (args): Promise<ToolCallResult> => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    if (!deps.discussions.enabled) return toolError(OFF);
    const body = String(args.body ?? '').trim();
    if (body === '') return toolError('body is empty — publish the summary the operator approved.');
    const doc = deps.discussions.read(ref.issue);
    if (doc === null) return toolError(`#${ref.issue} has no discussion file, so there is nothing to publish from.`);
    const previous = doc.frontMatter.published;
    let sent: string | undefined;
    try {
      sent = (await deps.comments.upsertIssueComment({ number: ref.issue, body, commentRef: previous })).ref;
    } catch (error) {
      const detail = failure(error);
      deps.errors?.record({ source: 'server', message: `Publishing the discussion on #${ref.issue} failed.`, detail });
      return toolError(`The tracker refused the comment on #${ref.issue}: ${detail}`);
    }
    if (!sent) return toolError(`The tracker took the comment on #${ref.issue} but named no id for it.`);
    const marked = deps.discussions.setFrontMatter(ref.issue, { published: sent });
    changed(deps);
    if (!marked.ok)
      return toolError(
        `The comment is on #${ref.issue} (id ${sent}), but its id could not be written to the file: ${marked.error}. ` +
          'Publishing again would add a second comment rather than edit this one.',
      );
    return toolJson({ issue: ref.issue, published: sent, edited: previous !== null && previous === sent });
  },
});

const discussionPull: DesktopToolFactory = (deps) => ({
  description:
    "Pull the ticket's new comments into its discussion file now, rather than waiting for the harness's next " +
    "pass. Each comment from someone else lands as a note; the harness's own comments are skipped. Only an " +
    'issue that already has a discussion file is pulled.',
  inputSchema: toolSchema(z.object({ issue: issueArg })),
  handler: async (args): Promise<ToolCallResult> => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    if (!deps.discussions.enabled) return toolError(OFF);
    const result = await deps.discussionPulls.pull(ref.issue);
    if (!result.ok) return toolError(result.error);
    if (result.added > 0) changed(deps);
    return toolJson({ issue: ref.issue, added: result.added, skippedAsOurs: result.skipped, pulled: result.pulled });
  },
});

export const DESKTOP_DISCUSSION_TOOLS = {
  discussion_read: discussionRead,
  discussion_add: discussionAdd,
  discussion_settle: discussionSettle,
  discussion_publish: discussionPublish,
  discussion_pull: discussionPull,
} satisfies Record<string, DesktopToolFactory>;
