---
name: check
description: Run a LubbDubb validation check on this machine and report the reading back. Use for "/lubbdubb:check 284:C", "/lubbdubb:check 284", "validate the login fix".
argument-hint: '<goal>[:<check>]'
---

## Run a validation check

A validation check is a procedure somebody has to actually carry out before a
goal can be called done — open the page, click the thing, look at what happened.
It exists precisely because the build was green and the pull request merged and
neither of those is the same as the goal working.

This machine can reach environments the harness's own fleet cannot. That is why
the check came here.

### The argument

`284:C` is goal 284, check C. `284` on its own means "show me what 284 needs".
A bare description ("validate the login fix") means find the goal first and ask
which check if more than one is outstanding.

### What to do

1. **Read it.** `validation_read` with the issue, and the check letter if you
   were given one. It comes back with the procedure, what the check expects to
   see, any fixtures it needs and where they live, and whether an earlier attempt
   gave it back and why. Read the whole thing before starting.
2. **Claim it.** `validation_claim` with the issue and check. This stops the
   fleet dispatching an agent for the same check while you work, and stops a
   second session on this machine taking a different one — there is one working
   copy, and only one check can be claimed at a time. If something else holds a
   claim, the refusal names it; say so and stop rather than working around it.
3. **Run it.** Follow the procedure as written, on this machine. Drive the
   browser, use the login, do the steps. If it needs the application up, `local_run`
   with this goal's number brings it up — the harness owns that, so do not start
   anything yourself and do not guess at a start command.
4. **Report it.** `validation_report` once, with what you saw.

### The three answers

- **passed** — you followed the procedure and saw what it expects.
- **failed** — you followed it and did not. A real finding about the goal, and
  worth being specific about: the note is what somebody reads instead of running
  the check again.
- **blocked** — you could not run it. No login, no environment, the page is
  gone, the fixture was never provided. This records no reading and gives the
  check back with your reason. **It is the right answer, not a failure**: an
  agent that could not reach the environment has learned nothing about the goal,
  and `failed` would flag it for a reason that has nothing to do with the code.

### What not to do

- **Do not report `passed` from evidence you did not gather.** A green build, a
  merged PR and code that reads correctly are none of them this check. A pass
  nobody ran is the single outcome this whole feature exists to prevent.
- **Do not change code to make a check pass.** You are taking a reading, not
  doing the work. If the check fails, that is the answer — report it.
- **Do not report more than once**, and do not report on a check you did not
  claim. Which check you are reporting on is decided by what you claimed.
- **If the check describes something that no longer exists** — a screen that
  moved, a command that was renamed — say so in the report rather than guessing
  at what it meant. Correcting the wording is a job for an agent working the
  goal, not for the session taking the reading.
