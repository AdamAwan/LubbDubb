# 26 — Configuration health

The harness boots and runs with **no configuration at all**: `loadConfig`'s defaults select the
built-in `fake` provider for both capabilities, and the shipped example selects the `raw` agent
runtime, so `npm start` in a fresh clone turns the whole loop against a world it invents. That is a
supported posture and one of the reasons the loop is easy to understand before it is pointed at
anything real.

It is also the state a new operator arrives in with nothing telling them so. Every panel on the
Overview is legitimately empty, the fleet is idle and correct, and none of that is distinguishable
from a harness that is broken. This document owns the surface that closes that gap.

## What it is, and what it deliberately is not

**A reading, not a wizard.** The config page already draws every configurable leaf
([02](02-configuration.md#fields)); what an operator lacks is not a form but the knowledge of which
of those keys stop the fleet, and whether each one actually works against the real world. So each
thing this asks about ends in a **check**, and every check is one of this repo's catalogued silent
failures — the ones where nothing errors, nothing goes red and the fleet simply does nothing.

**An offer, never a gate.** Nothing here blocks the cockpit, refuses a pulse or stands in front of a
harness that is already working. That line is why an incoherent-but-runnable configuration is a row
rather than a loader refusal: `ownWorkOnly` on with no `userId` is a real mistake and refusing to
boot over it would make the shipped mock unbootable.

**One place, not four.** The checks are rows on the **Needs you** rail. There is no reading in the
top bar, no first-run card on the Overview and no panel of its own, and the reason is the failure
that replaced them: the bar counted outstanding checks and opened a screen that showed none of them,
while every check's remedy was a sentence with no control attached. A count that opens the wrong
surface is worse than no count, and a remedy nobody can act on is a scold.

## Two repositories

There are two, an operator can configure only one, and the one time they are the same directory is
the one time every surface here has to say which it means.

| Which                    | Where it comes from                                | What it is                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The project**          | `config.repoRoot`                                  | What the fleet works on: worktrees are cut from it, `.lubbdubb/` lives in it, and the team's `lubbdubb.project.json` is read from it.                                               |
| **LubbDubb's own build** | `installRoot()`, `src/selfUpdate/buildStanding.ts` | The directory the running build sits in, resolved from the running module and from **nothing an operator can configure**. What the Build reading watches ([21](21-self-update.md)). |

They coincide only when LubbDubb is dogfooding itself, which is how this repo is developed. But
`repoRoot` defaults to `process.cwd()`, so **on a default start the prefill always proposes the
harness's own directory** — right for a dogfooding deployment and wrong for every other one, and
indistinguishable from either side without asking. `repoRootIsSelf` is that question answered, on
both the reading and the resolution, and it is reported rather than refused: what it costs is not the
ability to proceed but the confidence to put that directory on a one-click button.

## The two questions

Everything else a checkout already knows. Asking somebody to retype what `git remote -v` prints is
asking them to be a worse copy of their own repository.

| Question        | Prefilled from          | What it is                                                                         |
| --------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| **Your email**  | `git config user.email` | An _input_, never a key. It resolves to whatever the provider calls you.           |
| **The project** | `config.repoRoot`       | The repository the fleet works on — and the one answer everything is read through. |

The email is not stored. What is written is the login it resolves to, as `userId`
([02](02-configuration.md#userid)). Two providers answer differently, and the difference is real
rather than cosmetic: Azure DevOps identifies people by UPN, so the address **is** the identity;
GitHub identifies people by login, which nothing offline can derive from an address, so it is asked
of the credential.

The project is first because the team's `lubbdubb.project.json` is found _through_ it
([02](02-configuration.md#the-project-layer)). Naming the repository is therefore not one answer of
two — it is what turns the remaining questions into readings.

## What the two answers derive

`resolveFromRepo` (`src/setup/resolve.ts`) reads a repository and an email into everything they
imply. It writes nothing and holds no state, so the confirm sheet is free to re-run it on every
keystroke — which is what lets the whole flow be one screen.

| Derived          | From                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| provider         | the `origin` URL — both SSH and HTTPS forms of both providers            |
| target           | the same URL: `owner/repo`, or `organization/project/repository`         |
| `defaultBranch`  | `origin/HEAD` where the clone recorded one, the running config otherwise |
| `userId`         | the email, resolved against the credential                               |
| the team's layer | `lubbdubb.project.json` at the root of the named repository              |
| the watch tag    | the team's `labelPrefix` where it sets one, the default otherwise        |

**A remote naming no provider this harness speaks resolves to `null`, never to `fake`.** That is a
third answer and the distinction is the whole of it: `fake` invents a world, so an unreadable remote
folded into it would show the operator a backlog that does not exist and present it as theirs. A
self-hosted GitLab, an internal mirror and a bare path all say so out loud instead.

### What gets written, and what does not

The resolution's `writes` is a set of config keys, and a key the **project layer already sets is
absent from it on purpose**. Copying a team value into an operator's own file freezes it at today's,
and the next commit that changed it would not reach them — the absence is the feature, and it is the
same reasoning behind the config page's four source chips.

**Every key is a config _leaf_ path** — `integrations.issues`, never `integrations`. This is not a
style rule: `POST /api/config` validates each key against `CONFIG_FIELDS`, a registry of leaves, so a
nested object is refused at the **preview**, with the operator's entire answer one field name away
from working. It was refused for every real repository, which is to say the flow had never once
completed against one; both sides typecheck, because the writes are a `Record<string, unknown>` and
the validator takes strings. `test/setupWrites.test.ts` holds the join rather than a literal — it is
a contract between two modules that neither of them states.

Two keys are a starting posture rather than a reading:

| Key                   | Setup writes | `DEFAULTS` |
| --------------------- | ------------ | ---------- |
| `agentMode`           | `stream`     | `stream`   |
| `maxConcurrentAgents` | `1`          | `3`        |

One agent on a first run is a deployment the operator can watch. The constant is left at three,
because that is the right cap for a harness somebody has decided to trust, and this surface's job is
the first hour rather than the steady state.

## The write path

**There is no second writer.** `writes` is handed to `POST /api/config/preview` and then to
`POST /api/config` exactly as a config-page edit is, so it walks the same refusal ladder, the same
surgical splice — which leaves an operator's comments, key order and blank lines alone
([02](02-configuration.md#writing-the-file)) — and the same `LiveConfig.apply`. A writer here would
be a second opinion about what a save means, and the first thing it would get wrong is the file
somebody is going to hand-edit tomorrow. The same is true of a one-click fix from the rail: it is the
same route, with the same ladder, for a smaller `set`.

It follows that this inherits the honest answer to "when does this take effect": `maxConcurrentAgents`
has an arm and applies now; everything else lands in the file and is reported as waiting for a restart
([02](02-configuration.md#liveness)).

## The checks

`buildSetupReading` (`src/setup/reading.ts`) answers six, plus a seventh whenever the file has moved
ahead of the process ([below](#a-fault-the-file-has-already-answered)), and they outlive the first three minutes on
purpose. That is the argument for their being checks rather than wizard steps: `credential` is how an
operator finds out on a Tuesday that a token expired, and `eligibility` is how they find out that a
filter of their own is hiding every tagged item on the tracker.

| Check         | Bad when                                                | Why it is silent                                                                                                                 |
| ------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pointed`     | both capabilities are still `fake`                      | the invented world reads exactly like a real one                                                                                 |
| `credential`  | the selected provider's env var is unset                | asked of **both** capabilities, since a deployment may read issues from one provider and PRs from another                        |
| `identity`    | `userId` is unset                                       | tickets it files go unassigned and its branches are not named as yours ([02](02-configuration.md#userid))                        |
| `eligibility` | tagged work exists and none of it is yours              | the fleet is idle **and correct**, which is the hardest state to tell from broken                                                |
| `wiring`      | nothing tagged, and nothing ever picked up              | the same, on the one day an empty panel is unreadable because none has ever been full                                            |
| `agent`       | `agentMode` is `raw`, or `claudeCommand` is not on PATH | a `raw` dispatch writes a transcript and never calls a model                                                                     |
| `billing`     | `ANTHROPIC_API_KEY` is in the environment               | agents inherit it and the CLI prefers a key with no prompt, so the whole fleet bills the API ([02](02-configuration.md#secrets)) |
| `restart`     | the file holds changes this process is not running      | `warn`, not `bad` — the harness works, it is just not working on what the operator last wrote                                    |

### A check earns a row for a discrepancy, never a quantity

"Nothing carries the watch tag" is the resting state of a healthy fleet that has cleared its backlog.
As one standing check it settled into a permanent scold for doing nothing wrong, so it is two:

- **`eligibility`** is a discrepancy and keeps its row forever. Tagged work exists and none of it is
  eligible, because `ownWorkOnly` is on and none of it is yours — the tracker and the config disagree,
  the fleet sits still, and nothing anywhere says so. It **cannot** fire on an empty backlog: it needs
  tagged items to exist before it has anything to compare. Its fix is `ownWorkOnly: false`, which is
  also the escape hatch for a provider that cannot report label authorship at all
  ([06](06-issue-pickup.md)) — the two are indistinguishable from here, and the same fix serves both.
- **`wiring`** is the first-hour question — _has this ever picked anything up_ — and is gated on
  `issue_runs` being empty, the durable record of every goal this harness has ever had a run at
  (`src/store/floor.ts`). One pickup and it is gone permanently, which is what makes it finite by
  construction rather than by a flag. A flag would be a second opinion about a thing the database
  already states, and the one that could disagree with reality is the one that would be wrong.

Every other check names a fault that clears when it is fixed, so none of them can settle into a nag.

### A fault the file has already answered

Most keys are restart-only — a key is live only if `src/configApply.ts` holds an arm for it
([02](02-configuration.md#liveness)) — and `integrations` and `userId` are two of the ones that are
not. So an operator can write both, watch nothing happen, and open this reading to be told to point
the harness at a project they have already pointed it at. Every surface involved was telling the
truth: the reading is built from the **running** config, and the running config really was the shipped
mock. The only thing that said a restart was owed was the config page's pending card, which is a page
you have to already suspect something to open.

So the reading takes `LiveConfig.pending()` as an argument, and a check the file has already answered
is **restated, never suppressed**:

- **The verdict is kept.** A `bad` that a restart would clear is still `bad` now — the fleet is on the
  fake provider until the process comes back, inventing a backlog that reads exactly like a real one.
  Softening it for a fix that has not taken effect would state something untrue about what is running.
- **The words and the offer change.** The detail names the value the file holds
  (`integrations.issues = "github"`), the remedy says the process is still running what it booted
  with, and the fix becomes a `goto` to the config page — where the pending card and its
  `Apply and restart` button already are. Leaving the old fix would offer to write a value the file is
  already holding, or re-ask a question it has answered.

A check's settle set is **the keys the check itself reads**, and nothing that merely rides along in
the same save. The confirm sheet writes `repoRoot`, `defaultBranch` and the provider target alongside
`integrations`, and hanging those off `pointed` would have a pending `defaultBranch` announce that
`pointed` had been answered — a sentence about a key that check never looked at. They land in
`restart` instead, which claims nothing about what they fix.

`credential` and `billing` are **not** in the map and must not be. Both read the environment, and no
edit to `lubbdubb.config.json` puts a variable into a running process: a restatement there would tell
an operator that bouncing the fleet will fix their expired token, and leave the fault in place
afterwards.

What no check spoke for becomes the `restart` row, computed from what was actually restated rather
than from the map — otherwise a pending `userId` on a harness whose `identity` check is already `ok`
falls between the two and reaches no surface at all.

### The verdicts are four-valued

`ok`, `warn`, `bad`, and **`unknown`** — and a reader must not fold the last into `bad`. A credential
that could not be asked and a credential that answered no are different news, and only the second is
about the operator's configuration. This is the same discipline as the three-valued reach verdict in
[24](24-environments.md#the-three-verdicts), for the same reason: a surface that states the wrong one
says something untrue in the operator's own words.

**An `unknown` check draws no row**, and that is not the fold: it is the check saying it could not
ask, and a row would state a fault nothing has evidence for. `KIND_FOR_VERDICT`
(`web/src/view/needsYou.ts`) is total over the verdict, so a fifth one fails the typecheck rather than
silently drawing as a fault.

### Nothing is persisted about it

Everything is read off the running config, the world baseline the pulse already persisted, and the
probes. There is no "has this operator onboarded" flag, because a flag is a second opinion about a
thing the config already states — and the one that could disagree with reality is the one that would
be wrong on the day somebody edits the file by hand.

## The fixes

A check's `remedy` is prose, and prose is a remedy the operator retypes somewhere else. Every check
here names something already silent, so the gap between reading the sentence and acting on it is
where the surface used to be lost. A check therefore also carries a `fix`, and which of the three
kinds it gets is the whole of what the harness is honestly able to do about it.

| Kind     | What it does                                                                  | Why                                                                             |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `config` | Writes config leaves through `POST /api/config`.                              | The fix _is_ configuration, so the harness applies it — through the one writer. |
| `goto`   | Opens the surface where the decision is made (Config at a group, or Tickets). | Which ticket to tag is a decision only a person has.                            |
| `sheet`  | Opens the confirm sheet.                                                      | What a repository implies is a table and a file, not a value on a button.       |
| `shell`  | Copies a command. **Never runs it.**                                          | Below.                                                                          |

**A `shell` fix is copied and never executed.** These are exactly the credential and billing checks —
`export GITHUB_TOKEN=…`, `unset ANTHROPIC_API_KEY`, installing the agent binary — and a button that
ran a shell string on the operator's behalf would put arbitrary execution behind the most sensitive
reading the cockpit draws. It is also not merely a policy: nothing in this process can change the
environment of a process that is already running, which is the same fact that keeps every secret out
of the config file ([02](02-configuration.md#secrets)). The fix says so, in the operator's terms,
rather than leaving the absence of a button to be read as an oversight.

### Confidence picks the control

`SetupIdentity.confidence` is three-valued and it decides what the rail draws, which is the answer to
"what if the suggestion is wrong":

| Confidence  | Control                                            | When                                                  |
| ----------- | -------------------------------------------------- | ----------------------------------------------------- |
| `confirmed` | A one-click button naming the value.               | The credential answered with this login.              |
| `assumed`   | The value in an **editable field**, then a button. | Derived with nothing corroborating it — an Azure UPN. |
| `unknown`   | No value at all; the fix degrades to `goto`.       | No credential, no provider, nothing to ask.           |

`userId` is why this matters rather than being tidy. With it set, pickup reads _who added_ each watch
tag, so a wrong login is a fleet that picks nothing up and reports nothing wrong — and the local part
of an email address is a plausible GitHub login, right often enough to be dangerous. The values that
could be wrong never get the confident control.

### Applying a fix

An applied fix **settles rather than vanishing**. The reading re-fetches on `config:changed`, so
without this the row a fix was applied from disappears under the click that applied it — and a write
nobody saw is a write nobody can check. The row goes green for the rest of the session, names the key,
the value and the file, and offers **Undo** and **Dismiss**.

Undo needs no new machinery: `POST /api/config` takes `clear` as well as `set`, so the previous value
is put back — or the key is cleared when the operator's own file never set it, read off
`RunningConfigEntry.isDefault`. Restoring a default by _writing_ it would leave the operator's file
asserting a value they never chose, which the config page's whole source-chip design exists to keep
apart.

## The probes

Everything slow or ambient is behind `SetupProbes` (`src/setup/probes.ts`): the git shell-outs, the
agent binary's version, `process.env`, the install root, and the provider call that resolves a login.
It is a seam for the reason every provider API is one — a probe that reached a real git, a real PATH
or a real network would answer differently on every developer's machine and in CI.

`env()` reads at the moment it is asked rather than snapshotting, because a credential exported after
boot is exactly the case the `credential` check exists for.

## In the cockpit

**The rows** are on the Needs you rail, merged with everything else waiting on the operator
([17](17-cockpit.md)).

- **Two kinds**, `config` (red) and `config_gap` (amber), rather than one kind with a per-row tone:
  `KIND_TONE` is total over `NeedKind`, which is what makes a new kind fail the typecheck instead of
  rendering untinted — and "your token expired" and "a gate is off" are not the same news.
- **Always `yours`, never `blocking`.** Tempting for a missing credential, since with one the fleet
  reads nothing at all — but the group is strictly about a **held slot**, and nothing here is parked
  on a worktree. Widening it for how much is stopped would cost the group the only thing it means.
- **No age.** The reading is fetched, not stamped: there is no instant at which a credential started
  being missing, and `raisedAt: ''` already draws nothing.
- **The row body opens the key on the config page**, and the fix sits in a strip beneath it. A control
  may not nest inside a control — one click cannot have two destinations — and the fix is a shortcut
  past the config page, never the only road to it.

**The confirm sheet** (`web/src/components/SetupPanel.tsx`) is the one screen left, reached from the
`pointed` row. It is one screen and not three because the three existed to gather two answers the
machine already had: the answers are prefilled, the derivation sits under them and re-reads on every
edit, so correcting the email is a keystroke rather than a Back button. It is a modal and **not** on
`Place`, against the usual rule ([17](17-cockpit.md#the-address-bar)): restoring it on a reload would
restore a review of answers the reload has already dropped. Same exception `ReviewWrite` takes on the
config page, for the same reason.

The reading is **fetched, not polled** — on open, and on the `config:changed` event the watcher and
every save already broadcast. It shells out to git and to the agent binary, which is not a thing to do
on a heartbeat, and `/api/state` is the wrong home for a reading whose subject is the configuration
that snapshot is built from.

## In the demo

The Pages demo ([19](19-development.md)) runs the flow end to end against `example/markdown-magpie`,
the repository its scripted world is already built on, with the config file held as a text buffer in
memory. That is a narrower fabrication than the demo's usual refusal implies: what it declines to
invent is the _running_ config, which `describeRunningConfig` resolves server-side and a copy of which
would be free to drift. A file's bytes are not that.

Two things stay honest there. Pointing the demo at any other directory shows the other half of the
design — a repository that could not be read, said out loud rather than papered over. And a demo save
reports `applied: false` for every key, because there is no live config object behind it to re-seat,
and claiming otherwise would be the one lie this whole surface exists to prevent an operator from
being told.

## Routes

Two, and **neither writes anything** — see [16](16-http-api.md).

| Route                     | What                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `GET /api/setup`          | the reading: the checks with their fixes, and the two prefills |
| `POST /api/setup/resolve` | the two answers read into everything they imply                |

The second is a `POST` for a read because the answers are a body rather than a path, and because it
resolves a directory the caller names and can reach the provider — which is worth a rate limit that a
`GET` would invite caching around.
