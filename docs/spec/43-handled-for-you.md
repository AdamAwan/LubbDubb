# 43 — Handled for you

**Not yet built.** Everything below describes the intended behaviour; the identifiers are in italics
until they exist.

Most of what reaches the queue rail ([17](17-cockpit.md#the-queue-rail--needs-you)) is a small call
the harness gets right nearly every time, and that costs almost nothing to put back when it is wrong:
which board a task goes on, which profile a goal gets, a missing setting's default. Asking first
spends the operator's attention on rows they approve without reading, and that buries the asks that
do need them.

So a fixed set of ask kinds is **done without asking, recorded, and shown afterwards** on one page,
grouped by kind, each row with an undo. The operator scans it, undoes anything wrong, and marks each
group checked.

## Invariants

- **Which kinds are handled is a fixed list in code (_`AUTO_KINDS`_), never an agent's judgement.** An agent asked "is this safe to undo?" will sometimes be wrong, and wrong in silence. The agent judges only how confident it is _within_ a kind the list allows. → [§](#the-list) · _no test_
- **A kind is on the list only if it has a working undo.** The test for a kind is how easy it is to put back, not how often it is right; a kind whose undo cannot be built stays an ask. → [§](#undo) · _no test_
- **Nothing that affects other people, or that cannot be fully put back, is handled.** Those stay asks on the rail exactly as today. → [§](#what-stays-an-ask) · _no test_
- **Every handled action is recorded before it is reported, and an action with no record is not taken.** An action nobody can see is an action nobody can undo. → [§](#the-record) · _no test_
- **A kind handled "until stuck" raises the ordinary ask once its own fix has failed; it never retries forever.** → [§](#until-stuck) · _no test_

## The list

**Handled.** The harness acts and records it.

| Kind (`src/asks/kinds.ts`) | What the harness does                                |
| -------------------------- | ---------------------------------------------------- |
| `placement`                | Moves the task to the board it judged right          |
| `profile`                  | Sets the goal's profile                              |
| `config_gap`               | Fills the missing setting with its default           |
| `limit`                    | Restarts the parked work when the usage limit resets |
| `upgrade`                  | Applies the harness update ([21](21-self-update.md)) |
| `project_pull`             | Turns the project's auto-pull back on                |

**Handled until stuck.** The harness tries its own fix; if the problem is still there afterwards, the
ordinary ask is raised.

| Kind          | What the harness does                                    |
| ------------- | -------------------------------------------------------- |
| `dispatch`    | Clears what the executor refused on and dispatches again |
| `fleet_stall` | Restarts the stalled agents                              |

Every other kind stays an ask.

### What stays an ask

Kept because the action reaches other people: `assign`, `assigned`, `merge`, `reply`, `bot_pr`. Kept
because it needs the operator's judgement or is hard to put back: `questions`, `describe`,
`description_note`, `description_wrong`, `unwatched`, `plan`, `shortfall`, `intake`, `findings`,
`permission`, `escalation`, `recovery`, `config`, `burn`, `supply`, `bench`, `close_out`, `validate`,
`validation_plan`, `watch`, `watch_reading`.

Moving a kind onto the list is a code change with its undo and its test, never a setting.

## Until stuck

A `dispatch` or `fleet_stall` gets **two** attempts at the harness's own fix. If the condition is
still there after the second, the ask is raised as it is today, and the handled row for the attempts
says so: _"tried twice, now in Needs you"_.

## The record

Each handled action writes one row to _`handled_actions`_ ([14](14-persistence.md)): the kind, the
subject it acted on, the before and after values, the reason in one line, the confidence (or `rule`
for a kind with no judgement in it), and its state — _`open`_, _`checked`_ or _`undone`_.

Confidence below **80%** still acts, because every kind on the list is cheap to undo, but the row is
flagged so it stands out on the page.

## Undo

Each kind on the list carries an undo that restores the recorded _before_ value: the old board, the
old profile, the setting unset, the job parked again, the previous build, auto-pull off. An undo that
cannot complete — the subject has since moved on — says so on the row and changes nothing.

An undone row stays on the page, struck through, with a redo.

## The page

One page, opened from the rail. It shows the open rows, grouped by kind, newest first within a
group. Each row is one line: the subject as a reference, what changed, the reason and the
confidence, and **Undo**. Each group has **Mark checked**; the header has **Looks good, mark all
checked**, the count still to check, the count undone, and a link to what still needs the operator.

A checked group folds to its title. Checked and undone rows stay in the record; the page shows the
last 24 hours by default.

## On the rail

One line at the foot of the queue rail, under the asks: **Handled for you**, with the count of open
rows. It is drawn quietly — no kind colour, a dashed outline — so it never reads as an ask. At zero
the count is gone and the line stays. It is not an ask row and does not enter `buildAskQueue`
(`src/asks/queue.ts`) or `ask_next`.
