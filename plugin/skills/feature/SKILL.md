---
name: feature
description: Talk through a Feature and the stories under it — how it is going, what is left, what is in flight. Use for "/lubbdubb:feature 500", "how is the export feature going?".
argument-hint: '<feature> [question]'
---

## Talk about a feature

The operator wants to talk about a **Feature** — the container a set of stories
hangs off — rather than one goal: how it is going, what is left, whether the split
into stories is right, what to do next. `feature 500` on its own means "where is
this up to"; `feature 500 <anything>` is that conversation.

1. **Read it.** `feature_read` with the Feature number, or any story under it.
   It comes back with the ticket, the summariser's own account of how it is going,
   the order the stories are worked in, and every story with its state, its plan,
   and whether the goal check is holding it.
2. **Go into a story only where the conversation does.** `goal_read` on that
   story. Reading all of them up front answers a question nobody asked.
3. **Talk.** Answer what was asked, with the story numbers. Where the question is
   about the code, read the repository. Where the record is silent, say so.
4. **Change things only through the job that owns them, and only on a yes.** The
   order is `/lubbdubb:order 500`; a missing story is
   filing a ticket with `/lubbdubb:file`; one story's plan is
   `/lubbdubb:plan`. Say which one you are moving to before you do.

- **`summary: null` means nobody summarised it.** Do not write your own account
  and present it as the harness's.
- **A Feature is never worked directly.** The fleet works its stories; a Feature
  with nothing moving is a question about its stories, not about the Feature.
- **Do not do the work.** Nothing here opens a branch or writes code.
