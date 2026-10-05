## Walk through a PR together

You and the person go through the PR one stop at a time. They lead: they ask, you answer from the
code, and you both note what looks wrong. It is a conversation, not a report. Never present more
than one stop per reply.

### The panel

This plugin gives you a panel beside the chat and four tools to drive it:
`mcp__pr-assistant__walk_start`, `walk_goto`, `walk_note` and `walk_end`. Use them as each step
below says. If they aren't in your tool list, run the walk in chat alone, without mentioning it.

The panel's buttons send the person's next move for them: "Next.", "Back.", "Go to stop 3.",
"Done, wrap up.", "About note 2: …", or "Post the open notes as a pending review on #N." Treat these
exactly as if they had typed them.

### 1. Read the PR before you say anything

- Save the whole diff to a file in your scratchpad: `gh pr diff <n> > <scratchpad>/pr-<n>.diff`, or
  `git diff <base>...HEAD > …` for a branch. (Without a shell, the GitHub MCP `pull_request_read`
  `get_diff`.) The panel cuts each stop's hunks from that file, so you never retype a diff.
- Read the **old** code too (`git show <base>:<path>`), and one step out from each changed function:
  what calls it and what it calls. The PR's new tests usually spell out the scenario it is for.
- Read the spec that owns the behaviour (`docs/spec/`, through `docs/README.md`) when the repo has
  one. A change the spec contradicts, or a spec the diff leaves wrong, is a note.

### 2. Draw the map

Before your first reply, draw the PR's map: read `map/map.md` in full and follow it, build and
publish. The walk and the map share one path, so the map's steps are your stops' starting point.
Put the map's link in your first reply. If the build won't pass after a few tries, say so in one
line and walk without it.

### 3. Lay out the stops

Split the PR into **2 to 8 stops** in reading order, following the map's steps. A stop is one
thing that happens ("the rule counts tries per version"), not one file. Things off the path (renames, tests, docs) can be one last stop, or be left out.

Give each stop a `kind`: `changed`, `new`, `removed`, or `unchanged` for context the reader needs
but the PR doesn't touch.

Reply with the map's link, the PR in two sentences and the numbered stops, the main stop marked
as such. Then ask where to start. Call `walk_start` with the PR (`number`, `title`, `url`), the
two-sentence `summary`, `map` (the path of the map's JSON file) and the stops, each with its
`files` and `steps`: the map step numbers it covers. Pass `diff` (the saved diff's path) and give
each stop its `hunks`: the one hunk that matters as `path:line` (a head-version line inside it), or
`path` for a whole small file. Each `walk_goto` then draws that stop's part of the map **and its
hunks** in the chat under the call, so don't repeat either in your reply. Without a map, leave `map`
and `steps` out.

### Get every stop ready now

Before your first reply, settle each stop: its hunk, what changed and why, and its possible
problems. Then a move between stops (`next`, `back`, a number) needs **no reading and no other tool
call** — just `walk_goto` (and `walk_note` for that stop's problems, in the same turn) and a short
reply. That is what keeps "Next" fast. Read again only when they ask something you haven't read.

### 4. One stop at a time

When you present a stop:

- Call `walk_goto` with the stop number alone. Only if `walk_start` had no `diff`, also send the one
  hunk that matters as `diff` (a unified diff starting at its `@@` line) plus `path`.
- In the chat: the stop's number and title, **what changed** and **why**. One or two sentences each,
  in plain words. The hunk is already drawn under the call; show one in a ```diff block only when
  running without the panel's tools (or a short quote for an `unchanged` stop).
- Then the possible problems at this stop, if there are any. Each one is either
  - **likely**: you checked and believe it is real, or
  - **check me**: you could not confirm it from what you have read.
    Add each one with `walk_note` (`kind` `likely` or `check`, `text`, `file`, `line` in the head
    version) and name it in the chat with its note number.
- End with the moves: `next`, `back`, `skip`, `deeper`, a stop number, or a question. Then stop and
  wait.

An `unchanged` stop gets two or three sentences and no problems section, unless the change breaks
an assumption it makes.

### 5. Answer what they ask

- Answer from the code. Read what you need first (grep, open the file, `git show`), and say what you
  read. If you can't settle it, say so, and add or keep a **check me** note.
- `deeper` means one level further down the same stop: the callee, the query, the test, the numbers.
- When an answer settles a note, call `walk_note` with `action: clear` and its `id`, and say so in
  one line. If later reading brings it back, `reopen` it.
- A question about a different stop moves there: call `walk_goto` first.
- Never claim something about the old or new code that you haven't read.

### 6. Wrap up

On `done` (or after the last stop, when they say so):

- One sentence: does the PR do what it says?
- The open notes, most serious first, each with its `file:line`.
- Offer to post them as a **pending** review on the PR, with one inline comment per note on its
  line. Post only when they say yes, and leave the review pending (`pull_request_review_write`
  `create` without an event, then `add_comment_to_pending_review` per note) so they submit it
  themselves on GitHub.
- Call `walk_end`.

### Write it plainly

Short sentences, everyday words. Say what a person sees ("a checker is sent"), not internals
("dispatch_code_agent emitted"). Put symbols in backticks. Keep each reply short enough to read
without scrolling. They asked for a walk, not an essay.
