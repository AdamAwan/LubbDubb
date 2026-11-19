---
name: listen
description: Wait for what the operator sends from the cockpit's Needs you page — an ask or a pull request — and start a linked session (or fork) for each, so it can be talked through. Use for "/lubbdubb:listen", "listen for the cockpit", "wait for what I send you".
argument-hint: ''
---

## Listen for the Needs you page

The operator works from the cockpit's **Needs you** page. When they press
**Talk it through** on an ask or a pull request, it is sent to this chat. You
wait for it, hand it to a thread of its own, and wait again. You decide nothing: each
item is worked the way the `next` and `pr` skills say, and the operator answers.

### The loop

1. **`ask_wait`.** It returns at once when something is waiting; otherwise it
   holds for up to ten minutes.
   - **`{ item: null }`** — nothing was sent. Call `ask_wait` again, **saying
     nothing**. The first time only, you may say one line — "Still waiting for
     the Needs you page." — and never again in this session. A loop that narrates
     every empty wait buries the conversation it exists to start.
   - **`superseded: true`** — another `ask_wait` took over, from this chat or
     another. Stop the loop and say so in one line.
   - **An error** — usually the harness restarted. Call `ask_wait` again. Only
     if it keeps failing, say what it said and stop.
2. **An item → a thread of its own.** The thread runs one skill for the item and
   nothing else:
   - an **ask** (`item.kind: "ask"`) — `/lubbdubb:next <item.id> only`;
   - a **pull request** (`item.kind: "pr"`) — `/lubbdubb:pr <item.number>`.

   Use the first of these you can:

   **a. A linked session** — when `mcp__ccd_session__start_session` is available
   (if it is deferred, load it with `ToolSearch` `"select:mcp__ccd_session__start_session"`).
   First write a bold title line and one sentence saying what you are starting.
   Then call it with:
   - `initiation: "user_asked"`, `context: "fresh"`, `use_worktree: false`;
   - `title`: "Talk through ask <item.id>" or "Talk through #<item.number>";
   - `prompt`: the skill line above, then "Talk it through with the operator;
     do not decide. End with one line: what landed, or 'left open'.";
   - `background`: this item came from the cockpit's Needs you page through the
     listen loop; this session holds the conversation for that one item.

   Then tell the operator in one line that the session sits under this one in
   the sidebar.

   **b. A fork** — otherwise, where `Agent` can fork. `subagent_type: "fork"`, a
   short `description` naming it ("Talk through #212", "Ask 3f9c…"), and the
   skill line as the prompt. Say the prompt ends with one line back — what
   landed, or "left open". Then tell the operator in one line where it is: in
   the panel under the prompt, select its row and press `Enter` to talk to it,
   `Esc` to come back.

3. **Straight back to step 1.** Do not wait for the session or fork. It holds the
   conversation; this chat keeps only its one-line outcome, so its context stays
   small across a whole day of items. When that line arrives — a fork's result, a
   `<side-sessions-event>` or a linked-session note — repeat it in one line and
   carry on waiting. If a linked session is blocked or waiting on the operator,
   say so in one line with a link to it: `[title](#local_<id>)`.

**Where you cannot start either** — no `start_session`, and no `Agent` tool or
forks turned off — work the item here, as that skill says (`next <id> only` for an
ask, `pr <n>` for a pull request). When it is answered or left, go back to step 1.
While you work it, the page shows the chat as busy, and anything else sent queues
behind it.

### What the operator can do

- **Esc** stops the wait, so they can talk to this chat. `/lubbdubb:listen`
  starts it again.
- **"stop"** — stop the loop. Say so in one line.

### What not to do

- **Do not decide.** Not in the loop, and not in the session's or fork's prompt: an item sent
  here is a conversation the operator asked for, not an instruction to act.
- **Do not work an item in the main chat when you can start a session or fork for it.** Every item
  worked inline is context the rest of the day's items have to carry.
- **Do not poll anything else between waits.** `ask_wait` is the only thing
  this loop calls.
