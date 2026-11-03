# 40 — Discussions

> **Not yet built.** Everything in this document is design. No code exists for it; every path below
> is italic for that reason. Remove this marker section by section as each piece lands.

A running record of the talk around a story or a feature — notes, ideas, decisions and open
questions — kept as **Markdown files in a folder the operator chooses**. The operator works on it mainly by
**talking it through in Claude** with the LubbDubb plugin ([below](#talking-it-through-in-claude)).
The fleet reads it, agents add to it, and it is published to the tracker as one tidy comment when
the operator says so.

The ticket says what to build. The reasons, the alternatives that were turned down and the questions
still open live in people's heads, in chat, and in comment threads nobody re-reads. A planner handed
only the ticket re-litigates a decision made last week; a coder guesses an answer the operator gave
in a call. This is the place those things are written down, in a form a person can edit in their own
tools and an agent is handed on every dispatch.

## What it is not

| Not                          | Because                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A table in the store         | The operator owns the file. They edit it in Obsidian or any editor; a database copy would drift from it. The file is the record, and the harness keeps no second one. → [the file](#the-file) |
| The tracker's comment thread | The tracker gets a _refined_ version, only when published. Working notes, dead ideas and half-thoughts stay local. → [publishing](#publishing)                                                |
| Goal criteria                | Criteria say what "done" means and are versioned and append-only. A decision here may inform the criteria; it does not change them. → [08](08-planning.md#what-the-fleet-is-handed)           |
| An escalation                | An open question holds _new_ work on its story; it never kills a running agent or files anything. → [the hold](#an-open-question-holds-the-story)                                             |

## Where the files live

**`discussionsDir`** in `lubbdubb.config.json` names the folder. It is a deployment setting — a path
on this machine — so it belongs in the machine's config file, not the project file. It may point
anywhere, including inside an Obsidian vault.

- **Unset means the feature is off.** No file is read or written, no prompt carries a section, no
  story is held. Every behaviour below is what turning it on does.
- **The folder is created on first write**, never at boot.
- **An unreadable folder fails open** — see [the hold](#an-open-question-holds-the-story) — and is
  recorded through `errors.record`, so it is red in the cockpit rather than silent.

## The file

One file per story or feature:

```
<discussionsDir>/<repo>/<number> <title slug>.md
```

The issue number leads the name and is what the harness keys on; the slug is for the person browsing
the folder. A ticket renamed later keeps its file — the harness finds it by number, so a renamed or
hand-renamed file is still found as long as the number leads the name. Two files for one number is
an error recorded and the older one used.

### Front matter

```yaml
---
ref: issue:142
kind: story # or feature
title: Export to CSV
parent: '[[87 Reporting]]' # the feature, as an Obsidian link; omitted on a feature
published: 2318842 # the tracker comment id once published
pulled: 2026-11-03T14:02:11Z # newest tracker comment already pulled in
---
```

The harness owns `ref`, `kind`, `parent`, `published` and `pulled`. Anything else the operator adds
(Obsidian `tags`, `aliases`, their own fields) is kept untouched on every write.

### Entries

Each entry is a level-2 heading followed by free Markdown:

```markdown
## Decision · 2026-11-03 · operator ^d-7f3a

Export uses the browser's download, not a server-side file. Keeps it stateless.

## Question · open · 2026-11-03 · agent planner#912 ^q-21bc

Should empty columns be dropped or kept as blank?

## Idea · parked · 2026-11-02 · @sam (tracker) ^i-0c11

Offer XLSX as well.
```

The heading reads `<Kind> · [<state> ·] <date> · <author> ^<id>`:

| Kind     | States                                  | Who may write it                         |
| -------- | --------------------------------------- | ---------------------------------------- |
| Note     | —                                       | operator, agent, tracker                 |
| Idea     | `open`, `accepted`, `parked`, `dropped` | operator, agent, tracker                 |
| Question | `open`, `answered`                      | operator, agent, tracker                 |
| Decision | —                                       | **operator only** (in Claude or by hand) |

- **The `^id` is an Obsidian block id**, so an entry can be linked to from elsewhere in a vault
  (`[[142 Export to CSV#^d-7f3a]]`). The harness mints it and reads it; a person adding an entry by hand
  may leave it off and the harness adds one on its next write.
- **An answer goes under its question**, as the body below an `Answer:` line, and flips the state to
  `answered`. Editing the heading by hand does the same.
- **A decision is never edited to change it.** A new decision that replaces one says
  `Supersedes ^d-7f3a`; the old one stays as history. Agents are handed only decisions nothing
  supersedes.
- **What does not parse is kept as a note.** A heading the harness cannot read is never dropped or
  rewritten — it is handed to agents as a note and shown in the cockpit with a "couldn't read" mark.
  The operator's file is never lost to a parser.

### Writing without clobbering

The operator may have the file open in Obsidian while an agent adds to it. So every harness write is
**re-read, append, write to a temp file, rename** — never a rewrite from a copy held in memory. The
only in-place changes the harness makes are to its own front-matter keys and to a missing `^id`.

### A feature's file

A feature has its own file for discussion that spans its stories. Its cockpit view, and the prompt
section for any of its stories, also gathers the **open questions and standing decisions** from the
stories' files — read, never copied into the feature's file.

## What agents read

For a story's planner, coder and reviewer dispatches, the prompt gets a **Discussion** section
_appended_ (never interpolated — see [05](05-dispatcher.md#prompt-templates)):

1. Standing decisions — the story's, then its feature's.
2. Accepted ideas.
3. Answered questions, with their answers.
4. Open notes, newest first, until a size budget is reached; the rest is cut with a line saying how
   many were left out and where the file is.

Parked and dropped ideas are left out: they are history, and handing them over invites the agent to
build them.

## What fleet agents write

One new MCP tool, _`discussion_add`_, in _src/mcp/tools/discussionAdd.ts_:

```
discussion_add({ kind: 'note' | 'idea' | 'question', body: string })
```

- The ref is the agent's own origin, never an argument — an agent writes to the story it is working
  on and nowhere else.
- `kind: 'decision'` is refused. Decisions are the operator's.
- It shares its name with the desktop tool of the same name, as `validation_report` does; the two
  are separate builds on separate channels, and a change to one is checked against the other. →
  [11](11-mcp-tools.md#the-desktop-channel)
- The author is written as `agent <rule>#<task id>`.
- Like every new tool it is named in `MCP_TOOL_NAMES` and placed in `UNIVERSAL_TOOLS`, or it is in
  no agent's `tools/list`. → [11](11-mcp-tools.md#which-tools-an-agent-is-advertised)

## An open question holds the story

**An open question on a story, or on its feature, holds new dispatches for that story** — the
planner and every part — as `held: 'questions'`. It shows in Up next as _waiting on N open questions_
with a link to the file, so the hold is never silent.

- **It holds new work only.** A running agent that adds a question carries on; the question holds the
  _next_ dispatch.
- **It fails open, on every arm.** Feature off, folder unreadable, file unparseable, the issue number
  not found — every one leaves the story eligible exactly as it is today. Like a sequence hold, this
  withholds work, and the quietest failure there is is a story that never starts. →
  [33](33-story-sequencing.md#fail-open)
- **Expediting a goal or giving it a priority override lifts the hold**, the same way it lifts
  `sequenced`. The operator saying "go" outranks the question.
- **A question an agent raised counts.** That is the point: the planner that cannot tell whether
  empty columns are dropped asks, and nothing is built on a guess.

## Pulling tracker comments in

Comments other people leave on the ticket are pulled into the file on the harness cycle:

- Each new comment since `pulled` is appended as a **Note** authored `@<login> (tracker)`.
- **The harness's own comments are skipped** by record, never by author: the published comment's id
  is in `published`, and every other comment the harness posts on an issue needs a record of its id
  when sent — the same rule `pr_replies_sent` keeps for review replies. The operator's login is not a
  test: on a single-operator deployment it is the harness's login too. →
  [07](07-pull-requests.md#attribution-is-a-record-never-an-identity)
- An operator turns a pulled note into an idea, question or decision by editing its heading.

Reading issue comments is new to both providers: a _listIssueComments_ method on each `*Api` interface
and its scripted fake, in the same change. → [15](15-integrations.md)

## Talking it through in Claude

**The main way in is a conversation in the operator's own Claude, through the LubbDubb plugin** —
the desktop channel ([11](11-mcp-tools.md#the-desktop-channel)), not the cockpit. Discussion is talk,
and the place the operator already talks is Claude. The files and the cockpit are for reading it back.

`/lubbdubb:discuss <n> [what's on your mind]` opens a conversation about story or feature `<n>`. The
skill lives at _plugin/skills/discuss/SKILL.md_ and ships with the plugin like every other skill.

1. **It reads first.** `discussion_read` returns the file's entries, plus — for a story — its
   feature's standing decisions and open questions, and for a feature its stories' open questions.
   Claude opens with what is still open, not a recap of everything.
2. **It talks.** Claude has the repository open, so a question the code can answer, it answers by
   reading the code, and proposes the answer for the operator to accept. A product question it asks.
3. **It writes down what the conversation settles,** as it goes — never the transcript. Each write
   is shown before it is made: _"Log this as a decision: export uses the browser download?"_ Nothing
   lands without the operator's yes.

### The desktop tools

Named in `DESKTOP_TOOL_NAMES`, built in _src/mcp/desktopDiscussion.ts_, never in `buildTools`:

| Tool                 | Does                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| _discussion_read_    | The entries for one story or feature, with the related ones described above.               |
| _discussion_add_     | Adds a note, idea, question or **decision**. Author is written as `operator (via Claude)`. |
| _discussion_settle_  | Answers a question; accepts, parks or drops an idea; supersedes a decision.                |
| _discussion_publish_ | Posts the summary the operator approved. → [publishing](#publishing)                       |
| _discussion_pull_    | Pulls new tracker comments in now, rather than waiting for the cycle.                      |

- **Decisions can be written here and nowhere else in the fleet**, because the operator is in the
  conversation. Claude proposes the wording; the operator's yes is what makes it a decision.
- **Claude's own view is labelled as Claude's.** An idea Claude suggests and the operator wants kept
  is written as an idea authored `Claude (suggested)`, not as the operator's.
- **Every write goes through the same object the cockpit's would** — _src/discussions/discussionFile.ts_ —
  never a second implementation. → [11](11-mcp-tools.md#every-write-goes-through-the-object-the-cockpits-click-goes-through)
- **Each write tells the cockpit** through `DesktopToolDeps.changed`, so a page that is open shows it.
- **Answering an open question lifts its hold** on the next cycle, so a `/lubbdubb:discuss` that
  clears the last question is what lets the story start.

### Where else it is reached from

- `/lubbdubb:next` offers a held story's open questions as one ask, and hands off to
  `/lubbdubb:discuss <n>` to answer them.
- `/lubbdubb:feature` and `/lubbdubb:plan` read the discussion and hand off to `/lubbdubb:discuss`
  when the talk turns to something worth writing down; they write nothing themselves.
- The cockpit's Discussion tab carries a deep link that opens `/lubbdubb:discuss <n>`.

## Publishing

In the conversation — _"publish this"_ or `/lubbdubb:discuss <n> publish`:

1. Claude drafts the summary from the file: standing decisions, accepted ideas, answered questions,
   and what is still open. Notes and parked or dropped ideas are left out.
2. The operator reads it and changes it in the conversation until they are happy.
3. `discussion_publish` posts the approved text through `upsertIssueComment` as **one** comment, and
   writes its id to `published`. Publishing again edits that comment rather than adding one.

Nothing reaches the tracker without step 2. The tool takes only the final text; it composes nothing.

## Turning an idea into a story

In the conversation — _"make that a story"_: the skill hands off to `/lubbdubb:file` with the idea's
body as the starting draft and its feature as the parent, so the ticket gets the same checks, watch
label and confirmation as any other. Once it is filed, `discussion_settle` marks the idea `accepted`
with a `Became [[<n> <slug>]]` line. Everything the ticket must carry goes in `IssueCreateInput`
through `ticketFiler`, not in a prompt. → [13](13-jobs-and-tickets.md#filing-a-ticket)

## In the cockpit

A read-mostly **Discussion** tab on the story and feature views: the entries, filters by kind and
state, a link that opens the file (`obsidian://` when the folder is inside a vault), and a button
that opens `/lubbdubb:discuss <n>` in Claude. Open questions holding a story are shown on it and in
Up next. Every ref drawn with `<Ref>`.

## Where it will live

| Piece                    | Path                                |
| ------------------------ | ----------------------------------- |
| File reading and writing | _src/discussions/discussionFile.ts_ |
| Parsing the Markdown     | _src/discussions/parse.ts_          |
| The hold                 | _src/discussions/questionHold.ts_   |
| Pulling tracker comments | _src/discussions/pullDesk.ts_       |
| Prompt section           | _src/discussions/promptSection.ts_  |
| The fleet agent's tool   | _src/mcp/tools/discussionAdd.ts_    |
| The desktop tools        | _src/mcp/desktopDiscussion.ts_      |
| The skill                | _plugin/skills/discuss/SKILL.md_    |
| Read route for the tab   | _src/server/routes/discussions.ts_  |

## Still to decide

- The size budget for the prompt section.
- Whether a feature-level open question should hold every story under it, or only stories not yet
  started.
