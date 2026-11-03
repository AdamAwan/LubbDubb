# 40 — Discussions

> **Partly built.** Built: `discussionsDir`, [the file](#the-file) — its format, the parser in
> `src/discussions/parse.ts` and the one object every read and write goes through,
> `src/discussions/discussionFile.ts`, reached as `System.discussions`; [what agents read](#what-agents-read),
> [the fleet agent's tool](#what-fleet-agents-write) and [the hold](#an-open-question-holds-the-story);
> [pulling tracker comments](#pulling-tracker-comments-in); [the desktop tools and the skill](#talking-it-through-in-claude)
> and [publishing](#publishing); [the cockpit tab](#in-the-cockpit). **Not yet built:** `/lubbdubb:next` carrying a
> held story's open questions as an ask ([below](#where-else-it-is-reached-from)). Remove this marker when it lands.

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
- **A relative path is resolved against `repoRoot`**, like every other path key. An empty string is
  unset.
- **The folder is created on first write**, never at boot.
- **An unreadable folder fails open** — see [the hold](#an-open-question-holds-the-story) — and is
  recorded through `errors.record`, so it is red in the cockpit rather than silent.

## The file

One file per story or feature:

```
<discussionsDir>/<repo>/<number> <title slug>.md
```

`<repo>` is the tracker repository's name — `github.repo`, else `azureDevOps.repository` — and the
checkout's folder name when neither is set, with the characters a file name cannot carry replaced by a
space (`discussionRepoFolder`). So one folder can hold the discussions of several repositories side by
side. The title slug is the issue title with the same characters replaced, cut at 80 characters.

The issue number leads the name and is what the harness keys on; the slug is for the person browsing
the folder. A ticket renamed later keeps its file — the harness finds it by number, so a renamed or
hand-renamed file is still found as long as the number leads the name. Two files for one number is
an error recorded and the older one used — recorded once per pair, not on every read. A number is
the whole leading run of digits, so `1420 …` is never #142's file.

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

- **A missing state reads as `open`** on an idea or a question, so a hand-written
  `## Question · 2026-11-03 · me` is an open question. A state on a note or a decision, or a state the
  kind does not have, makes the heading unreadable.
- **A `## ` line inside a fenced code block is body**, never a heading.
- **The `^id` is an Obsidian block id**, so an entry can be linked to from elsewhere in a vault
  (`[[142 Export to CSV#^d-7f3a]]`). The harness mints it — the kind's initial and four hex digits, `n-`, `i-`, `q-`, `d-`, unique in
  the file — and reads it; a person adding an entry by hand may leave it off and the harness adds one
  to every readable heading without one on its next write to that file.
- **An answer goes under its question**, as the body below an `Answer:` line, and flips the state to
  `answered`. Editing the heading by hand does the same.
- **A decision is never edited to change it.** A new decision that replaces one says
  `Supersedes ^d-7f3a`; the old one stays as history. Agents are handed only decisions nothing
  supersedes.
- **What does not parse is kept as a note.** A heading the harness cannot read is never dropped or
  rewritten — it is handed to agents as a note and shown in the cockpit with a "couldn't read" mark.
  The operator's file is never lost to a parser. An unreadable heading never gains an id either.
- **A body the harness writes cannot break the file.** A `## ` line in it is escaped as `\## `, so it
  reads back as body rather than a new entry, and a code fence it leaves open is closed — an open fence
  would swallow every entry after it.

### Writing without clobbering

The operator may have the file open in Obsidian while an agent adds to it. So every harness write is
**re-read, append, write to a temp file, rename** — never a rewrite from a copy held in memory. The
temp file is a dotfile beside the target (so a vault does not index it) and is removed if the rename
fails. The only in-place changes the harness makes are to its own front-matter keys, to a missing
`^id`, and — when an entry is **settled** — to that entry's state word and the lines appended at the
end of its body (`Answer: …`, `Became [[…]]`). Setting a front-matter key replaces that key's line
(and any indented block under it) and leaves every other key, comment and line as it was.

### The object every write goes through

`DiscussionFiles` (`src/discussions/discussionFile.ts`) is built once, in the foundation, and reached
as `System.discussions`. With `discussionsDir` unset, `enabled` is false, `read` answers null and every
write is a refusal — nothing touches the disk.

| Member                | Does                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `locate(n)`           | The file for issue `n`, or null.                                                                                                                                   |
| `read(n)`             | The parsed file, or **null** for off, no file, or a failure — which is recorded. Null is what every reader fails open on.                                          |
| `add(subject, …)`     | Appends a note, idea, question or decision, creating the folder and the file (with `ref`, `kind`, `title` and, for a story, `parent`) on the first write.          |
| `settle(n, id, …)`    | Answers an open question; accepts, parks or drops an idea, with an optional line under it; supersedes a decision by appending a new one saying `Supersedes ^<id>`. |
| `addMany(subject, …)` | Appends several entries and sets front-matter keys in **one** write — the pull's batch.                                                                            |
| `identify(n)`         | Adds a `^id` to every readable entry that lacks one and writes the file only if that changed it, answering whether it did. Nothing else moves.                     |
| `setFrontMatter`      | Writes `published` and `pulled`.                                                                                                                                   |
| `obsidianUrl(path)`   | `obsidian://open?path=…` when the folder sits inside a vault, else null. The vault is looked for once per object.                                                  |

A write answers `{ok: true, entry, path}` or a refusal `{ok: false, error}` — a wrong kind, an unknown
id, an answered question answered again. A failure of the disk is recorded through `errors.record` and
answered as a refusal, never thrown. **Who may write a decision is the caller's rule**, not the
object's: the fleet tool refuses `kind: 'decision'` before it gets here.

**Reading is cached, and the cache is checked against the disk on every read.** The folder's listing (issue
number → file) is kept until the folder's mtime moves, and a parsed file until its own mtime or size does, so
the dispatcher reading every held story's file every pulse costs a `stat`, not a parse. Every harness write
drops both for what it touched. A duplicate number is resolved — and recorded, once — when the listing is
built; a listing or a file that cannot be read is recorded and answered as absent, as before.

The author strings are `DISCUSSION_AUTHORS`: `operator (via Claude)`,
`Claude (suggested)`, `agent <rule>#<task id>` and `@<login> (tracker)`. The date is the machine's
local date. The pure selectors over a file's entries — `standingDecisions`, `openQuestions`,
`answeredQuestions`, `acceptedIdeas`, `notesNewestFirst` — are in `src/discussions/entries.ts`.

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
4. Open notes, newest first, until the section reaches about 6,000 characters; the rest is cut with a line saying how
   many were left out and where the file is.

Parked and dropped ideas are left out: they are history, and handing them over invites the agent to
build them.

`discussionSection` (`src/discussions/promptSection.ts`) renders it, as `StageContext.discussionNote(n)`, onto rules
`issue-plan`, `plan-part` and `pr-review` (the story behind the pull request, by `issueForPr`). The feature is the
world's `issue.parent`, else the file's own `parent` link, never the issue itself — `discussionPair`
(`src/discussions/reader.ts`) reads the pair, for the hold, the section and the cockpit alike. Each entry carries its date, author and `^id`; an
unreadable heading is handed over as a note with the heading it could not read. The budget leaves room for the
cut line itself, so the section stays under 6,000 characters. Nothing at all is appended with discussions off, no
file, or nothing in it to hand over — open questions alone are not handed over, they [hold](#an-open-question-holds-the-story).

**The file reaches the dispatcher as a reader, read at most once a pulse.** `GoalIntake.discussion` is a memo of
`DiscussionFiles.read` built fresh on each pulse (`memoReader`) and carried into `DispatchContext.discussion`; the
hold and the section read the same memo. Absent where discussions are off.

## What fleet agents write

One new MCP tool, `discussion_add`, in `src/mcp/tools/discussionAdd.ts`:

```
discussion_add({ kind: 'note' | 'idea' | 'question', body: string })
```

- The ref is the agent's own origin, never an argument — an agent writes to the story it is working
  on and nowhere else. That is the `issue:<n>` subtree, the story behind a `pr:<n>` origin (`issueForPr`
  over the stored world, so a reviewer can ask too), or the work a `job:<id>` requeue stands in for. Any other
  origin is refused.
- A first write creates the file, headed from the world's issue (`discussionSubject`,
  `src/discussions/subject.ts`): a container type is a `feature`, anything else a `story` with its parent.
- `kind: 'decision'` is refused. Decisions are the operator's.
- It shares its name with the desktop tool of the same name, as `validation_report` does; the two
  are separate builds on separate channels, and a change to one is checked against the other. →
  [11](11-mcp-tools.md#the-desktop-channel)
- The author is written as `agent <rule>#<task id>`.
- Like every new tool it is named in `MCP_TOOL_NAMES` and placed in `UNIVERSAL_TOOLS`, or it is in
  no agent's `tools/list`. → [11](11-mcp-tools.md#which-tools-an-agent-is-advertised)

## An open question holds the story

**An open question on a story holds every new dispatch for that story** — the planner and every
part — as `held: 'questions'`. **An open question on its feature holds the story only while it has
no plan yet**: a story already planned or under way carries on. → [decided](#decided) It shows in Up next as _waiting on N open questions_
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
- **Where it is applied.** `questionHold` (`src/discussions/questionHold.ts`) is read through
  `StageContext.issueHold(n)` (`discussionView`, built beside `sequencingView` in
  `src/dispatcher/ruleDispatcherStage.ts`), which answers the sequence hold first and the question hold second,
  as `{held, reason}` — so rules `issue-appraisal`, `issue-investigate`, `issue-plan` and `plan-part` each ask
  once, and every pre-plan and planned dispatch for the story is held the same way. `plan-part` asks with
  `sequence: false`: a part is held by its own plan's dependencies, never by the story order
  ([33](33-story-sequencing.md#readiness-and-the-hold)). It is not an `issueGates` filter, which drops an issue
  silently; a hold stays a queued row. "Has a plan" is any plan row for the story. A part still counts against
  `maxConcurrentPartsPerIssue` while held, and `capped` wins over `questions`, so lifting the hold never takes a
  story over its cap. Which holds an expedite or override lifts is `LIFTABLE_HOLDS`, beside `RuleHeld` in
  `src/dispatcher/admission.ts`.
- **What Up next shows.** The row's status is `questions`, labelled _open questions_; its reason reads _Held:
  waiting on N open questions — answer them in `<path>`_, naming every file they are in, the story's first.

## Pulling tracker comments in

Comments other people leave on the ticket are pulled into the file on the harness cycle:

- Each new comment since `pulled` is appended as a **Note** authored `@<login> (tracker)`.
- **The harness's own comments are skipped** by record, never by author: the published comment's id
  is in `published`, and every other comment the harness posts on an issue needs a record of its id
  when sent — the same rule `pr_replies_sent` keeps for review replies. The operator's login is not a
  test: on a single-operator deployment it is the harness's login too. →
  [07](07-pull-requests.md#attribution-is-a-record-never-an-identity)
- An operator turns a pulled note into an idea, question or decision by editing its heading.

`DiscussionPullDesk` (`src/discussions/pullDesk.ts`) is built in the foundation and runs as pulse pass
`discussionPulls`, last in `reconcile` and `readWorld: true` — so a local cycle pulls nothing.

- **Only an issue that already has a file is pulled**, and only one the world snapshot lists. A pull never
  creates a file. The pass is off where `discussionsDir` is unset or no issues provider can list comments.
- **Each issue is pulled at most every five minutes** on the cycle, held in memory, so a busy fleet's 30s
  pulse is not a comment listing per file per pulse. `discussion_pull` is not held to it. Two pulls of one
  issue at once share one run, and the pass runs at most four issues' pulls at a time.
- **`pulled` is the newest comment's own `createdAt`**, the harness's own comments included, and is handed
  back to the provider as the lower bound; only comments created strictly after it are taken. Compared as
  dates, never as strings — providers differ in precision. **A pull is one write** (`addMany`): every new note
  and the new `pulled` land together or not at all, so `pulled` never passes a comment that is not in the file.
- **The record of the harness's own comments is `issue_comments_sent`** (`src/store/issueComments.ts`), one row
  per comment by the provider's id. It is written by `recordIssueComments` (`src/sink/issueCommentsSent.ts`), a
  wrapper the foundation puts round the sink, so every `upsertIssueComment` the harness sends — the appraisal's,
  a plan's, an environment's, the desktop's `discussion_publish` (handed the foundation's sink as
  `DesktopToolDeps.comments`) — is recorded wherever it is called from, with no call site to forget. A comment sent before the table has no
  row and is pulled as anyone else's; there is no backfill, because the only evidence on those is the author.
- **A failure to read the tracker is recorded** through `errors.record` and leaves `pulled` where it was.
- An Azure DevOps comment's text is HTML and lands as it is; a Markdown file carries HTML.

Reading issue comments is new to both providers: `GitHubApi.listIssueComments` and
`AzureDevOpsApi.listWorkItemComments` (named as the Azure interface names its other work-item comment calls),
surfaced as the integration capability `IssueCommentReadable` and `CompositeConnector.listIssueComments`. The
fake issues provider lists what it has posted and takes an injected `issue_comment` event; its own comments are
authored `operator`, the operator's login, so a test of the by-record rule fails if the rule becomes an author
test. → [15](15-integrations.md)

## Talking it through in Claude

**The main way in is a conversation in the operator's own Claude, through the LubbDubb plugin** —
the desktop channel ([11](11-mcp-tools.md#the-desktop-channel)), not the cockpit. Discussion is talk,
and the place the operator already talks is Claude. The files and the cockpit are for reading it back.

`/lubbdubb:discuss <n> [what's on your mind]` opens a conversation about story or feature `<n>`. The
skill lives at `plugin/skills/discuss/SKILL.md` and ships with the plugin like every other skill.

1. **It reads first.** `discussion_read` returns the file's entries, plus — for a story — its
   feature's standing decisions and open questions, and for a feature its stories' open questions.
   Claude opens with what is still open, not a recap of everything.
2. **It talks.** Claude has the repository open, so a question the code can answer, it answers by
   reading the code, and proposes the answer for the operator to accept. A product question it asks.
3. **It writes down what the conversation settles,** as it goes — never the transcript. Each write
   is shown before it is made: _"Log this as a decision: export uses the browser download?"_ Nothing
   lands without the operator's yes.

### The desktop tools

Named in `DESKTOP_TOOL_NAMES`, built in `src/mcp/desktopDiscussion.ts`, never in `buildTools`:

| Tool                 | Does                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `discussion_read`    | The entries for one story or feature, with the related ones described above.               |
| `discussion_add`     | Adds a note, idea, question or **decision**. Author is written as `operator (via Claude)`. |
| `discussion_settle`  | Answers a question; accepts, parks or drops an idea; supersedes a decision.                |
| `discussion_publish` | Posts the summary the operator approved. → [publishing](#publishing)                       |
| `discussion_pull`    | Pulls new tracker comments in now, rather than waiting for the cycle.                      |

- **Decisions can be written here and nowhere else in the fleet**, because the operator is in the
  conversation. Claude proposes the wording; the operator's yes is what makes it a decision.
- **Claude's own view is labelled as Claude's.** An idea Claude suggests and the operator wants kept
  is written as an idea authored `Claude (suggested)`, not as the operator's.
- **Every write goes through the same object the cockpit's would** — `src/discussions/discussionFile.ts` —
  never a second implementation. → [11](11-mcp-tools.md#every-write-goes-through-the-object-the-cockpits-click-goes-through)
- **Each write tells the cockpit** through `DesktopToolDeps.changed`, so a page that is open shows it.
- **Answering an open question lifts its hold** on the next cycle, so a `/lubbdubb:discuss` that
  clears the last question is what lets the story start.
- **`discussion_read` is the cockpit's reading**, `readDiscussion` (`src/discussions/related.ts`), with the
  file's `published` and `pulled` (its front matter, carried beside the reading) and the open questions pulled
  to the front as `open`. A first `discussion_add` heads the file the way the fleet tool does
  (`discussionSubject`, `src/discussions/subject.ts`), and refuses an issue the world does not list and that has no file —
  a mistyped number never becomes a file.
- **`discussion_read` names what was written by hand.** A question typed into the file in Obsidian has no
  `^id` until something writes to the file, and an entry with no id cannot be settled — so the read
  first calls `DiscussionFiles.identify` on the subject and on every related file, adding the missing
  ids and nothing else, and reads again only if one of them changed a file. Without it, a question the operator wrote themselves holds the story and can
  never be answered from Claude.
- **`suggested: true`** is how an idea is written as `Claude (suggested)`; it is refused on any other kind.
  `discussion_settle` takes the entry's id with or without its `^`; `answer` and `supersede` need `text`,
  and a supersession is authored `operator (via Claude)`.
- **The broadcast is `dirty` for `goals` and `queue`** — the Discussion tab and the hold in Up next.
- Everything is a refusal with discussions off, saying `discussionsDir` is what turns them on.

### Where else it is reached from

- `/lubbdubb:next` offers a held story's open questions as one ask, and hands off to
  `/lubbdubb:discuss <n>` to answer them. **Not yet built:** a held story is not a row in "Needs you", so
  `ask_next` cannot hand it out; for now the skill says a story waiting on questions is not an ask there,
  and hands off to `/lubbdubb:discuss <n>` when the operator raises one.
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

It refuses where the issue has no file — there is nothing to publish from and nowhere to keep the id. It posts
through the foundation's sink, so the id is also written to `issue_comments_sent` by the same wrapper as every
other comment, so the comment is never [pulled back in](#pulling-tracker-comments-in)
even if `published` is edited away. A tracker that refuses is a refusal and leaves `published` as it was; a
comment posted whose id cannot be written to the file is a refusal that says so, because publishing again
would then add a second comment.

Nothing reaches the tracker without step 2. The tool takes only the final text; it composes nothing.

## Turning an idea into a story

In the conversation — _"make that a story"_: the skill hands off to `/lubbdubb:file` with the idea's
body as the starting draft and its feature as the parent, so the ticket gets the same checks, watch
label and confirmation as any other. Once it is filed, `discussion_settle` marks the idea `accepted`
with a `Became [[<n> <slug>]]` line. Everything the ticket must carry goes in `IssueCreateInput`
through `ticketFiler`, not in a prompt. → [13](13-jobs-and-tickets.md#filing-a-ticket)

## In the cockpit

A read-mostly **Discussion** tab on the story and feature views (`DiscussionPane`,
`web/src/components/DiscussionPane.tsx`): the entries with a kind chip and a state chip, filters by kind
and state, a link that opens the file, and a button that opens `/lubbdubb:discuss <n>` in Claude. Open
questions are drawn on an amber ground (`--cn-question-fill`, `--cn-question-rule` — mixes of
`--cn-amber`) because they are the entries that hold work. Every ref drawn with `<Ref>`. It writes
nothing: every change is made in Claude or in the file.

- **On the goal page it is a pane**, `discussion`, between Ask and Plan — and **only where
  `discussionsDir` is set** (`CockpitConfig.discussions`, read by `goalPanes`), the same way `watch` is
  drawn only where an environment declares one. A tab that can only say "off" on every goal is a stage the
  goal can never reach. It is a place, not an obligation: never chosen by the landing rule, and qualified
  by no environment. → [17](17-cockpit.md#the-panes)
- **On the feature page it is a section under the detail**, drawn whatever the setting: with
  `discussionsDir` unset it is a short note saying to set it, which is the one place the cockpit offers
  the feature to a deployment that has not turned it on. → [17](17-cockpit.md#the-feature-page)
- **The filters are a place** — `?dkind=` and `?dstate=` on `Place`, never a `useState` — so a link
  to "the open questions on #142" is a link. → [17](17-cockpit.md#the-address-bar)
- **What it reads** is `GET /api/discussions/:number` (`src/server/routes/discussions.ts`, assembled by
  `readDiscussion` in `src/discussions/related.ts`): `enabled`, the file's `path` (null where none has
  been written), its entries, and the related ones — for a **story** its feature's standing decisions
  and open questions; for a **feature** the standing decisions and open questions of each story under it
  that has any. Story or feature is decided by `resolveSubject` (`src/discussions/subject.ts`), the one
  resolver every reader and writer of a file uses: a container type (`isContainerIssue`) is a feature, and so
  is an issue with no parent and stories under it (a tracker with no issue types); anything else the world
  holds is a story; the file's own front matter decides only where the world cannot say. A feature's stories
  are `storiesUnder` (`src/issueRelations.ts`), which `sequence_read` uses too. → [16](16-http-api.md#get-apidiscussionsnumber)
- **The file link is `obsidian://open?path=…` when the file sits inside a vault** — a folder above it
  holding `.obsidian/` — and otherwise the path itself, drawn as text: a browser will not follow a
  `file://` link out of an `http://` page, so a link there would be a control that does nothing.
- **It re-reads whenever the snapshot's `world` is refreshed** — a `goals` section refresh, or a full one.
  A write from Claude broadcasts `goals` and `queue` through `DesktopToolDeps.changed`, so it shows
  straight away while the tab is open. An agent's note shows on the next full refresh (agent done, or the
  end of the cycle). The `fleet`- and `activity`-only refreshes a running agent sends many times a minute
  do not re-read it. A read is a `stat` of the folder and of each file it touches, and a parse only of a
  file that changed.
- The open questions **holding a story** are drawn in Up next as well, by the hold. →
  [the hold](#an-open-question-holds-the-story)

## Where it will live

| Piece                          | Path                                |
| ------------------------------ | ----------------------------------- |
| File reading and writing       | `src/discussions/discussionFile.ts` |
| Parsing the Markdown           | `src/discussions/parse.ts`          |
| Selecting entries              | `src/discussions/entries.ts`        |
| The hold                       | `src/discussions/questionHold.ts`   |
| Reader, story-and-feature pair | `src/discussions/reader.ts`         |
| Story or feature               | `src/discussions/subject.ts`        |
| Pulling tracker comments       | `src/discussions/pullDesk.ts`       |
| Prompt section                 | `src/discussions/promptSection.ts`  |
| The fleet agent's tool         | `src/mcp/tools/discussionAdd.ts`    |
| The desktop tools              | `src/mcp/desktopDiscussion.ts`      |
| The skill                      | `plugin/skills/discuss/SKILL.md`    |
| Read route for the tab         | `src/server/routes/discussions.ts`  |

## Decided

- **The prompt section's budget is about 6,000 characters.** Decisions, accepted ideas and answered
  questions come first and are never cut; notes fill what is left, newest first.
- **An open question on a feature holds only the stories under it that have no plan yet** — work not
  started. A story already planned or under way carries on; the feature's question is for what has
  not been shaped. **An open question on the story itself holds every new dispatch for it**, planner
  and parts alike.
