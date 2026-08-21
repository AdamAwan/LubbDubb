# 26 — First run and setup

The harness boots and runs with **no configuration at all**: `loadConfig`'s defaults select the
built-in `fake` provider for both capabilities, and the shipped example selects the `raw` agent
runtime, so `npm start` in a fresh clone turns the whole loop against a world it invents. That is a
supported posture and one of the reasons the loop is easy to understand before it is pointed at
anything real.

It is also the state a new operator arrives in with nothing telling them so. Every panel on the
Overview is legitimately empty, the fleet is idle and correct, and none of that is distinguishable
from a harness that is broken. This document owns the surface that closes that gap.

## What it is, and what it deliberately is not

**A preflight, not a wizard.** The config page already draws every configurable leaf
([02](02-configuration.md#fields)); what a new operator lacks is not a form but the knowledge of
which of those keys stop the fleet, and whether each one actually works against the real world. So
each thing Setup asks about ends in a **check**, and every check is one of this repo's catalogued
silent failures — the ones where nothing errors, nothing goes red and the fleet simply does nothing.

**An offer, never a gate.** Nothing here blocks the cockpit, refuses a pulse or stands in front of a
harness that is already working. The operator can close every screen, and the reading in the top bar
is the only thing that persists.

**Two questions, because the rest can be read.** A checkout already knows its provider and its
target, its integration branch and the team's shared policy. Asking somebody to retype what
`git remote -v` prints is asking them to be a worse copy of their own repository.

## The two questions

| Question             | Prefilled from          | What it is                                                                         |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| **Your email**       | `git config user.email` | An _input_, never a key. It resolves to whatever the provider calls you.           |
| **Project location** | `config.repoRoot`       | The repository the fleet works on — and the one answer everything is read through. |

The email is not stored. What is written is the login it resolves to, as `userId`
([02](02-configuration.md#userid)). Two providers answer differently, and the difference is real
rather than cosmetic: Azure DevOps identifies people by UPN, so the address **is** the identity;
GitHub identifies people by login, which nothing offline can derive from an address, so it is asked
of the credential.

The project location is first because the team's `lubbdubb.project.json` is found _through_ it
([02](02-configuration.md#the-project-layer)). Naming the repository is therefore not one answer of
two — it is what turns the remaining questions into readings.

## What the two answers derive

`resolveFromRepo` (`src/setup/resolve.ts`) reads a repository and an email into everything they
imply. It writes nothing and holds no state, so the review step is free to re-run it.

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

Two keys are Setup's own starting posture rather than a reading:

| Key                   | Setup writes | `DEFAULTS` |
| --------------------- | ------------ | ---------- |
| `agentMode`           | `stream`     | `stream`   |
| `maxConcurrentAgents` | `1`          | `3`        |

One agent on a first run is a deployment the operator can watch. The constant is left at three,
because that is the right cap for a harness somebody has decided to trust, and Setup's job is the
first hour rather than the steady state.

## The write path

**There is no second writer.** `writes` is handed to `POST /api/config/preview` and then to
`POST /api/config` exactly as a config-page edit is, so it walks the same refusal ladder, the same
surgical splice — which leaves an operator's comments, key order and blank lines alone
([02](02-configuration.md#writing-the-file)) — and the same `LiveConfig.apply`. A writer here would
be a second opinion about what a save means, and the first thing it would get wrong is the file
somebody is going to hand-edit tomorrow.

It follows that Setup inherits the honest answer to "when does this take effect": `maxConcurrentAgents`
has an arm and applies now; everything else lands in the file and is reported as waiting for a restart
([02](02-configuration.md#liveness)).

## Detection

Six signals, of different strengths, and no single one of them is "first startup".

| Signal                                        | Reads as         | What it does                                                               |
| --------------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `lubbdubb.config.json` absent at `cwd`        | first boot       | `pointed` is false: the Overview draws the first-run card                  |
| `integrations` both `fake`                    | on the demo      | the same, and it survives a config file pointed nowhere                    |
| a real provider whose credential env is unset | cannot reach     | the `credential` check goes red — and this one fires long after first boot |
| `agentMode` is `raw`                          | mock agent       | the `agent` check warns; deliberate in tests, so never on its own          |
| no open item carries the watch tag            | nothing opted in | the `watch` check warns                                                    |
| no cycle has read the world yet               | new database     | the `watch` check is **`unknown`**, never "nothing is watched"             |

`pointed` is `configFileExists && !onMock` and is a narrower question than "is everything green": a
harness pointed at a real repository with an expired token is pointed, and needs the checks rather
than the two questions again.

### The verdicts are four-valued

`ok`, `warn`, `bad`, and **`unknown`** — and a reader must not fold the last into `bad`. A credential
that could not be asked and a credential that answered no are different news, and only the second is
about the operator's configuration. This is the same discipline as the three-valued reach verdict in
[24](24-environments.md#the-three-verdicts), for the same reason: a surface that states the wrong one
says something untrue in the operator's own words.

### Nothing is persisted about it

Five of the six signals are read off the running config and the world baseline the pulse already
persisted; the sixth shells out. There is no "has this operator onboarded" flag, because a flag is a
second opinion about a thing the config already states — and the one that could disagree with reality
is the one that would be wrong on the day somebody edits the file by hand.

## The checks

`buildSetupReading` (`src/setup/reading.ts`) answers six, and they outlive the first three minutes on
purpose. That is the argument for their being checks rather than wizard steps: `credential` is how an
operator finds out on a Tuesday that a token expired, and `watch` is how they find out that a
repository nobody has tagged anything in will keep the fleet idle and report nothing wrong.

| Check        | Bad when                                                | Why it is silent                                                                                                                 |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pointed`    | both capabilities are still `fake`                      | the invented world reads exactly like a real one                                                                                 |
| `credential` | the selected provider's env var is unset                | asked of **both** capabilities, since a deployment may read issues from one provider and PRs from another                        |
| `identity`   | `userId` is unset                                       | all three ownership gates are simply off ([02](02-configuration.md#userid))                                                      |
| `watch`      | no open item carries `${labelPrefix}-watch`             | the fleet is idle **and correct**, which is the hardest state to tell from broken                                                |
| `agent`      | `agentMode` is `raw`, or `claudeCommand` is not on PATH | a `raw` dispatch writes a transcript and never calls a model                                                                     |
| `billing`    | `ANTHROPIC_API_KEY` is in the environment               | agents inherit it and the CLI prefers a key with no prompt, so the whole fleet bills the API ([02](02-configuration.md#secrets)) |

## The probes

Everything slow or ambient is behind `SetupProbes` (`src/setup/probes.ts`): the git shell-outs, the
agent binary's version, `process.env`, and the provider call that resolves a login. It is a seam for
the reason every provider API is one — a probe that reached a real git, a real PATH or a real network
would answer differently on every developer's machine and in CI.

`env()` reads at the moment it is asked rather than snapshotting, because a credential exported after
boot is exactly the case the `credential` check exists for.

## In the cockpit

Three surfaces, and only the first is permanent.

- **The Setup reading** in the top bar counts what is outstanding, and is **absent at zero**. A
  reading that is always green is one nobody reads; this one earns the space by not being there most
  of the time. Amber while anything warns, red once anything has actually failed.
- **The first-run card** on the Overview, drawn only while `pointed` is false. It is blue rather than
  amber — an offer about a harness that is working, not a warning about one that is not — and it does
  not come back once the file names a real provider.
- **The panel** (`web/src/components/SetupPanel.tsx`), reached from either, and on `Place` like every
  other panel so it can be linked to.

Its three steps are **not** on `Place`, against the usual rule ([17](17-cockpit.md#the-address-bar)).
A step inside an unsaved edit is not somewhere to send somebody: restoring "review" on a reload would
restore a review of answers the reload has already dropped. It is the same exception `ReviewWrite`
takes on the config page, for the same reason.

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

| Route                     | What                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `GET /api/setup`          | the reading: `pointed`, the six checks, `outstanding`, and the two prefills |
| `POST /api/setup/resolve` | the two answers read into everything they imply                             |

The second is a `POST` for a read because the answers are a body rather than a path, and because it
resolves a directory the caller names and can reach the provider — which is worth a rate limit that a
`GET` would invite caching around.
