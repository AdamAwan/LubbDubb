---
name: ask
description: Answer a question about a goal LubbDubb has worked or is working — what was done, how, which pull requests, what is left, whether it has reached an environment. Use when asked anything about a goal by number — "/lubbdubb:ask 284", "what happened on 284?", "did we ever ship the export fix?", "is 284 on hallway?".
argument-hint: '<goal> [question]'
---

## Answer a question about a goal

The operator wants to know something about work the harness has done or is doing.
Not to change it — to understand it. `ask 284` on its own means "where is this
up to"; `ask 284 <question>` is that question.

**`goal_read` is the answer, and it is one call.** It comes back with the
harness's own record of the run: the ticket's text, the plan and its parts, every
pull request and what became of each, what the dispatcher decided and when, what
was escalated to a person, what agents concluded, what it cost, the validation
checks and their readings, which environments the work has reached, the
retrospective if one was written, and the notes agents left each other.

1. **Read the record.** `goal_read` with the goal number.
2. **Answer the question that was asked.** Not the whole record — they asked one
   thing. Quote the specifics: the part slug, the pull request number, the date,
   the agent's own words. A number they can go and check is worth a paragraph of
   summary.
3. **Open the repository when the question is about the code.** "What did we
   actually change" is answered by reading the diff on the pull requests the
   record names, not by paraphrasing a part's title. The record tells you where
   to look; it is not itself a reading of the code.

### Where the record does not say

This is the part that matters, because the failure here is quiet. You will
usually be able to construct a plausible account of a goal from the repository
alone — and the operator cannot tell that apart from the real one.

- **Say when the record is silent.** A decision nobody wrote down, a pull request
  the snapshot has aged out, a part with no outcome recorded. "The harness did not
  record why" is a real answer and a useful one.
- **`unknown` on an environment is not `absent`.** It means the harness could
  not get an answer — an expired credential, a probe that would not run, a commit
  this clone never fetched. Reporting it as "not deployed" tells them the work has
  not shipped for a reason that has nothing to do with shipping.
- **A count is a count of what merged, out of the goal's whole work.** `2/4 on
hallway` means half the feature is there, which is usually the more interesting
  fact than either "yes" or "no".

### What not to do

- **Change nothing.** This is a read. Do not amend the plan, do not claim a
  check, do not report a reading, do not open a branch. If the answer to their
  question turns out to be "the plan is wrong", say so and offer
  `/lubbdubb:plan 284` — that is a different job and they get to choose
  to start it.
- **Do not re-run the work to find out.** If the question is "does it work", the
  honest answer is what the validation checks say, plus an offer to
  run one with `/lubbdubb:check`.
- **Do not defend the fleet.** If the record shows three agents went round in
  circles on a part, that is the answer. An account that smooths it over is worth
  nothing to somebody deciding what to change about how this goal is being worked.
