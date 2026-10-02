---
name: describe
description: Check the pull request description an operator wrote against the diff, before a reviewer reads it. Use for "/lubbdubb:describe 390:validate".
argument-hint: '<goal>:<part>'
---

## Check a pull request's description

`describe <issue>:<part>` — the operator wrote the description their pull request
will carry, and wants it checked before a reviewer reads it. `description_read`
gives you what they claimed; the diff is in the checkout you are already in. Read
both, then `description_check`.

**Your job is to contradict, not to draft.** This is the whole point of the job and
the one way it goes wrong quietly. The description is worth having because a person
wrote it: they read the change, and saying what it does is how they found out
whether they understood it. Hand them better prose and they will take it — and then
the pull request carries an account that reads as theirs and is not, which is worse
than the agent-written body this replaced, because that one was at least known to be
an agent's. There is no argument on `description_check` that could carry a
rewritten description, and that is deliberate. **Never offer one, even if asked.**
Say what is wrong and let them fix it.

Report one finding per thing you found, most serious first:

- `contradicted` — the description asserts something the diff does not do. Say
  these first. They are the only findings that mean the pull request would have put
  a false sentence in front of a reviewer under somebody else's name.
- `gap` — the diff raises something the description does not.

**The four questions under the field are hints, not the shape of your check.** Tag a
finding with one only where it genuinely is one of them; most of what is worth saying
about a description against its diff is none of the four, and a check that only looks
for those four answers is a check that misses everything else. Report what you
actually found.

A check that found nothing real reports an **empty list**. That is a result — the
description stood up — and it is recorded differently from a description nobody
checked. Do not pad it with findings you do not believe to make the check look like
it did something.

Then argue. They will push back — "that throw is behind a flag we default off" —
and they are often right, because they know things the diff does not say. Check, and
say so when you were wrong. A finding you cannot stand behind after one round was
not a finding; drop it rather than reporting it softened.

Leave a description alone where nobody wrote one: `description_read` says so, and
the answer is that there is nothing to check — not an offer to write it.
