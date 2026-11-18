# 43 — Handled for you

`src/handled/`. **Partly built.** Running: the record, the page, the rail line, and two kinds,
`profile` and the board half of `placement`. The other kinds on [the list](#the-list) are **not yet
built** and stay asks until they land; each says so below, and identifiers that do not exist yet are
in italics.

Most of what reaches the queue rail ([17](17-cockpit.md#the-queue-rail--needs-you)) is a small call
the harness gets right nearly every time, and that costs almost nothing to put back when it is wrong:
which board a task goes on, which profile a goal gets, a missing setting's default. Asking first
spends the operator's attention on rows they approve without reading, and that buries the asks that
do need them.

So a fixed set of ask kinds is **done without asking, recorded, and shown afterwards** on one page,
grouped by kind, each row with an undo. The operator scans it, undoes anything wrong, and marks each
group checked.

## Invariants

- **Which kinds are handled is fixed in code, never an agent's judgement.** An agent asked "is this safe to undo?" will sometimes be wrong, and wrong in silence. The agent proposes a value; the code decides whether proposing it is enough. → [§](#the-list) · `test/handledForYou.test.ts`
- **A kind is handled only if it has a working undo.** The test for a kind is how easy it is to put back, not how often it is right; a kind whose undo cannot be built stays an ask. Setting a parent Feature has none, so it is still asked. → [§](#undo) · `test/handledForYou.test.ts`
- **Nothing that affects other people, or that cannot be fully put back, is handled.** Those stay asks on the rail exactly as before. → [§](#what-stays-an-ask) · _no test_
- **An action is recorded only once its write landed, and a failed write leaves the ask standing.** A row on the page is a change that happened; a change that did not happen is still the operator's question. → [§](#the-record) · `test/handledForYou.test.ts`
- **An undo or redo that fails leaves the row's state as it was.** A profile write that fails part-way may already have removed the other model tags, as any pin does ([02](02-configuration.md#a-proposal-is-taken-without-asking-and-can-be-put-back)); the row still reads as before, so the operator can press again. → [§](#undo) · `test/handledForYou.test.ts`
- **A kind handled "until stuck" raises the ordinary ask once its own fix has failed; it never retries forever.** → [§](#until-stuck) · _no test_

## The list

**Handled.** The harness acts and records it.

| Kind (`src/asks/kinds.ts`) | What the harness does                                                   | Built                                     |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `profile`                  | Pins the profile a `workable` appraisal proposed                        | yes                                       |
| `placement`                | Moves the item to the board (area path) a `workable` appraisal proposed | yes — the area path; a parent stays asked |
| `config_gap`               | Fills the missing setting with its default                              | not yet                                   |
| `limit`                    | Restarts the parked work when the usage limit resets                    | not yet                                   |
| `upgrade`                  | Applies the harness update ([21](21-self-update.md))                    | not yet                                   |
| `project_pull`             | Turns the project's auto-pull back on                                   | not yet                                   |

**Handled until stuck.** The harness tries its own fix; if the problem is still there afterwards, the
ordinary ask is raised. Not yet built.

| Kind          | What the harness does                                    |
| ------------- | -------------------------------------------------------- |
| `dispatch`    | Clears what the executor refused on and dispatches again |
| `fleet_stall` | Restarts the stalled agents                              |

Every other kind stays an ask.

### Where the built kinds are handled

The `appraise_issue` tool awaits the `handleAppraisal` seam after it records a `workable` verdict
(`src/mcp/tools/appraiseIssue.ts`). `handleAppraisal` (`src/handled/handled.ts`) reads the stored
appraisal and the world, and for each proposal still unanswered writes it through the same function
the operator's own click uses — `applyProfilePin` for the profile, `settlePlacement` for the area
path — so the appraisal is answered exactly as if the operator had pressed. Only the fleet's
appraiser is handled this way: an operator who appraises a goal themselves is already looking at it.

A failure is recorded on the error log and leaves the ask on the rail. So does an issue missing from the stored world: without its current tag there is no _before_ to put back.

### What stays an ask

Kept because the action reaches other people: `assign`, `assigned`, `merge`, `reply`, `bot_pr`. Kept
because it needs the operator's judgement or is hard to put back: `questions`, `describe`,
`description_note`, `description_wrong`, `unwatched`, `plan`, `shortfall`, `intake`, `findings`,
`permission`, `escalation`, `recovery`, `config`, `burn`, `supply`, `bench`, `close_out`, `validate`,
`validation_plan`, `watch`, `watch_reading`. The parent half of `placement` stays an ask too.

Moving a kind onto the list is a code change with its undo and its test, never a setting.

## Until stuck

Not yet built. A `dispatch` or `fleet_stall` gets **two** attempts at the harness's own fix. If the
condition is still there after the second, the ask is raised as it is today, and the handled row for
the attempts says so.

## The record

Each handled action writes one row to `handled_actions` ([14](14-persistence.md#handled-actions)):
the kind, the issue it acted on, the value before and after, a one-line reason, and its state —
`open`, `checked` or `undone`.

The appraisal gives no confidence figure, so none is recorded. A kind that comes to carry one can
flag its low-confidence rows on the page.

## Undo

Each kind carries an undo that writes the recorded _before_ value back through the same function that
wrote the _after_: the old area path, the old profile pin (or none). An undone row stays on the page,
struck through, with **Redo**. Undo, redo and check are routes
([16](16-http-api.md#get-apihandled--post-apihandledcheck--post-apihandledidundoredo)).

## The page

The `handled` tab of the cockpit, opened from the rail rather than the top bar. It shows the last 24
hours, grouped by kind. Each row is one line: the issue as a reference, `before → after`, the reason
and when, and **Undo**. Each group has **Mark checked**; the header has **Looks good, mark all
checked**, the count still to check and the count undone. A checked group folds to its title.

## On the rail

One line at the foot of the queue rail, under the asks: **Handled for you**, with the count of open
rows (`handledOpen` on the state snapshot). It is drawn quietly — no kind colour, a dashed outline —
so it never reads as an ask. At zero the count is gone and the line stays. It is not an ask row and
does not enter `buildAskQueue` (`src/asks/queue.ts`) or `ask_next`.
