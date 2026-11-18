---
name: listen
description: Wait for what the operator sends from the cockpit's Needs you page — an ask or a pull request — and start a side thread for each, so it can be talked through here. Use for "/lubbdubb:listen", "listen for the cockpit", "wait for what I send you".
argument-hint: ''
---

## Listen for the Needs you page

The operator works from the cockpit's **Needs you** page. When they press
**Talk it through** on an ask or a pull request, it is sent to this chat. You
wait for it, hand it to a side thread, and wait again. You decide nothing: each
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
2. **An item → a fork.** `Agent` with `subagent_type: "fork"`, a short
   `description` naming it ("Talk through #212", "Ask 3f9c…"), and a prompt
   that runs the skill for it and nothing else:
   - an **ask** (`item.kind: "ask"`) — `/lubbdubb:next <item.id> only`;
   - a **pull request** (`item.kind: "pr"`) — `/lubbdubb:pr <item.number>`.

   Say the prompt ends with one line back — what landed, or "left open". Then
   tell the operator in one line where it is: in the panel under the prompt,
   select its row and press `Enter` to talk to it, `Esc` to come back.

3. **Straight back to step 1.** Do not wait for the fork. The fork holds the
   conversation; this chat keeps only the fork's one-line outcome, so its context
   stays small across a whole day of items. When that line arrives, repeat it in
   one line and carry on waiting.

**Where you cannot fork** — no `Agent` tool, or forks turned off — work the item
here, as that skill says (`next <id> only` for an ask, `pr <n>` for a pull
request). When it is answered or left, go back to step 1. While you work it, the
page shows the chat as busy, and anything else sent queues behind it.

### What the operator can do

- **Esc** stops the wait, so they can talk to this chat. `/lubbdubb:listen`
  starts it again.
- **"stop"** — stop the loop. Say so in one line.

### What not to do

- **Do not decide.** Not in the loop, and not in the fork's prompt: an item sent
  here is a conversation the operator asked for, not an instruction to act.
- **Do not work an item in the main chat when you can fork it.** Every item
  worked inline is context the rest of the day's items have to carry.
- **Do not poll anything else between waits.** `ask_wait` is the only thing
  this loop calls.
