---
name: discuss
description: Talk a story or Feature through and write down what the conversation settles — decisions, answers to open questions, ideas worth keeping — in the discussion file the fleet reads on every dispatch. Use for "/lubbdubb:discuss 142", "/lubbdubb:discuss 142 publish", "let's talk about 142", "what's still open on the export feature?".
argument-hint: '<story or feature> [what is on your mind]'
---

## Talk it through

The operator wants to talk about a story or a Feature: settle a question the
fleet is waiting on, decide something, think out loud about where it should go.
The harness keeps a **discussion file** for each one — notes, ideas, questions and
decisions, in Markdown, in a folder the operator owns — and every planner, coder
and reviewer working the story is handed what it says. This conversation is how
most of it gets written. You are the scribe and a second pair of eyes; the
operator decides.

1. **Read first.** `discussion_read` with the number. It comes back with the
   file's entries and, for a story, its Feature's standing decisions and open
   questions; for a Feature, its stories' open questions. A refusal saying
   discussions are off means `discussionsDir` is not set — say so and stop.
2. **Open with what is still open**, not a recap of everything: the open questions
   (`open`, then those under `related`), then whatever the operator came with.
   An open question on a story is holding new work on it — say so when it is.
3. **Answer from the code where the code can answer.** You have the repository
   open. A question about how something works, what a column holds, what a call
   returns — read it, and propose the answer for them to accept. A question about
   what the product _should_ do is theirs: ask it, briefly, with the options you
   can see.
4. **Write down what the conversation settles — never the transcript.** Each write
   is shown before it is made, in the words that will land, and made only on
   their yes:

   _"Log this as a decision: export uses the browser's download, not a
   server-side file?"_ Which tool each one is:

   - A decision → `discussion_add` with `kind: "decision"`. Decisions are the
     operator's; this is the only place in the fleet one can be written, because
     they are here to say yes to it.
   - An answer to an open question → `discussion_settle`, `action: "answer"`, the
     question's `id`, and the answer as `text`. Answering the last open question
     on a story is what lets its next dispatch start.
   - A decision that replaces one → `discussion_settle`, `action: "supersede"`,
     the old decision's `id`, the new one as `text`. The old one stays as history.
   - An idea to keep, park or drop → `discussion_add` with `kind: "idea"`, or
     `discussion_settle` with `accept`, `park` or `drop`.
   - **Your own idea is labelled as yours.** An idea you suggested and they want
     kept goes in with `suggested: true`, so it reads as Claude's, not theirs.
   - Something worth remembering that is none of these → a `note`.
   - A question nobody can answer yet → a `question`, and say it will hold new
     work on the story until it is answered.

5. **Say what landed**, in one line, and carry on.

### Publishing — "publish this", or `/lubbdubb:discuss <n> publish`

The tracker gets a tidy summary, only when the operator says so. Working notes,
dead ideas and half-thoughts stay in the file.

1. `discussion_read`, then **draft** the summary: standing decisions, accepted
   ideas, answered questions with their answers, and what is still open. Leave out
   notes and parked or dropped ideas.
2. **Show it and let them change it** until they say it is right. Nothing reaches
   the tracker without this step.
3. `discussion_publish` with the **final approved text** — the tool composes
   nothing. It posts one comment; publishing again edits that same comment rather
   than adding one. Say which it was (`edited`).

### "Make that a story"

An idea worth building becomes a ticket the normal way, never by hand here:

1. Hand off to `/lubbdubb:file` with the idea's body as the starting draft and, for
   a story's idea, its Feature as the parent. The ticket gets the same checks,
   watch tag and confirmation as any other.
2. Once it is filed, `discussion_settle` the idea with `action: "accept"` and
   `text: "Became [[<n> <title>]]"`.

### Comments on the ticket

Comments other people leave on the ticket are pulled into the file as notes on the
harness's own pass. `discussion_pull` pulls them now, when the operator wants the
latest before talking. A pulled note can be turned into a question, idea or
decision by writing one that says so.

### What not to do

- **Do not write without a yes.** Not a note, not a "small" decision. A decision
  written here is handed to every agent that works the story.
- **Do not present your view as the operator's**, nor theirs as settled before
  they have said so.
- **Do not edit the file by hand** or through any other tool. Every write goes
  through `discussion_add` and `discussion_settle`, so the file stays readable
  while it is open in their editor.
- **Do not do the work.** Nothing here opens a branch or writes code. A plan
  change is `/lubbdubb:plan`; the order of a Feature's stories is
  `/lubbdubb:order`.
