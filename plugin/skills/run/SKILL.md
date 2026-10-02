---
name: run
description: Get a LubbDubb goal's work running locally on this machine. Use for "/lubbdubb:run 284", "run 284 locally", "bring 284 up".
argument-hint: '<goal>'
---

## Run it locally

The operator wants to see this goal's work running on this machine. **You do not
start it — the harness does.** It keeps one checkout for this, brings the
application up in it, and holds the process; your job is to ask, then say what
happened.

1. **Ask for it.** `local_run` with the goal number. The harness stops whatever
   was running, points its checkout at that goal's code, and starts the
   application. Called with no goal it starts nothing and just reports the state.
   Called with a `message` it types that into the session holding the running
   environment — the way to get a migration run or a service restarted without
   starting over.
2. **Say what came back.** Whether it is running, on what URL, and — if it is not
   — what the reply says went wrong. The output tail comes back with it, and that
   is where the reason for a failed start actually is.
3. **Then offer the checks.** `validation_read` the goal and say what is
   outstanding. **Claim nothing yet.** They opened this to look at the thing, and
   claiming a check locks it away from the fleet while they do. Wait for them to
   pick one, then carry on at
   run a validation check with `/lubbdubb:check`.

**Only one goal runs locally at a time**, because there is one dev environment on
this machine. So asking for a second one is asking to stop the first, and it is
worth saying that out loud before you do it if they did not.

**`running` is not a reading.** It means the session the harness spawned finished
without failing — nothing has opened that port. Open the URL and look before you
say anything about whether the goal works.

**Do not start it yourself, and do not check a branch out here.** This session is
in the clone the harness cuts its agents' worktrees from: a branch checked out
here is one it can no longer hand to an agent, and a server you start yourself is
one nothing can stop from the cockpit.
