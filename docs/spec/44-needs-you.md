# 44 — The Needs you page

**Built.** The page — the `needs` tab, its fleet tiles and two columns, the Claude button and the listener status —
and the server side under it: the listener (`src/listen/listener.ts`), the desktop tools `ask_wait`
and `pr_read`, `POST /api/listen/send`, the snapshot's `listener`, the `listen` and `pr` skills, and
[sending by itself](#sending-by-itself) (`src/listen/autoSend.ts`), off by default.

The overview answers _what is the fleet doing_. That stopped being the operator's question: what
matters is **what is waiting on me** — the orchestrator's asks and the pull requests that need a
person. And most of the time the operator does not want to answer an ask with a button; they want to
**talk it through with Claude**, in the Claude desktop app, where the conversation can flow.

So this is a new cockpit tab, **Needs you**, beside the overview rather than replacing it. The
overview stays where it is until this page has proved itself; the one thing the two share is the
[pull-request card](17-cockpit.md#the-pull-request-card), so a pull request reads the same on both. The listen loop below is
part of this page **only**: no other surface sends anything to it — the one exception being the harness
itself, [sending a pull request by itself](#sending-by-itself) where the operator turned that on.

## Invariants

- **The rail and the overview's shapes are unchanged.** This page is a new tab; nothing about Focus mode or the queue rail moves, and of the Cards overview only the pull requests card changed — to the [pull-request card](17-cockpit.md#the-pull-request-card) this page draws too. → [§](#where-it-sits) · _no test_
- **Every column scrolls on its own.** A long list in one column never pushes another out of view. → [§](#where-it-sits) · _no test_
- **The asks are grouped by family, in the queue's order inside each.** `askFamilies` filters and never sorts; urgency is a tag, not the order. → [§](#from-the-orchestrator) · `test/needsYouPage.test.ts`
- **An ask opens in place with the same body the ask panel draws.** The opened card renders `needBody`, never a second copy of an ask's actions, so the card and the panel cannot disagree about how an ask is closed. → [§](#opening-an-ask-in-place) · `test/needsYouPage.test.ts`
- **Only this page sends to the listening chat, besides the harness's own sending.** `POST /api/listen/send` has one caller, `web/src/console/NeedsYouPage.tsx`; every other surface keeps its own buttons and its own deep links. The one other sender is `AutoSend`, server side. → [§](#scope) · `test/needsYouPage.test.ts`
- **Sending by itself is off by default, and needs every CI check passing.** Both `listen.autoSend*` keys default to false; a pull request with any check failing, pending, unread or withheld — advisory ones included — is never sent. → [§](#sending-by-itself) · `test/listenAutoSend.test.ts`
- **A pull request is sent by itself at most once per reason while it is open**, and never for what already qualified on the first pass after sending was turned on. → [§](#sending-by-itself) · `test/listenAutoSend.test.ts`
- **Which pull requests are on the page is `prOnYouReasons`, one pure function the server and the page share.** A pull request is on the page when any one of its reasons holds, and a reason is read off fields the server already decided — never re-derived in the browser. The page, the pruning of `sent` and `pr_read`'s `onYou` all read its keys. → [§](#pull-requests-waiting-on-you) · `test/prsOnYou.test.ts`
- **The page reads `listener.state`; it never guesses.** `listening`, `busy` and `off` are the server's, off whether a wait is open. → [§](#is-a-chat-listening) · `test/needsYouPage.test.ts`
- **A wait is bounded.** `ask_wait` returns by itself after `LISTEN_WAIT_MS` (10 minutes) with nothing, and the skill calls it again; a held call never outlives that bound. → [§](#the-wait) · `test/listener.test.ts`
- **The listener tells the cockpit only when what it shows has changed**, and that is its own `listener` section — never a rebuild of the ask queue. → [§](#the-wait) · `test/listener.test.ts`
- **An item is handed out once.** A sent item leaves the queue the moment one `ask_wait` returns it; a second waiter never receives it too. → [§](#the-wait) · `test/listener.test.ts`
- **The listen loop decides nothing.** `/lubbdubb:listen` hands each item to the same reading the `next` skill does; the operator answers. → [§](#the-listen-skill) · _no test_
- **`ask_wait` names the skill line and the title; the skill only runs them.** Which skill a pull request is talked through with is `listen.prSkill`, read by the tool, never by the chat. → [§](#the-wait) · `test/listenAutoSend.test.ts`

## Where it sits

A `ConsoleTab`, `needs`, reached at `?tab=needs` and drawn by `web/src/console/NeedsYouPage.tsx`. The
top bar names it **Needs you** with a `new` tag. It is not the default home: the overview stays the
first tab until the operator decides otherwise.

Whether the page is in front — its tab, with no goal or pull request opened over it — is one
function, `needsYouInFront` (`web/src/view/needsYouPage.ts`), which the shell reads.
On this tab the shell draws no queue rail — the page _is_ the queue, at full width, and the rail
beside it would be the same list twice. The [Work tab](17-cockpit.md#the-work-tab) hides it too, for
the same reason — every row there already says what holds its goal — and keeps it hidden on the goal,
pull-request and agent pages opened from Work (`workInFront`, `ConsoleRoot.tsx`), so opening a row's
detail does not bring back the list the operator left. Everywhere else the rail is where it has always
been.

The page is, top to bottom:

1. **The heading row**: `Needs you`, the counts (`7 asks · 6 pull requests`), and on the right the
   [listener status](#is-a-chat-listening).
2. **[The fleet](#the-fleet-panel)** — a full-width row of agent tiles.
3. **Two columns** — the asks and the pull requests — side by side at 760px and wider; below that
   they stack.

The page is capped at 1800px wide and centred, for the same reason as the columns below — on an
ultra-wide screen.

**Each column scrolls inside its own height** (`max-height: calc(100vh - 340px)`, which leaves room for the top bar, the heading and two rows of fleet tiles), with its heading
fixed above the scroll. That is the reason for the columns: with the asks and the pull requests in one
list, a long run of asks pushed every pull request below the fold, and the operator went back to the
overview to find them. Side by side, each column is narrow enough that a card reads as one block
instead of a line stretched across the screen.

The top bar is the same here as on every other tab — the fleet control, cap and scan countdown stay
where they are, because this page is where an operator answers, and answering often means pausing or
widening the fleet.

### The fleet panel

A full-width card above the columns, so the fleet is the first thing seen without taking a column
from the asks or the pull requests. Its top line is `n of cap out`, `n queued`, a thin bar for how
full the cap is, and on the right `Overview ›`, to the full fleet. Under that, **one tile per live
agent**, in a grid that fills the width and wraps (`auto-fill`, tiles at least 220px): its status lamp (the fleet's own, from `agentLamp`), its
task title, how long it has been out, and a second line — a state chip where the agent is stopped
(`question` red, `limit` or `waiting` amber) and its latest note, or `running`. Agents with an open ask
come first, then waiting or limit-parked ones; an agent with an open ask also carries a red left edge.
Pressing a tile opens that agent's drawer. Every agent out is listed — there is no fold — but the
grid shows two rows and scrolls past that, so a big fleet never pushes the columns below the
screen. With none out it says
`No agents out.` Covered by `test/needsYouPage.test.ts`. Goals in flight are not on this page.

## From the orchestrator

The ask queue (`asks` on the snapshot, [17](17-cockpit.md#the-queue-rail--needs-you)) **grouped by
what kind of thing it asks for**, not by urgency. `askFamilies` (`web/src/view/askFamilies.ts`) maps
every kind to one of six families, in this order: **Something's wrong** (a watch check that read
regressed, and — from outside the queue — app errors put on a goal; [below](#somethings-wrong)),
**Questions** (an agent's question, open questions,
a permission, a profile, a reply draft), **Decisions** (a plan, a merge, findings, intake, placement, a
check plan, assignments, bot PRs), **Work to do** (bench work, close-outs, checks to run, taking a watch reading, unseen stories),
**Descriptions** (pull request descriptions to write or fix), and **Fleet and setup** (config,
recovery, refusals, stalls, limits, runway, upgrades). The map is total over the kinds, so a new kind
fails the typecheck until it is given a family. Inside a family the queue's own order is kept —
`askFamilies` filters, it never sorts. Empty families are not drawn.

Urgency is still on the page, but as a mark rather than the sort: an ask with `urgency: 'now'` carries
a red **answer now** tag on its card, and its family's heading carries `n now`. Ordering the whole
column by urgency put the operator's work in an order that did not match how they work through it —
all the questions, then all the decisions. Under the column's heading a row of **family chips** names
every family with its count, and a red dot where any of it is `now`, so the families below the first
are in view however long the first is; pressing a chip opens that family and scrolls to it. The row is
drawn only when there is more than one family. Each family is a fold; it opens on its own unless every ask
in it holds nothing (`urgency: 'later'`) — **Something's wrong** always opens on its own, since a watch
ask is `later` and the family exists to be seen — and that default follows the asks as they change; only a fold the operator pressed is remembered. The fold is per-visit state, not a `Place` field.

### Something's wrong

A declared watch check that read regressed ([29](29-post-deploy-watch.md#the-bench-row)) and an app
error put on a goal ([39](39-app-errors.md#on-the-goal)) are the same thing to the operator — _something
on an environment is not working as it should, and it is probably this work_ — and both were hidden:
the watch among the chores of Work to do, the error behind a small badge on the goal header. So they
share a family, first in the column and open by default.

- **Watch findings** are the queue's own `watch` asks, drawn as every ask is, with **Raise a bug** and
  **It's fine** in their body.
- **App errors are not in the queue.** The linked payload is too heavy for the snapshot
  ([39](39-app-errors.md#where-it-is-computed)), so the page reads the Errors tab's one poll
  (`useAppErrors`) — only where `CockpitConfig.appErrors` is true — and draws `needsYouProblems`
  (`web/src/view/appErrors.ts`) in the family after the watch asks: the moved errors put on a goal with
  no bug open, linked or guessed at `medium` confidence or above, **one per key** since filing is per
  key. A `low` guess stays on the goal and the Errors tab. Each card says first how the error was put
  on the goal — the link's `how` in red, or _agent's guess · high_ in amber and dashed, with the
  agent's reason under _Is this goal the cause?_ — then where, the goal, and the presses
  ([39](39-app-errors.md#on-the-goal)): **File bug** or **Yes, file bug**, **Not it**, and
  **Open errors**. A filed bug or a Not it takes the card off on the poll that follows the press.
- `askFamilies` takes what stands in a family from outside the queue as `extras` and gives each group
  its `extra` and `size`, so the family is kept while only app errors stand in it, and the column's,
  the family's and the chip's counts include them.
- Being off the queue, an app error is not an ask: `ask_next`, `attention_read`, the rail and the
  listen loop do not see it. The page and the goal strip are where it is answered.

Each row is the rail's row with room for its reason on the card rather than in a tooltip, and carries
two controls: its kind's verb (`KIND_VERB`, which opens the ask where it is answered, as the rail's row
does) and the [Claude button](#the-claude-button).

### The ask card

Each ask is a card of three parts, so the eye finds what it is about before reading what it asks:

1. **A small top line**: the kind in its tone's colour (`Escalation`, `Plan`, …), the age on the right,
   and a red dot after it when the ask is `urgency: 'now'`.
2. **The headline**, bold: what the ask is about — its goal's title, else the run it came from
   (`agentLabel`) — with its `<Ref>` beside it as a plain link. An ask with neither has its own text
   as the headline and no body.
3. **The body**: the ask itself, up to three lines.

The server's `title` is one line, `<ask>[ for #n] · <goal title>`, for the rail and Claude Code. A row
built by `askTitle` (`src/asks/lines.ts`) also carries `summary`, the ask without that suffix, and the
card's body is `summary`, falling back to `title` on a row without one. The headline reads the goal's
own title off the world, never out of the joined string. The ask's `note` (or a setup check's remedy) is a fourth, faint
line only when it says something the headline does not.

There are no boxes on the card: references are plain links, and the two controls — the Claude button
and the kind's verb — appear in the card's top-right corner on hover or focus, over the age, and are
always shown where the device has no hover. The urgency tier, `Blocking`, the holding count and the
agent's name are not drawn: the dot carries the first and the rest are one press away.

**`inGoal`.** `AskCard` (`web/src/console/askCard.tsx`) is also drawn under a goal's own heading — an
open row on the [Work tab](17-cockpit.md#the-work-tab). There the goal is already said, so with
`inGoal` the card drops the goal's title from the headline and its reference: the ask leads. An ask
about no goal keeps its run's name.

### Opening an ask in place

A press anywhere on the card opens it where it sits — the Needs you form of [a row opens in place](17-cockpit.md#a-row-opens-in-place) —
so an ask is closed without leaving the page:
picking a parent, OK-ing or declining a check set, answering a question. The opened card draws
`needBody` (`web/src/console/NeedsBand.tsx`) — the very body the ask panel shows under its own header —
below the headline. One card is open at a time, across every family; pressing the card's head again
folds it. The open card is a local fold, not a place: it is not in the address bar, and a reload
folds it.

Opened, the card drops what the body now says for itself — the summary, the note and the kind's verb
button — and keeps the headline, its reference and the Claude button. An ask whose `needBody` is null
(a setup check, an ask that opens a goal or pull request) has nothing to draw in place; it opens to
its full, unclamped text and keeps the verb button, which goes where it always went.

The press lands on one button laid under the card's text (`cn-ny-askfold`); the text lets clicks
through to it except on the references, the corner controls and the opened body, so a link or a
control inside the card never also folds it. Anything new on the card that must take a press or a
hover joins that list (`console.css`), or it silently stops answering. Unlike the goal page's
`FoldLine`, which keeps its own fold and draws the whole `NeedsBand`, the page holds one open id for
every card and draws the bare body, because the card already draws its own headline.

The foot of the column is the **Handled for you** line, exactly as on the rail
([43](43-handled-for-you.md#on-the-rail)).

An ask about a pull request is drawn here **and** on that pull request's row: the two columns answer
different questions, and the operator asked for both.

## Pull requests waiting on you

`prOnYouReasons` (`src/listen/prsOnYou.ts`) is the table, once: it answers a pull request's reasons as
keys, in this order, and is re-exported as a runtime value from `src/wire.ts` so the page calls the same
function the server does. A pull request is drawn when any of these hold; the first that holds, in this order, is the word its
card leads with:

| Key        | Tag                | Read off                                                              |
| ---------- | ------------------ | --------------------------------------------------------------------- |
| `review`   | `Your review`      | `attention.assignedToYou` is set                                      |
| `call`     | `Your call`        | `attention.status === 'you'` and not assigned to you                  |
| `comments` | `Comments`         | `unresolvedComments` is not empty — even while the fleet answers them |
| `assign`   | `Needs a reviewer` | `assignAsk` is set and not empty                                      |
| `describe` | `No description`   | `body` is read and empty after trimming                               |

The page's `prsOnYou` (`web/src/view/prsOnYou.ts`) holds only what is the page's own: the reason words
and which pull requests are drawn; the word's colour is `LEAD_TONE` in `web/src/console/PrCards.tsx`, drawn through the shared `cn-ink-*` classes the ask card's kind word uses too. The same
keys drop a sent pull request's strip once it is off the page, and are `pr_read`'s `onYou`.

They are drawn in **two boxes**, one above the other in the right-hand column, each scrolling in its
own half: **Assigned to you** — somebody asked the operator to review it (`viewerAssignment` or
`attention.assignedToYou`, `assignedToYou` in `web/src/view/prsOnYou.ts`) — and **Your pull
requests**, the operator's own and the fleet's. Reviewing someone else's work and moving your own
along are different jobs. An empty box shrinks to its heading and one line.

In each box they are **grouped by goal, a stack drawn as a block**, exactly as the overview's rack draws the
fleet's pull requests — the same `goalPrCards` builder
([17](17-cockpit.md#grouped-by-goal-stacks-as-a-tree)), so the two pages cannot disagree about which
goal a pull request is under or what it is stacked on. Goals go in number order, no goal last; inside
a goal, base first, then number order. Each is drawn as [the pull-request card](17-cockpit.md#the-pull-request-card)
— the same card the overview's rack draws — with the [Claude button](#the-claude-button) (icon only)
as its action and the sent strip below it. The card leads its second line with the **first** of its
reasons as a coloured word; the rest are already said by its marks or its sentence. The column's
heading counts the pull requests drawn, and links `All n open →` to the overview's rack.

## The Claude button

On every ask and every pull request row. What it does depends on the [listener](#is-a-chat-listening):

| Listener    | Label              | Press                                                                                                           |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `listening` | `Talk it through`  | `POST /api/listen/send` with the item                                                                           |
| `busy`      | `Talk it through`  | the same; the item queues behind the one the chat is on                                                         |
| `off`       | `Open in Claude ↗` | a new chat: `desktopDeepLink` with `/lubbdubb:next <id> only` for an ask, `/lubbdubb:pr <n>` for a pull request |

An item in `listener.sent` draws a strip under its card — **In your Claude chat**, with when it was
sent — until it no longer stands (the ask settled, the pull request off the page).

**The listen controls are shared with Work.** `ClaudeButton`, `ListenerStatus` and `SentLine` live in
`web/src/console/listenControls.tsx`, which is the one module that calls `listenSend`, and the
[Work tab](17-cockpit.md#the-work-tab) draws the same three: the pill in its head, the button on an open
row's asks and on its pull requests waiting on the operator, and the sent strip. Whether the chat holds
an item — `inChat`, working it or handed it — and whether it holds anything of a goal's (`goalInChat`)
sit beside `sameItem` in `src/listen/sameItem.ts`, so Work's `in Claude` marks and the listener read
one match.

## Is a chat listening

`ListenerView` (`src/types/listen.ts`) on the snapshot as `listener`, a [section](16-http-api.md#sections)
of its own:

- **`listening`** — an `ask_wait` call is open, or one returned less than `LISTEN_GRACE_MS` (60
  seconds) ago. The grace covers the gap between one bounded wait and the next.
- **`busy`** — the chat was handed an item and has not called `ask_wait` since. `on` names the item;
  `queued` counts what is waiting behind it.
- **`off`** — neither. A closed chat, a sleeping laptop and a restarted harness all land here.

The status draws on the heading row: a filled pill **Claude is listening**; **Claude is on #212 · 1
queued**; or a dashed **No Claude chat listening** with **Start listen loop ↗** — a deep link opening
a new chat with `/lubbdubb:listen` typed in — and **Copy**, which puts the same command on the
clipboard for a chat already open. The prompts are `listenPrompt`, `prPrompt` and `askOnlyPrompt` in
`web/src/cockpit/desktopLink.ts`, beside every other skill prompt.

The page's controls count under their own usage subject, `listen` ([34](34-usage-metrics.md)): the tab
is `listen.view` at place `needs`, **Talk it through** is `listen.send`, the two deep links are
`listen.open` and **Copy** is `listen.copy`.

## The wait

`src/listen/listener.ts` holds the state, in memory: the open waiter, the queue of sent items, the
item being worked and the sent list. Nothing is persisted — a restart drops the waiter, which the
skill answers by waiting again, and drops the queue, which the page shows as `off` until it does.

`ask_wait` is a desktop tool (`DESKTOP_TOOL_NAMES`, [11](11-mcp-tools.md#the-desktop-channel)). It
returns at once with the head of the queue if there is one; otherwise it holds until an item is sent
or `LISTEN_WAIT_MS` passes, and returns `{ item }` or `{ item: null }`. One waiter at a time: a new
call answers the older one with `{ item: null, superseded: true }`. Returning an item marks the chat
`busy` on it and records it in `sent`.

An item comes back with two more fields, so the skill never works out what to run:

- **`skill`** — the line its thread runs: `/lubbdubb:next <id> only` for an ask; for a pull request,
  `listen.prSkill` (empty is `/lubbdubb:pr`) followed by its number. That is how an operator's own
  skill for reading a pull request replaces the harness's.
- **`title`** — the thread's name: `Talk through ask <id>`; for a pull request `Review #<n>` or
  `Ready #<n>` when the harness [sent it by itself](#sending-by-itself), `Talk through #<n>` when the
  page did.

`POST /api/listen/send` (`{ item: ListenItem }`) appends to the queue and answers the open waiter if
there is one. Sending an item already queued or already on the chat is a no-op. A sent entry is
dropped when the ask no longer stands or the pull request is no longer on [the page](#pull-requests-waiting-on-you),
or after a day. Those are read off the snapshot as it is built, and only for what is in `sent`: nothing
at all when `sent` is empty, the standing rows of `asks` (the reply's own, or the queue built for the
`listener` section alone) for a sent ask, and `prOnYouReasons` over that one open pull request for a sent
one. So the pruning happens on read, and `sentAt` is when the operator pressed the button, not when the
chat took the item. Every broadcast that refreshes `asks` refreshes `listener` too, so a settled ask
leaves `sent` on the same refetch that takes it off the page. Sending an item again once the chat has
moved off it is not a duplicate: it queues, and its `sent` entry moves to the top.

The listener's changes — a wait opened or answered, a send, the grace running out — broadcast
`dirty` for `listener`, so the page's status follows without polling, and only when the view it would
answer has changed from the last one it announced: a newer wait replacing an open one, or a send that is
a no-op, is silent. The section is its own so that a wait opening every ten minutes rebuilds the
listener and nothing else, never the ask queue. Its clock and timers are a seam
(`ListenClock`); a test injects `FakeListenClock` as `listenClock`.

The grace timer reads the clock when it fires: a timer that fires early re-arms for what is left
rather than announcing a view that still reads `listening`.

`busy` has no timeout of its own: a chat closed while working an item inline reads `busy` until the
next `ask_wait` or a restart.

## Sending by itself

The operator opened a Claude chat for nearly every pull request that became ready, and for every one
they were asked to review, to run their own skill over it. With `listen.autoSendReviews` or
`listen.autoSendReady` on, the harness does the pressing: `AutoSend` (`src/listen/autoSend.ts`),
wired by `wireAutoSend` (`src/system/systemListen.ts`), reads the open pull requests (`openPrs`) at the end of every cycle that ran and sends each new one to the
listener as `{ kind: 'pr', number, why }` — the same queue the page's button feeds, so it lands as a
linked session under the listen chat, which is the grouping the operator wanted. The desktop app
offers no way to put a session into a sidebar Section, so nesting under the one listen chat is the
grouping there is.

`autoSendWhy` answers one reason or none, built on the page's own table so the two cannot disagree about what is on the operator — and only for a pull request whose **every CI check passed**
(`ciStatus` passing, nothing withheld, every check `passing` — an advisory failure holds it too, since
the operator asked for nothing failing at all):

| `why`    | Holds when                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review` | [`prOnYouReasons`](#pull-requests-waiting-on-you) holds `review` — somebody asked the operator, and attention puts it on them (not once they have approved it) |
| `ready`  | it holds `call` or `assign`; or the operator opened it (`viewerAuthored`) and no agent is on it (`attention.status` is neither `harness` nor `done`)           |

A pass only counts once a whole world has been read: with no baseline yet, or one with `staleSources`, `wireAutoSend` hands it no read and the pass learns, sends and forgets nothing — so a first cycle on an empty read never primes on nothing, and a partial read never drops a pull request it would then send again.

Each key gates its own reason. A pull request is sent **once per reason** while it is open: going red
and green again does not send it twice, and a key is forgotten only when the pull request is no longer
open. The memory is in-process, so the **first pass after sending is turned on** — a boot, or the
keys switched on — only learns what already qualifies and sends none of it: a restart never sends the
same pull request again, and switching it on never sends a burst of every ready pull request at once.
The cost is that one which became ready while the harness was down is not sent; it is still on this
page with its button. While both keys are off nothing is read at all.

The listener queues an item whether or not a chat is listening, so what is sent while no chat
listens waits for the next `ask_wait`. A pull request the page already sent, queued or on the chat is
not sent again ([the wait](#the-wait)).

Both keys and `listen.prSkill` are restart-only ([02](02-configuration.md#liveness)).

## The listen skill

`/lubbdubb:listen` (`plugin/skills/listen/SKILL.md`). The chat loops on `ask_wait`:

1. Call `ask_wait`. `{ item: null }` → call it again, saying nothing; say "still waiting" at most
   once per session. An error (the harness restarted) → call it again. `superseded: true` → another
   wait took over, so this loop stops and says so in one line.
2. An item → hand it to a thread of its own, in this order of preference. Each runs one skill for the
   one item and nothing else — the `skill` line `ask_wait` returned — told to talk it through with the operator, decide nothing, and end with one
   line: what landed, or "left open".
   - **A linked session**, where the Claude desktop app offers `start_session`
     (`mcp__ccd_session__start_session`): a Claude Code session nested under the listen session in
     the sidebar, which the operator opens and talks to. It is started fresh, in this checkout (no
     worktree), titled with the `title` `ask_wait` returned, with a background note that the
     item came from this page — or from the harness sending it by itself — through the listen loop and that the session holds the conversation for
     that one item. A fork in the desktop app runs as a background task the operator cannot open,
     which defeats "Talk it through" — so the linked session comes first.
   - **A fork**, where the `Agent` tool can start one, exactly as the `next` skill's side thread does
     ([11](11-mcp-tools.md#the-next-ask-loop)).

   Then go back to step 1 at once — the thread holds the conversation, the main chat keeps only its
   one-line outcome (repeated in one line when it arrives), so its context stays small. A linked
   session reported blocked or waiting on the operator is said in one line with a link to it.

3. Where neither can be started, work the item inline, then go back to step 1. While it does, the
   page reads `busy`.

The loop decides nothing at any of the three: the item is a conversation the operator asked for, and
the thread it lands in — session, fork or this chat — only acts on the operator's word.

The operator can press Esc to stop the wait and talk to the chat; `/lubbdubb:listen` starts it again.

## The pull request skill

`/lubbdubb:pr <n>` (`plugin/skills/pr/SKILL.md`), and the desktop tool it reads with, `pr_read`: the
harness's record of one open pull request — `world_read`'s view of it (`prView` in
`src/mcp/worldRead.ts`), with the body, `ciVerdict`, review threads with their replies, `attention` with
its reasons, `onYou` (the [keys](#pull-requests-waiting-on-you)), `assignAsk`, and the goal it delivers —
the goal `goalOfPr` names, as every ask line reads it, with its issue and plan part. It reads its inputs
off `prInputs` (`src/server/askReads.ts`): the open pull requests and the plans, with no ask queue
built. A number that is not open is refused with what the harness does hold, as `world_read` refuses. The skill puts
the pull request in front of the operator, reads the diff in the checkout or through a subagent where
the conversation turns on it, and acts only on the operator's word through the tools that already
exist (`pr_assign`, `description_read`, `description_check`).

## Scope

The listen loop is new and not yet trusted, so it is wired to this page and nothing else — and to
[sending by itself](#sending-by-itself), which the operator turns on. The goal
page, the rail, Focus mode and the feature board keep their own deep links and never call
`POST /api/listen/send`. Widening it is a change to this spec first.
