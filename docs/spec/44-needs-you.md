# 44 — The Needs you page

**Built.** The page — the `needs` tab, its two columns, the Claude button and the listener status —
and the server side under it: the listener (`src/listen/listener.ts`), the desktop tools `ask_wait`
and `pr_read`, `POST /api/listen/send`, the snapshot's `listener`, and the `listen` and `pr` skills.

The overview answers _what is the fleet doing_. That stopped being the operator's question: what
matters is **what is waiting on me** — the orchestrator's asks and the pull requests that need a
person. And most of the time the operator does not want to answer an ask with a button; they want to
**talk it through with Claude**, in the Claude desktop app, where the conversation can flow.

So this is a new cockpit tab, **Needs you**, beside the overview rather than replacing it. The
overview stays where it is, untouched, until this page has proved itself. The listen loop below is
part of this page **only**: no other surface sends anything to it.

## Invariants

- **The old overview and the rail are unchanged.** This page is a new tab; nothing about Cards, Focus mode or the queue rail moves. → [§](#where-it-sits) · _no test_
- **Only this page sends to the listening chat.** `POST /api/listen/send` has one caller, `web/src/console/NeedsYouPage.tsx`; every other surface keeps its own buttons and its own deep links. → [§](#scope) · `test/needsYouPage.test.ts`
- **Which pull requests are on the page is `prOnYouReasons`, one pure function the server and the page share.** A pull request is on the page when any one of its reasons holds, and a reason is read off fields the server already decided — never re-derived in the browser. The page, the pruning of `sent` and `pr_read`'s `onYou` all read its keys. → [§](#pull-requests-waiting-on-you) · `test/prsOnYou.test.ts`
- **The page reads `listener.state`; it never guesses.** `listening`, `busy` and `off` are the server's, off whether a wait is open. → [§](#is-a-chat-listening) · `test/needsYouPage.test.ts`
- **A wait is bounded.** `ask_wait` returns by itself after `LISTEN_WAIT_MS` (10 minutes) with nothing, and the skill calls it again; a held call never outlives that bound. → [§](#the-wait) · `test/listener.test.ts`
- **The listener tells the cockpit only when what it shows has changed**, and that is its own `listener` section — never a rebuild of the ask queue. → [§](#the-wait) · `test/listener.test.ts`
- **An item is handed out once.** A sent item leaves the queue the moment one `ask_wait` returns it; a second waiter never receives it too. → [§](#the-wait) · `test/listener.test.ts`
- **The listen loop decides nothing.** `/lubbdubb:listen` hands each item to the same reading the `next` skill does; the operator answers. → [§](#the-listen-skill) · _no test_

## Where it sits

A `ConsoleTab`, `needs`, reached at `?tab=needs` and drawn by `web/src/console/NeedsYouPage.tsx`. The
top bar names it **Needs you** with a `new` tag. It is not the default home: the overview stays the
first tab until the operator decides otherwise.

Whether the page is in front — its tab, with no goal or pull request opened over it — is one
function, `needsYouInFront` (`web/src/view/needsYouPage.ts`), which the shell reads.
On this tab the shell draws no queue rail — the page _is_ the queue, at full width, and the rail
beside it would be the same list twice. Everywhere else the rail is where it has always been.

The page is, top to bottom:

1. **The heading row**: `Needs you`, the counts (`7 asks · 6 pull requests`), and on the right the
   [listener status](#is-a-chat-listening).
2. **[The fleet strip](#the-fleet-strip)** — one thin line.
3. **Two columns** — the asks, then the pull requests — side by side at 1100px and wider, stacked
   below that.

The top bar is the same here as on every other tab — the fleet control, cap and scan countdown stay
where they are, because this page is where an operator answers, and answering often means pausing or
widening the fleet.

### The fleet strip

The agents are visible here without being the subject: one bordered line under the heading, quieter
than the cards. It names each live agent — its status lamp (the fleet's own, from `agentLamp`),
its task title and how long it has been out — up to six, then `+N`; agents with an open ask come first, then waiting or limit-parked ones, so the six shown are the ones most likely to matter here. A toggle beside them (`+N ▾`, or `▾` when all fit) opens the strip into a list of every agent out — lamp, title, its latest note or state, and time out — each row opening that agent; `less ▴` folds it back. The toggle is local to the page and not kept in the address. Pressing one opens that agent's
drawer. On the right, `out of cap · queued`, and `Overview ›` to the full fleet. With none out it
says `no agents out`. Covered by `test/needsYouPage.test.ts`. Goals in flight are not on this page.

## From the orchestrator

The ask queue (`asks` on the snapshot, [17](17-cockpit.md#the-queue-rail--needs-you)) drawn at full
width, in the rail's order and under the rail's tier headings — **Answer now**, **Yours to do**, and
the **holding nothing** fold. Each row is the rail's row with room for its reason on the card rather
than in a tooltip, and carries two controls: its kind's verb (`KIND_VERB`, which opens the ask where it
is answered, as the rail's row does) and the [Claude button](#the-claude-button).

The foot of the column is the **Handled for you** line, exactly as on the rail
([43](43-handled-for-you.md#on-the-rail)).

An ask about a pull request is drawn here **and** on that pull request's row: the two columns answer
different questions, and the operator asked for both.

## Pull requests waiting on you

`prOnYouReasons` (`src/listen/prsOnYou.ts`) is the table, once: it answers a pull request's reasons as
keys, in this order, and is re-exported as a runtime value from `src/wire.ts` so the page calls the same
function the server does. A pull request is drawn when any of these hold, and each that holds is a tag
on its row:

| Key        | Tag                | Read off                                                              |
| ---------- | ------------------ | --------------------------------------------------------------------- |
| `review`   | `Your review`      | `attention.assignedToYou` is set                                      |
| `call`     | `Your call`        | `attention.status === 'you'` and not assigned to you                  |
| `comments` | `Comments`         | `unresolvedComments` is not empty — even while the fleet answers them |
| `assign`   | `Needs a reviewer` | `assignAsk` is set and not empty                                      |
| `describe` | `No description`   | `body` is read and empty after trimming                               |

The page's `prsOnYou` (`web/src/view/prsOnYou.ts`) holds only what is the page's own: the tag words
and tones. The same keys drop a sent pull request's strip once it is off the page, and
are `pr_read`'s `onYou`.

They are **grouped by goal, a stack drawn as a tree**, exactly as the overview's rack draws the
fleet's pull requests — the same `goalPrRows` builder
([17](17-cockpit.md#grouped-by-goal-stacks-as-a-tree)), so the two pages cannot disagree about which
goal a pull request is under or what it is stacked on. Goals go in number order, no goal last; inside
a goal, base first, then number order. The row is `prRow` (`web/src/console/prRow.tsx`) with the tags
as its chips, the [Claude button](#the-claude-button) as its action, and the sent strip as its
`below`. The card's header counts the drawn rows against every open one, and its foot links to
the full list — the overview's pull request card, which draws every open one.

## The Claude button

On every ask and every pull request row. What it does depends on the [listener](#is-a-chat-listening):

| Listener    | Label              | Press                                                                                                           |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `listening` | `Talk it through`  | `POST /api/listen/send` with the item                                                                           |
| `busy`      | `Talk it through`  | the same; the item queues behind the one the chat is on                                                         |
| `off`       | `Open in Claude ↗` | a new chat: `desktopDeepLink` with `/lubbdubb:next <id> only` for an ask, `/lubbdubb:pr <n>` for a pull request |

An item in `listener.sent` draws a strip under its card — **In your Claude chat**, with when it was
sent — until it no longer stands (the ask settled, the pull request off the page).

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

## The listen skill

`/lubbdubb:listen` (`plugin/skills/listen/SKILL.md`). The chat loops on `ask_wait`:

1. Call `ask_wait`. `{ item: null }` → call it again, saying nothing; say "still waiting" at most
   once per session. An error (the harness restarted) → call it again. `superseded: true` → another
   wait took over, so this loop stops and says so in one line.
2. An item → hand it to a thread of its own, in this order of preference. Each runs one skill for the
   one item and nothing else — an ask as `/lubbdubb:next <id> only`, a pull request as
   `/lubbdubb:pr <n>` — told to talk it through with the operator, decide nothing, and end with one
   line: what landed, or "left open".
   - **A linked session**, where the Claude desktop app offers `start_session`
     (`mcp__ccd_session__start_session`): a Claude Code session nested under the listen session in
     the sidebar, which the operator opens and talks to. It is started fresh, in this checkout (no
     worktree), titled "Talk through ask <id>" or "Talk through #<n>", with a background note that the
     item came from this page through the listen loop and that the session holds the conversation for
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

The listen loop is new and not yet trusted, so it is wired to this page and nothing else. The goal
page, the rail, Focus mode and the feature board keep their own deep links and never call
`POST /api/listen/send`. Widening it is a change to this spec first.
