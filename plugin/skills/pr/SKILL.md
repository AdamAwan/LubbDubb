---
name: pr
description: Talk one open pull request through with the operator — what it is, why it is on them, its CI and review threads, the goal it delivers — and act only on their word. Use for "/lubbdubb:pr 212", "let's look at #212", "what's going on with PR 212?".
argument-hint: '<pull request number>'
---

## Talk one pull request through

The operator wants to look at one pull request with you — usually because the
cockpit's **Needs you** page says it is on them. You put it in front of them,
help them think about it, and act only when they say so. They decide. You never
do.

### The steps

1. **`pr_read` with the number.** It is the harness's record of the pull
   request: title, body, branch, url, CI checks and the CI verdict, the review
   threads with their replies, the unresolved comments, `attention` with its
   reasons, `onYou` — why it is on the operator — `assignAsk`, and the goal it
   delivers. A refusal saying it is not open means it was merged or closed: say
   so and stop.
2. **Put it in front of them**, briefly:
   - **The title as a link** to `url`, then the branch and, where `goal` is set,
     the goal it delivers as a link (`goal.url`) with the part it is.
   - **Why it is on them** — `onYou`, one line each, with the fact behind it:
     `review` (assigned to them — say who), `call` (it waits on their decision),
     `comments` (the comment still unresolved), `assign` (it needs a reviewer —
     the people `assignAsk` offers), `describe` (the body is empty).
   - **CI** — the verdict in a line: green, or the checks failing and whether
     the fleet is on them (`attention.reasons`).
   - **Review threads still open** — one line each: who, where (`path`,
     `line`), what they asked, and the last reply.

   Leave out what is empty, rather than "no comments" and "nothing failing". A
   `url` that is null is drawn as plain text: never build an address yourself.

3. **Read the diff only where the talk turns on it.** In this checkout
   (`git diff <baseBranch>...<branch>` once the branch is fetched) or, where the
   `Agent` tool is available and the read is heavy, through a subagent asked for
   a few lines back — the facts the question turns on, quoted where it matters.
   Its file dumps stay in its context, not this one. It reads; it never answers.
4. **Form your view, if you have one** — one sentence of why, and how sure you
   are, labelled as yours: **"Claude's view — not from LubbDubb"**. The harness
   put the pull request in front of them; it did not suggest what to do about it.
5. **Act only on their word**, through the tools that already exist:
   - **Who should look at it** — `pr_assign` with `pr` alone reads the
     shortlist; with `person` it assigns; `decline: true` answers "nobody".
   - **The description** — `description_read` to see it and any findings, and
     `description_check` to report a check you ran. A description the operator
     writes is theirs, verbatim — the `describe` skill is how; never draft one.

   Anything else — merging, replying to a reviewer, pushing a change — is not
   done from here. Say where it is done (the pull request's page, or the cockpit)
   and leave it to them.

6. **End with one line**: what landed, or "left open". If this chat is a fork
   started by `/lubbdubb:listen`, that line is what goes back to it.

### What not to do

- **Do not decide.** Not an assignment, not a description, not to save them a
  keystroke. Silence is not a yes.
- **Do not blur your view into the facts.** What `pr_read` says and what you
  think are two blocks, every time.
- **Do not reply on the pull request** or resolve a thread for them. Those are
  public, and they are the operator's.
