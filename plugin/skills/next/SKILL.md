---
name: next
description: Work through what LubbDubb is waiting on the operator for, one ask at a time — the same order the cockpit's Focus mode walks "Needs you". Use for "/lubbdubb:next", "/lubbdubb:next <ask id>", "what's next?", "what does LubbDubb need from me?", "let's clear my asks".
argument-hint: '[ask id]'
---

## Work through "Needs you", one ask at a time

The operator wants to clear what the harness is waiting on them for, here rather
than in the cockpit. You put each ask in front of them, help them decide, and send
**their** answer. They decide. You never do.

### The loop

1. **`ask_next`.** It hands back the ask in front — the head of the same queue the
   cockpit's Focus mode walks — with `position` and `total`, and `answerWith`: the
   tool and the arguments that answer it, ids already filled in. If it says the
   queue is empty, say so plainly and stop. **Started with an ask id** (the
   operator picked one from the panel), the first call is `ask_next` with that
   `id`; if it is refused as no longer standing, say so and carry on from the
   head. Every later call is plain `ask_next`.
2. **Put it to them as a card — the one Focus mode draws.** `card` is that card as
   data: the kind's `label`, `symbol` and `tone`, the `queue` pips, and the `goal` with
   its plan. Draw it from `card` and `ask`; do not work out a kind's word or a part's
   state yourself.

   **Where you can render a widget** (a `show_widget` tool, read its guide once per
   session first), draw it as one, laid out the way Focus mode lays it out:

   - **Top row:** a pip per `card.queue` entry in its `tone`, the `here` one marked;
     `position of total`; and, where `ask.urgency` is `now`, "fleet is stuck on this".
   - **Left: "The goal this is about".** `goal.title` and its ref; "Its plan — m of n
     merged", then each part as a numbered row with its `state`, and **"this ask"** on
     the `here` one, outlined in the kind's tone. `plan.withheld` → "plan not revealed
     yet", and no parts. `goal: null` → "The fleet itself, rather than any one goal."
     `goal.otherAsks` → "n other asks on this goal".
   - **Right: "Your move".** The `symbol` and the title; then `label` · goal ref ·
     when it was raised; "holding n parts" where `holding` is above zero; the `note`;
     the `question` in full where one came back.
   - **Footer:** "`after` after this · `heldInTotal` parts held in total", or "last ask"
     where `after` is 0.
   - The tone colours the kind and the marked part, nothing else. **No buttons, no
     links that send anything**: the widget is something to read, and the answer is
     asked for in the chat (step 5), where a pick is unmistakably the operator's.
     Do not repeat the card as text under it.

   **Without a widget tool**, send it as markdown, one line each, not in a code block:

   ```
   2/7 · proposal · fleet is stuck on this
   **Merge #412?**
   Goal 88's fix, blocking 3 parts.
   ```

   - **Header** — where it is, its kind (`card.kind.label`), and its urgency said
     plainly: `now` is "fleet is stuck on this"; `next` needs nothing.
   - **Title** in bold, then the `question` in full where one came back.
   - **One line of facts** — who is waiting (the agent, goal or pull request) and
     what it holds up ("blocking 3 parts"). Leave out what is empty, rather than
     "nobody" and "nothing".

3. **Read more only where it helps them decide.** `answerWith.readFirst` names the
   read that matters for this kind — `proposal_read` before any proposal,
   `pr_assign` with just `pr` for the shortlist, `validation_read` for checks. Beyond
   that, `goal_read`, `agent_read` and the real diff or code in this checkout are
   there when the decision turns on them. Do not read everything for every ask; an
   operator clearing ten asks does not want ten essays.
4. **Then, if you have one, your view — one quoted line, labelled as yours.**
   After the facts, never mixed into them:

   > **Claude's view (not LubbDubb's):** Accept the merge — CI is green and the
   > one review thread is answered. (high)

   One sentence of why, then how sure you are. It is your opinion, from what you
   just read. It is **never** phrased as what LubbDubb wants, expects or
   recommends — the harness asked a question; it did not suggest an answer, and a
   sentence that makes it sound as though it did is the operator deciding on a
   false premise. If you have no real basis for a view, leave the line out rather
   than invent one.

5. **Ask for their answer — as choices where you can.** Where the
   `AskUserQuestion` tool is available, offer the answers `answerWith.choose`
   allows as options, plus **Skip**, each with a short description of what it does
   ("Merges #412", "Leaves it for later"). Mark your pick **"(Claude's pick)"** —
   never "(Recommended)", which reads as the harness's. Where your view carries
   words (a decline reason), the option may carry them too — "Decline: idle is fine
   for now" — so picking it adopts them, explicitly. Without the tool, end with one
   line naming the same choices.

   An answer that is the operator's own words — a description, a reply to an
   agent — is typed, never an option: an option's label would be a draft of it.

   Then wait. Do not answer for them. Silence is not a yes, "ok" to something else
   is not a yes, and moving on to talk about another ask is not a yes. Your view
   is sent only when they explicitly pick or accept it.

6. **Send it with `answerWith`.** Call `answerWith.tool` with `answerWith.args`
   plus the fields from `choose` their answer fills. Use their words where the
   field carries words. Then say in one line what landed.
   - **A rejection or a decline carries a reason.** If they said no without one,
     ask for it — it goes in `note` (or `reason`, or `summary`), and it is what the
     next planner or agent reads.
   - **A refusal saying it is already settled** means somebody answered it in the
     cockpit while you were talking. Say so and move on — it is not an error to
     fix.
   - Any other refusal: say what it said, plainly, and ask what they want to do.
7. **Back to step 1.**

What they can say at any point:

- **"skip"**, **"later"**, **"not now"** — `ask_skip` with the ask's `id`, then
  `ask_next`. A skip lasts for this session only: nothing is written, the cockpit
  still shows it, and the next session starts with it back in its place.
  `ask_skip` with `undo: true` brings one back.
- **"stop"**, **"that's enough"** — stop. Say how many are left.

### When the answer is not a tool here

- **`answerWith.in: "cockpit"`** — this kind is answered in the cockpit, on
  purpose: a failing setup check or another deployment setting, upgrades, the operator's own prediction, a
  usage-limit park, a plan not yet revealed. Say
  what it is and why (`why`), give them the `link`, and offer to skip it.
- **`answerWith.in: "nowhere"`** — there is no decision to make: a pull request
  somebody put on them, or a dispatch refused for the reason the row names. Say what
  it is and what would make it go away, and offer to skip it.

### Kinds that need more care

- **A proposal is an act.** `accept` on a `merge` merges; on a `reply` it posts
  publicly. Ask "shall I merge #412?", never "shall I approve this?". A plan's
  caveats go to the operator in their own words before their ids go in
  `acknowledged`. → the `fleet` skill's _Deciding a proposed act_.
- **Secrets never go through this chat.** An ask that wants a credential, a token,
  a login or a key — a `supply` row, a bench task to provision something — is done
  by the operator themselves, wherever it belongs. Tell them what to do; when they
  say it is done, settle the row with `human_task_settle`. Never ask them to paste
  a secret here.
- **A `validate` ask is checks somebody has to run.** Offer to run them:
  `validation_read`, then `validation_claim` one, carry the procedure out for real,
  and **show the operator what you saw before** calling `validation_report` — they
  confirm the reading, you do not grade your own run. The `check` skill is the whole
  of how. Settle the row with `human_task_settle` once the checks are read.
- **A `describe` ask carries the operator's words, and only theirs.** Ask them
  what the change does, with the four questions in `answerWith.choose` as hints,
  and pass what they type to `description_write` verbatim. It goes on the pull
  request marked as written by a person, so **never draft, suggest, tidy or
  finish one** — not even when asked, and not as "something like…" for them to
  agree to. If they want it written for them, that is the agent's draft, taken on
  the pull request's page where it is labelled as the agent's.
- **A `bench` or `close_out` row is work, not a question.** `done` only once the
  thing has actually been done — ask, do not assume.
- **An agent's question is typed straight into a running agent**, and it acts on
  it. If the operator is unsure, leave it open and skip it rather than send a
  guess.

### What not to do

- **Do not decide.** Not the easy ones, not the ones where your view is
  obviously right, not to save them a keystroke.
- **Do not blur your view into the facts.** The card says what the harness
  holds; the quoted line says what you think. Two blocks, every time — and your
  view is never drawn inside the widget, which shows only what `card` carries.
- **Do not work around a cockpit-only ask** with a tool that happens to take the
  call. Each one is cockpit-only for a stated reason.
