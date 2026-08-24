# 02 — Configuration

All configuration lives in `src/config.ts` as the `Config` interface, its `DEFAULTS`, and two
loaders. There is no other configuration mechanism.

## Two loaders

- **`loadConfig(overrides)`** — `DEFAULTS` + the caller's overrides, then path resolution and
  validation. It reads **no file and no environment variable**, so the same arguments give the same
  config on any machine. This is what tests and embedders call.
- **`loadDeploymentConfig(overrides)`** — the three ambient layers (the targeted project's
  `lubbdubb.project.json`, `lubbdubb.config.json` and the env overrides) folded in underneath the
  explicit ones, then `loadConfig`. This is what a process entry point calls; `src/server/main.ts` is
  the only one.

The split exists because the ambient layers make the config a function of the machine it loads on.
The suite runs in a working copy of this repo, so an operator's own `lubbdubb.config.json` sitting
beside it would otherwise merge into every test that builds a config — silently, and differently on
each developer's machine. A test wants defaults plus what it wrote; only a deployment wants the
environment. `scripts/smoke.ts` builds a hermetic scenario against a throwaway repo, so it calls
`loadConfig` too.

## Precedence

Values are merged in this order, later winning:

1. `DEFAULTS` (in `src/config.ts`)
2. `lubbdubb.project.json`, read from `repoRoot` — the [project layer](#the-project-layer), shared by
   a team through the repository the harness works on
3. `lubbdubb.config.json`, read from `process.cwd()` — the operator's own; absent is fine,
   unparseable throws with the file path and the parse error
4. Environment overrides: `PORT` → `port`, `LUBBDUBB_HOST` → `host`, `LUBBDUBB_DB` → `dbPath`,
   `LUBBDUBB_REPO_ROOT` → `repoRoot`
5. Explicit `overrides` passed to the loader (tests, embedding)

Layers 2, 3 and 4 exist only under `loadDeploymentConfig`; `loadConfig` sees 1 and 5.

Twelve keys are **deep-merged** rather than replaced, so a config file can set one field of them
without dropping the rest: `integrations`, `planning`, `pets`, `spendBurn`, `runway`, `selfUpdate`,
`validation`, `localRun`, `auth`, `ci`, `github`, `azureDevOps`. The deep merge holds _between_ layers
as well — an explicit `{planning: {maxConcurrentPartsPerIssue: 4}}` keeps the other `planning` fields
the operator's file set, and an operator's `planning` block keeps the fields their team's set.
`azureDevOps.filters` is merged one level deeper again, being the one sub-block with a per-leaf edit of
its own; `azureDevOps.policyChecks` is edited as a whole row and replaces. Everything else — including
`issuePriorityLabels` and the `ci.checks` **list** — is replaced wholesale.

**A block the config form offers per-leaf edits over must be deep-merged, or a save of one leaf
silently drops the rest.** That is the rule the three latecomers are here for: the form writes exactly
the leaf an operator changed, so a replacing block loses every sibling the layer below it set the
moment one leaf arrives. `ci` dropped a team's whole CI policy to nothing — and `ci.checks` is a
_live_ field, so the empty policy took effect on the next pulse; `azureDevOps` was reduced to the one
field edited and the next boot refused to start over an incomplete target, from a save the page had
reported `200` for and a restart the same page offers; `github` lost its `owner`. `ci` keeps its
replace-when-present semantics inside the merge — an ordered list has no field-by-field fold, so a
layer that _states_ `checks` still replaces it. What the merge stops is an **absent** `checks`
shadowing the list underneath.

Clearing a row is the same failure pointed the other way, and is fixed at the writer: `editConfigText`
removes the parent a cleared leaf emptied, up as far as the emptiness goes. A `"ci": {}` left behind
still states the key, so it would replace the project's `ci` with nothing — which is exactly the
promise below that it does not.

A layer carries **only what its file said**. The defaults are folded once, at the bottom, by
`mergeConfig`; `mergeLayers` never folds them in. That is not tidiness — a layer that arrived dense
(every field of a block present, the ones its file set and the defaults for the rest) does not merge,
it replaces. With two layers nothing showed, because the only thing underneath a dense layer was the
defaults it had copied. With three, it is the feature failing silently: an operator's
`{"planning": {"gitFetchIntervalMs": 0}}` would arrive carrying the default part cap and shadow the
one their team set, and the harness would run a policy no file on the machine states.

### Retired keys

Two kinds of key an operator's file may still carry, and they are treated differently because they
ask for different things.

A **removed key** (`REMOVED_KEYS`: `dispatcher`, `steeringPriorities`, `autoSend`) is **refused**, by
name, with what to do about it. It names a capability that no longer exists on any setting, so
honouring it is impossible and ignoring it would have the harness do the opposite of what the file
says while the file goes on saying it. `dispatcher` is the clearest case: it selected between two
dispatchers where there is now one, so no value it can carry means anything.

`autoSend` is the entry worth reading carefully, because what it asked for came **back** — narrowed —
and the entry still refuses. It was a block carrying a confidence _threshold_, and that number is the
thing that is gone for good ([09](09-execution.md#the-two-standing-authorities)). What replaced it is
`sendPrRepliesWithoutApproval`: a plain boolean, replies only, with nothing to resolve between two
constants. Reviving the old name for it would be worse than useless — an old
`{"autoSend": {"threshold": 0.8}}` would merge an object where a boolean is expected — so the name
stays refused and its refusal **names the key that replaced it**. A `REMOVED_KEYS` entry is permanent;
its reason is the part that gets rewritten.

A **retired key** (`RETIRED_KEYS`) is **warned about, dropped, and the harness boots**. Almost every
entry named a subsystem that is now **unconditional**, so a file setting one is asking for something
the harness either already does or will never do again — and refusing would take a running deployment
down at boot over one stale line. `lessonBlockChars` is the one entry of a second kind: it bounded a
block that no longer renders, and what replaced it is bounded by `knowledgeBlockChars`. It warns
rather than refusing for the same reason and carries a real cost — a deployment that had tuned the
figure boots on the new key's default until somebody sets it — which is why the warning names the
replacement. The warning is on the boot log, naming the key: a deployment that
had switched a funnel off is getting it back, and has to hear that from the harness rather than from
the fleet's behaviour. The key is dropped rather than left to merge into nothing, so no value
survives on the policy object for something later to read.

An entry is either a top-level name or one `block.key` path, and both forms are there because a
block whose every field went unconditional is removed whole while an operator's file names the block
rather than the field inside it. The list:

| Retired key                                                        | Because                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `planning.enabled`, `validation.enabled`                           | always on ([08](08-planning.md), [20](20-validation.md))                                             |
| `assay`, `assessment`, `retrospective` (and each one's `.enabled`) | always on ([06](06-issue-pickup.md), [05](05-dispatcher.md))                                         |
| `mcp`, `mcp.enabled`, `mcp.permissionEscalation`                   | always on ([11](11-mcp-tools.md))                                                                    |
| `validation.desktop`, `validation.desktopSkill`                    | the channel and its skill are always on ([20](20-validation.md))                                     |
| `reapMergedBranches`                                               | always on ([07](07-pull-requests.md#reaping-a-merged-branch))                                        |
| `reviewReminderMs`                                                 | the cockpit ages every waiting PR, with no threshold                                                 |
| `issuePickupRequireOwnLabel`                                       | follows `ownWorkOnly` + `userId` ([below](#userid))                                                  |
| `github.defaultAssignee`, `azureDevOps.defaultAssignee`            | follows `userId`                                                                                     |
| `github.filters`, `azureDevOps.filters.prAuthor`                   | follows `ownWorkOnly` + `userId`                                                                     |
| `azureDevOps.filters.workItemAssignedTo`                           | follows `ownWorkOnly` + `userId`                                                                     |
| `lessonBlockChars`                                                 | one block ships, and it is the knowledge base's ([27](27-knowledge.md#delivery-two-prompts-not-one)) |

Both lists are permanent — a config written before a removal outlives the release that made it.

A third function, `loadConfigFromText`, builds the config a given file text _would_ produce on this
machine — the same three layers, from text rather than from disk. That is how a save from the cockpit
is validated, and it is a function rather than a second copy of the env layer for the reason the split
above exists: two lists of environment variables is how a UI comes to offer an edit to a key the
environment silently beats.

`loadConfig` **throws** for two combinations. The first is a `host` that is reachable off this machine
together with `auth.enabled: false`. Each half alone is a supported deliberate choice; together they
expose an endpoint that queues jobs — which spawn agents with write access to the repo — to every peer
on the network. A warning would scroll past in a boot log, so it is refused instead.

The second is a `localRunRoot` that **overlaps `worktreeRoot`** — one inside the other, in either
direction, or the same path twice. The pool would lease the local run's checkout to an agent and
`git clean -ffdx` the operator's warm install and their uncommitted preview work out of it, with no
salvage: the stash runs at `acquire`'s dead end, and a free slot handed over normally is not one. It is
refused for the pair above's reason — what a warning would cost here is work. Both refusals are judged
after path resolution, so a relative override is compared as the absolute path it becomes; and both
reach the cockpit's save, which validates through `loadConfigFromText`. The rule is scoped to these two
roots: `deskRoot`, `attachmentRoot` and `validationRoot` are plain directories, never registered
worktrees, so `slots()` cannot see one and the pool's own slot names (`slot-<n>`) cannot land on it.

No secret is ever a config key. The GitHub token comes from `GITHUB_TOKEN`, and the cockpit token
from `LUBBDUBB_TOKEN` or a minted 0600 file, so `lubbdubb.config.json` stays safe to paste.

## The project layer

`lubbdubb.project.json`, at the root of the repository the harness works on, is the layer a **team**
shares. It is committed. Everything about a project that is the same for everyone working on it —
which branch is integrated onto, what each CI check means, where landed work travels, which tracker
states count as pickup — belongs in one file in the repository rather than in each member's copy of a
config, drifting apart from the day it is pasted.

Each member's `lubbdubb.config.json` sits above it and wins: who they are, which models they
dispatch on, how many agents their machine runs, where their database lives. Nobody has to choose
between sharing a config and having their own.

**Any key may appear in it, with one exception: `repoRoot`.** That file was read _because_ `repoRoot`
already resolved, so a value in it could only describe the search that found it — honouring it would
mean re-reading from somewhere else, and dropping it would leave the fleet pointed at a repository
the file in front of the operator disagrees with. It is refused by name, like a removed key. Where
the harness points is settled by `lubbdubb.config.json` or `LUBBDUBB_REPO_ROOT`, from the operator's
layers alone and _before_ the project's file is looked for: a layer cannot be consulted about where to
find itself.

Two consequences worth stating rather than discovering:

- **The file is read, not trusted less.** It gets exactly the reading an operator's own file gets — a
  removed key is refused by name, a retired one warns and is dropped — and it may carry
  `environments` and `localRun`, which are shell commands the harness runs on the operator's machine.
  That is not a new exposure being opened: a harness pointed at a repository already dispatches agents
  with write access into worktrees of it and runs its scripts. The file is read from the **checked-out
  working tree** at `repoRoot`, so a branch — a pull request from anywhere — does not reach it before
  somebody merges and the operator pulls.
- **It is watched like the operator's own.** It arrives by `git pull` rather than by an edit, and a
  team change that took effect only at the next restart would be a config the harness reads and does
  not run. Two watches on one apply path, for [the watcher](#the-watcher)'s reason.

It is also what makes the first-run surface two questions rather than six: naming the repository is
how the harness _finds_ this file, so everything a team has already decided stops being something
their next member is asked. → [26](26-setup.md)

Not in `.lubbdubb/`, which holds worktrees, the database and attachments and which a team gitignores.
And not the same _name_ in a different place: `repoRoot` defaults to `process.cwd()`, so a harness
pointed at its own checkout — the most common deployment there is — would have the two files collide.

### In the cockpit

Two files means a new way to be silently confused: a value the operator did not write, in a config
page that only writes one of them. So the running-config view is handed the project's **layer**
(not a config — once merged, a team value equal to the default is indistinguishable from no value at
all) and every row says which of the four it came from: `env`, `file`, `project`, `default`.

`isDefault` therefore means _what the operator would have without their own file_ — defaults with the
project folded in — rather than the built-in default. Those are the same question: the form writes
`lubbdubb.config.json` and nothing else, so "did I choose this" and "what does clearing it leave" have
one answer. A row cleared while the project sets it says it will fall back to the project's value,
because it will.

A save is never written to the project's file. It belongs to the team, and it is changed by committing
to the project.

## Fields

Every configurable leaf is declared once, in `src/configFields.ts`: its type (`number`, `boolean`,
`string`, `enum`, `stringList`, `json`, `colourMap`), the members where it is an enum, how far an
operator reaches to edit it, the environment variable that beats it, and one line saying why it exists.

The declaration exists because `RunningConfigEntry` carries `value: unknown`, which is enough to read a
value back and nothing like enough to draw a control for it. Four consumers read the table — the form's
widgets, the save validator, the reset action and the running-config viewer — and each guessing
separately is four places to disagree.

`access` is the reach:

| `access`   | Where it is drawn                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plain`    | Inline, in its group.                                                                                                                                                                         |
| `advanced` | Behind one disclosure with a warning: Paths, Server, `claudeCommand`/`claudeArgs`. These can leave an operator unable to reach their own cockpit, or point the fleet at the wrong repository. |
| `fileOnly` | Drawn, never offered. `whitelistedApprovals` types text into an agent's session on a substring match — a thing to write deliberately in a file, not to fill in beside twenty other rows.      |

A `json` field is edited whole because it has no fixed shape to draw: an ordered rule list where the
order is the semantics (`ci.checks`), or a map whose keys the operator invents
(`issuePriorityLabels`, `agentModels`).

A `colourMap` is the one map that does have a shape to draw — state → `#rrggbb` — and it is a type of
its own rather than a `json` field because JSON is the wrong instrument for picking a colour. The
cockpit draws one swatch per state, previewed in the chip the value lands on, over a `datalist` of the
state words the tracker is currently reporting; the list is an offer and never a closed set, since a
state no open item is sitting in is still one worth colouring. `issueStateColours` is the only field of
this type. Its values are refused leaf by leaf on the way in — a colour reaches a `style` attribute, so
a map half of whose entries do nothing is one an operator reads as broken with nothing saying why.

`test/configFields.test.ts` asserts every top-level key of `defaultConfig()` is declared, so a config
key added without one fails `npm run check` rather than quietly arriving un-editable — the failure
`lubbdubb.config.example.json` already had as a hand-maintained discovery surface.

The table also gives the loader something it never had: a **type check**. `loadDeploymentConfig` casts
the parsed file to `Partial<Config>`, so `"port": "4300"` boots and fails later at the point something
tries to listen on a string. A save is refused for it by name. What the table deliberately does not
check is _meaning_ — whether a burn multiple is above 1, whether a CI routing exists — because that is
`loadConfig`'s, and a save is validated by building the config it would produce.

## Liveness

Whether saving a key takes effect now is decided by one thing: whether `src/configApply.ts` holds a
named **arm** that re-seats whoever is holding the value. A key with an arm is live. A key without one
is `restart`, and the cockpit says so on its own row.

It is not a list of keys that "read late". That list is right the day it is written and wrong the day
somebody hoists `config.heartbeatIntervalMs` into a const, with nothing red — which is the exact
failure this repo catalogues. `test/configFields.test.ts` asserts the classification and the arms agree
in both directions; `test/configApply.test.ts` asserts each arm through its _effect_, never through the
flag, so an arm that stops doing anything fails rather than passing.

Few keys have arms, and the shortness is deliberate — every arm is a second place a value lives, and
so a place two copies can disagree:

| Key                       | The arm                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentAgents`     | Assign, and re-seat `RuntimeControl`, which the harness reads by reference each cycle. The live cap stays ephemeral: a restart still comes back to the file.                                                                                                                                                                                                                                                                                   |
| `knowledgeBlockChars`     | Assign. `system.ts` renders the knowledge block through a closure at every launch, so the object _is_ the late reader.                                                                                                                                                                                                                                                                                                                         |
| `knowledgeScopeStaleDays` | Assign. `buildStateSnapshot` reads the running config by reference at every poll and takes the `check:` staleness verdict there, so the object _is_ the late reader. Live because it is a reading an operator tunes while looking at the page that draws it — restart-only would be a number they widen, watch do nothing, and widen again. → [27](27-knowledge.md#scope--who-it-is-relevant-to)                                               |
| `mcpArgsRetentionDays` | Assign. Both MCP servers read it at every call and hand it to the store, so the object _is_ the late reader. Live because turning argument recording off is a thing an operator wants to take effect now rather than at the next restart — and because it is retroactive, a save also clears what is already past the new bound on the next sweep. |
| `issueStateColours`       | Assign. `buildStateSnapshot` reads the running config by reference at every poll and ships the colours to the cockpit, so the chips are recoloured a heartbeat later. Nothing in the harness reads a colour, so there is no consumer to re-seat.                                                                                                                                                                                               |
| `pets.visible`            | Assign **onto `running.pets`**, never over it: `PetKeeper` closed over that object and reads `visible` on every `state()`, so replacing the policy would leave the keeper on the old one while the config page said the change had applied. Live because it is pure presentation — nothing it reaches hatches, feeds or clears. → [22](22-pets.md#configuration)                                                                               |
| `localRun.*`              | Assign **onto `running.localRun`**. The runner reads the policy by reference at every start and the snapshot at every poll, so the object _is_ the late reader. Live because this is the one field an operator corrects while a start is failing in front of them: restart-only would mean bouncing the harness — and the fleet's agents with it — to fix a typo in a command. → [23](23-local-runs.md#the-instruction-is-config-not-a-prompt) |
| `sendPrRepliesWithoutApproval` | Assign. The executor asks the running config by reference at every act it authorizes (`system.ts` wires `autoSendReplies` as a thunk over the object), so the object _is_ the late reader. Live because of the flip that matters — turning it back **off**: restart-only, the harness would go on sending replies unasked for as long as it took to bounce it. → [09](09-execution.md#the-two-standing-authorities) |
| `ci.checks`               | Assign, and hand `RuleDispatcher` a new policy — it took `{checks}` at construction, so assignment alone would leave the cockpit drawing one policy while the dispatcher ran another.                                                                                                                                                                                                                                                          |

Everything else is restart-only, including the ones that could be made live. A key nobody changes twice
a year is better left restart-only than made live for the sake of it. Some cannot be otherwise:
`agentMode` picks a runtime object once, `integrations` builds the provider clients once, and
`dbPath`/`port`/`host`/`repoRoot` are boot decisions.

What has landed in the file and is waiting is held by `LiveConfig.pending()` — **recomputed** from the
running config against the file on every apply rather than accumulated. Once the arms have run,
whatever still differs _is_ the definition of waiting for a restart, so editing a key twice leaves one
row and putting one back leaves none.

It is read in two places, and the second is not a duplicate of the first. The config page draws it as
the pending card, with the restart button on it. The **configuration health reading** takes the same
list and uses it to stop asking for work already done: a check the file has already answered keeps its
verdict and changes its words to say a restart is owed, and whatever no check speaks for becomes a row
of its own. Without that, a restart-only key was a change an operator could make correctly, in the
file, and be told on the rail to make again — which is what `integrations` and `userId`, the two most
consequential restart-only keys there are, did to every first-run deployment.
→ [26](26-setup.md#a-fault-the-file-has-already-answered)

## Writing the file

Nothing in the harness wrote `lubbdubb.config.json` until the config form existed. The write is
**surgical**: find the span of the value being set, splice the new one in, leave every other byte
alone. A `JSON.parse` → mutate → `JSON.stringify` round trip is not acceptable, and the reason is the
file's own documentation convention — the `"// key"` entries survive a round trip (they are ordinary
JSON members) but the blank lines that group them, the indent style and the inline `{ "a": 1 }` blocks
do not. An operator who saves one field and finds their whole file rewritten has been given a reason
never to use the form again, and a real config carries paragraphs of that prose.

It follows that a key the form has never heard of — a comment, a future key, a typo being fixed — is
carried through untouched rather than dropped.

The write is **atomic**: a temp file beside it and a rename, so a crash mid-save cannot leave the
harness with a config its next boot cannot read. The temp file is in the same directory on purpose — a
rename across filesystems is not atomic. `editConfigText` is exported separately from the write so the
round trip is testable without a filesystem; `test/configFile.test.ts` round-trips a commented config
and asserts the comments, the key order and every unchanged line survive.

## The watcher

`lubbdubb.config.json` is watched — and so is the project's `lubbdubb.project.json` — and a change on
disk lands on the **same** `LiveConfig.apply` a cockpit save lands on: live keys through their arms, everything else held as pending and reported to
every open cockpit. That is the whole of keeping the file first-class — one apply path means a hand
edit and a form save cannot produce different outcomes.

It polls the file's content rather than watching it. `fs.watch` binds to an inode, and an editor that
writes through a temp file and a rename replaces it, leaving the handle quiet with nothing to say it
has; `fs.watchFile` keeps the path but takes its baseline stat asynchronously, so an edit landing
between starting the watch and that first stat is absorbed into the baseline and never reported.
Comparing bytes has neither hole.

A parse failure or a validation throw is **recorded through `errors.record` and dropped**, and the
running config is left exactly as it was. A half-typed file is a normal thing to observe — the operator
is mid-keystroke — and a watcher that applied one would take the fleet down over a missing brace.

Two watches rather than one over both paths: each holds the bytes it last saw, and the reload folds
every layer either way, so the file that moved is the only thing the two of them differ about.

Wired in `src/server/main.ts` rather than `buildSystem`, for `loadDeploymentConfig`'s reason: only a
deployment has an ambient file to watch. `System.configFile` and `System.projectConfigFile` are the
paths, injectable in tests — without that a test exercising the save rewrites the
`lubbdubb.config.json` of whatever checkout the suite is running in, and a test reading the project
layer picks up whatever `lubbdubb.project.json` that checkout happens to carry.

## Path resolution at load

`loadConfig` resolves paths so that later code, which runs with a worktree or scratch `cwd`, cannot
resolve them against the wrong directory:

- `repoRoot` is resolved against `process.cwd()`.
- `worktreeRoot`, `deskRoot`, `attachmentRoot`, `validationRoot`, `localRunRoot` and `promptTemplatesDir` are resolved against **`repoRoot`** (not the
  launch directory), so running LubbDubb from its own folder against a repo elsewhere does not
  scatter that repo's worktree slots into the app's directory. An absolute override is honoured as-is.
- Each entry of `claudeArgs` that is relative **and names an existing file** is made absolute.
  Non-file args are left untouched.

## Reference

### Loop and capacity

| Key                   | Type      | Default                     | Behaviour                                                                                                                                                                                                                                                                                             |
| --------------------- | --------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heartbeatIntervalMs` | `number`  | `300000`                    | Gap between timer-driven cycles.                                                                                                                                                                                                                                                                      |
| `maxConcurrentAgents` | `number`  | `3`                         | Seeds the runtime cap. Live changes go through `POST /api/control` and are **not** persisted. It is also the fleet's **only** size knob: the worktree pool is the live cap plus a slack of two, read on every acquire, so raising the cap raises the pool with it. → [09](09-execution.md#exhaustion) |
| `startPaused`         | `boolean` | `false`                     | Seeds the runtime pause flag. The only config-level pause knob; live pause/resume is ephemeral, so a restart reverts to this.                                                                                                                                                                         |
| `sendPrRepliesWithoutApproval` | `boolean` | `false` | Send a review reply the fleet drafted straight to the thread, without asking you. Off, every draft waits in your inbox as a proposal. Replies only — a merge is authorized per pull request by landing a stack. → [09](09-execution.md#the-two-standing-authorities) |
| `port`                | `number`  | `4300`                      | HTTP/WS port. Overridable via `PORT`.                                                                                                                                                                                                                                                                 |
| `host`                | `string`  | `127.0.0.1`                 | Bind address. Loopback by default; `"0.0.0.0"` exposes the cockpit on the network and then requires `auth.enabled`. Overridable via `LUBBDUBB_HOST`.                                                                                                                                                  |
| `auth.enabled`        | `boolean` | `true`                      | Require a bearer token on `/api/*` and `/ws`. See [16 — HTTP API](16-http-api.md#authentication).                                                                                                                                                                                                     |
| `auth.tokenFile`      | `string`  | `.lubbdubb/cockpit-token`   | Where a minted token is persisted (0600). Ignored when `LUBBDUBB_TOKEN` is set.                                                                                                                                                                                                                       |
| `dbPath`              | `string`  | `.lubbdubb/lubbdubb.sqlite` | SQLite file. Overridable via `LUBBDUBB_DB`. `:memory:` is supported (tests).                                                                                                                                                                                                                          |

### Repository

| Key              | Type     | Default                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoRoot`       | `string` | `process.cwd()`         | The git repository worktrees are cut from — and where the team's `lubbdubb.project.json` is read from ([the project layer](#the-project-layer)). Overridable via `LUBBDUBB_REPO_ROOT`; never settable from the project's own file.                                                                                                                                                                                                                                        |
| `defaultBranch`  | `string` | `"main"`                | The integration branch. A new agent branch is cut from it, and a PR targeting anything else is treated as stacked. Not auto-detected.                                                                                                                                                                                                                                                                                                                                     |
| `worktreeRoot`   | `string` | `.lubbdubb/worktrees`   | Root for the pool of worktree slot directories (`slot-0`, `slot-1`, …).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `deskRoot`       | `string` | `.lubbdubb/desk`        | Root for desk-task scratch directories (one per task id).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `attachmentRoot` | `string` | `.lubbdubb/attachments` | Root for images attached to a blueprint (issue #249) — deliberately outside every worktree, so a screenshot cannot be committed onto a branch. Every agent launch is granted read access to this whole root via `permissions.additionalDirectories`, which is a real widening: an agent working one goal can read another goal's attachments. See [09](09-execution.md) and [10](10-agent-runtimes.md).                                                                   |
| `localRunRoot`   | `string` | `.lubbdubb/local-run`   | The local run's one checkout, kept warm between goals. **Must not be under `worktreeRoot`**, and is **refused at load** if it is: the pool counts every registered worktree under its root whatever the directory is called, so a preview checkout in there would count toward the bound and be handed to an agent. → [23](23-local-runs.md#the-checkout)                                                                                                                                                      |
| `validationRoot` | `string` | `.lubbdubb/validation`  | Root for a goal's validation resources — fixtures, reference material, sample data — one directory per goal (`<root>/issue-284/`). `attachmentRoot`'s storage rule, argument for argument: outside every worktree, canonical rather than copied per dispatch, and granted to every agent launch through `permissions.additionalDirectories`. Granted on every launch, so an agent's readable set does not depend on a policy flag it cannot see. → [20](20-validation.md) |

There is no key for how many worktree slots the pool holds. It is the **live** agent cap plus a slack
of two, read on every acquire — so `maxConcurrentAgents`, raised in the cockpit or in this file,
raises the pool's ceiling with it. `worktreePoolSize` used to pin it and could only be wrong in one of
two directions: below the cap it silently became the fleet's real limit (every dispatch above it
refused for want of a directory, presenting as a full queue and an idle fleet with nothing red), and
above it, it was disk nothing could lease. A deployment that cannot hold that many checkouts lowers
the cap instead. → [09](09-execution.md#exhaustion)

### Dispatch behaviour

| Key                          | Type            | Default             | Behaviour                                                                                                                                                                                                                                                                                                                                                     |     |
| ---------------------------- | --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `promptTemplatesDir`         | `string`        | `.lubbdubb/prompts` | Directory of `<prompt-id>.md` overrides, read once at boot. Absent directory = all built-in defaults.                                                                                                                                                                                                                                                         |     |
| `closedPrWindowMs`           | `number`        | `21600000` (6h)     | How far back providers look for PRs that left the open set. `0` disables the lookup entirely.                                                                                                                                                                                                                                                                 |     |
| `environments`               | `list`          | `[]`                | Where landed work travels — `{name, at, arrival?}` per entry: a command printing the commit the environment is **at**, and optionally what arriving there opens on the bench and whether it is said on the ticket. Empty is the off switch. `fileOnly`: each entry is a shell command the harness runs. → [24](24-environments.md#configuring-an-environment) |     |
| `environmentProbeIntervalMs` | `number`        | `300000` (5m)       | How long an unconfirmed landing rests before its environment is asked where it is again — and the precision of every "arrived at" the cockpit shows. A confirmed landing is never re-asked, an environment with nothing pending is not asked at all, and it also bounds which arrivals are fresh enough to announce.                                          |     |
| `upNextOverrideTtlMs`        | `number`        | `604800000` (7d)    | How long an operator "Up next" priority override (issue #128) survives after its origin stops being tracked. `0` disables pruning.                                                                                                                                                                                                                            |     |
| `ci.checks`                  | `CiCheckRule[]` | `[]`                | Per-check CI policy: what rule `pr-ci-failing` does about _which_ check went red. Ordered, first match wins, replaced wholesale by an override. Empty — and any check matching no rule — is the pre-policy behaviour: dispatch a code agent. See below.                                                                                                       |     |

#### Per-check CI policy (`ci.checks`)

A check is matched against each rule's `match` **glob** in order (`*` = any
run of characters, `?` = exactly one, everything else literal, matched
case-insensitively) **and** against the rule's `states`; the first rule that
matches on both decides it. The glob is tried against every name the provider
reports for the check — its `name` and any `aliases` (see
[07](07-pull-requests.md#ci-checks)).

| Field       | Type                                   | Default       | Behaviour                                                                                                                                                |
| ----------- | -------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`     | `string`                               | (required)    | Glob against the check name (`lint`, `test (*)`, `deploy-*`), or any alias the provider reports for it.                                                  |
| `states`    | `('failing' \| 'pending')[]`           | `['failing']` | Which check states this rule claims. Scopes the whole rule, so a rule listing only `pending` does **not** claim the same check when it fails. See below. |
| `onFailure` | `'dispatch' \| 'ignore' \| 'escalate'` | `'ignore'`    | What a check this rule claims makes the harness do. The default is `ignore` because the usual reason to name a check is to stop acting on it.            |
| `guidance`  | `string`                               | unset         | Appended to the dispatched agent's prompt when this check is among the ones that fired. Only legal with `onFailure: 'dispatch'`.                         |
| `urgent`    | `boolean`                              | `false`       | Sort this PR's concern ahead of every other PR concern this cycle. Only legal with `onFailure: 'dispatch'`.                                              |

##### Watching a check that is not failing (`states`)

Some blocking checks never fail — they **wait**. An Azure `status` branch policy is
`queued` from the moment the PR opens until something outside the harness posts its
status, and until then `ciStatus` is `pending`, `ciNeedsAttention` is false, no rule
looks at it, and `prAttentionStatus` reads `elsewhere` / "CI still running" forever.
That is the case `states` exists for: the PR is stuck on a command somebody has to
run, and there was no lever to say so.

```json
{ "match": "pr-agent-review*", "states": ["pending"], "onFailure": "dispatch", "guidance": "Run `/pr-agent-review` …" }
```

Three decisions worth stating, because none of them is the only defensible one:

- **`states` scopes the rule; it does not extend it.** Matching is on the
  `(glob, state)` pair, so the rule above claims `pr-agent-review/reviewed` while it
  waits and claims nothing when it goes red — the red one then walks on to a later
  rule, or to the unmatched default (dispatch). One check can therefore carry two
  rules saying different things, which is the only way to express "run the gate when
  it stalls, fix it when it breaks". The cost is that a rule watching only `pending`
  silently stops muting the same check's failures; the CI tab names that, per rule.
- **`onFailure` keeps its name.** It reads narrow now — "on match" is the honest word
  — but it is the action field in every deployed config and in `describeCiPolicy`, and
  renaming a key to improve a noun breaks files in the field in exchange for nothing an
  operator can do differently.
- **A non-failing watch may `dispatch` or `ignore`, never `escalate`.** `loadConfig`
  **throws** on `states` without `failing` combined with `escalate`: the harness has no
  escalation arm for a check that is merely waiting — rule `pr-ci-blocked` asks about a
  _red_ PR whose failures are all held — so the rule could never fire. `ignore` there is
  not idle, because of the expiry default below: it is how an operator mutes a check the
  provider reports as `expired` while leaving that same check's genuine failures on the
  dispatching default, which `states: ["failing", "pending"]` would give up. `passing` is
  refused as a state on the could-never-fire grounds: a check that passed asks nothing of
  anyone.

**One waiting check needs no rule at all.** A check the provider reports as `expired` — an Azure
build-validation policy whose last run predates the branch's commits, so nothing is in flight and
nothing starts on its own — is watched with nothing in `ci.checks` naming it, exactly as an unclaimed
_failing_ check dispatches. Writing `{ "match": "<build>", "states": ["pending"] }` for that case is
the wrong lever and is not needed: it fires equally on a build that is genuinely running, sending an
agent to release a gate that was about to release itself. A rule claiming the check in `pending` with
a non-dispatch action shadows the default, which is how an operator turns it off:

```json
{ "match": "NXG-CI", "states": ["pending"], "onFailure": "ignore" }
```

That is the whole lever for a deployment where required builds expire on **every** push, and the
reason the pending-only `ignore` is legal. Because `states` scopes rather than extends, the rule says
nothing about the same build going red, so the failure still falls through to the dispatching default
and an agent still fixes it — the half `states: ["failing", "pending"]` with `ignore` would destroy.
→ [07](07-pull-requests.md#ci-checks)

The dispatch itself, its own origin, and what stops it looping are rule `pr-ci-gate`'s
— [05](05-dispatcher.md#the-rule-book).

Verdict per PR, not per check — one agent works a branch, so all its failures are
one job:

- **Anything actionable** → one agent on `pr:<n>:ci`, with every matched
  `guidance` appended, and the held checks named so the agent doesn't chase
  them.
- **Anything watched in a non-failing state** → one agent on `pr:<n>:ci-gate`, a
  separate origin with its own attempt cap, ranked below a red build. The waiting
  checks and their guidance are appended to a prompt written for a gate rather
  than for a broken build.
- **Nothing actionable, something escalating** → rule `pr-ci-blocked` asks a human once (held
  by an open item on the same origin, or a recent one in the audit log).
- **Nothing actionable, nothing escalating** → nothing happens. The PR sits red
  and `prHealth` names the failing checks. Re-evaluated every pulse, so it moves
  on its own the moment an actionable check goes red or the held one recovers.

`loadConfig` **throws** on `guidance` or `urgent` attached to a rule that never
dispatches: both are written for an agent that would never be sent, and dropping
them silently is the failure worth catching at boot. It throws on the same grounds
for an empty `states`, an unrecognised state, and a non-failing watch that
`escalate`s — a rule that cannot fire is a rule the operator believes is running.

The resolved policy is readable **from the cockpit** since #244 — the settings modal's CI tab
([17](17-cockpit.md#the-ci-policy-tab)), off `GET /api/ci-policy`
([16](16-http-api.md#get-apici-policy)). It shows the _effective_ routing per rule rather than the
field as written, which is the point: the three defaults above (`ignore` for an omitted `onFailure`,
`['failing']` for omitted `states`, `dispatch` for a check no rule claims) are the whole reason
reading the file is not the same as knowing the policy.

```json
{
  "ci": {
    "checks": [
      { "match": "lint", "onFailure": "dispatch", "guidance": "Run the lint-fix skill; do not touch unrelated files." },
      {
        "match": "e2e (*)",
        "onFailure": "dispatch",
        "guidance": "These are flaky. Reproduce locally before editing test code."
      },
      { "match": "security-*", "onFailure": "dispatch", "urgent": true },
      { "match": "deploy-preview*", "onFailure": "ignore" },
      { "match": "infra-*", "onFailure": "escalate" },
      {
        "match": "pr-agent-review*",
        "states": ["pending"],
        "onFailure": "dispatch",
        "guidance": "Run `/pr-agent-review` on this branch; the gate clears when it posts its status."
      },
      { "match": "NXG-CI", "states": ["pending"], "onFailure": "ignore" }
    ]
  }
}
```

### Item selection (labels, priority, states)

| Key                    | Type                     | Default                                                           | Behaviour                                                                                                                                                                                                                                |
| ---------------------- | ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userId`               | `string` (optional)      | unset                                                             | Who _you_ are to every provider — see [`userId`](#userid). Drives ticket assignment and branch naming, and is who the filters below narrow to. Unset, filed tickets go unassigned and nothing can be filtered.                           |
| `ownWorkOnly`          | `boolean`                | `true`                                                            | Whether the world arrives filtered to `userId` — pickup needs a watch tag you added, and only pull requests you opened are surfaced. A team decision, so it belongs in the project layer. See [`ownWorkOnly`](#ownworkonly).             |
| `labelPrefix`          | `string`                 | `"lubbdubb"`                                                      | Derives the one tag `${prefix}-watch`. Everything is opt-in: an item without it is left alone. An **empty** prefix turns the gate off.                                                                                                   |
| `issuePriorityLabels`  | `Record<string, number>` | `{ 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 }` | Label → weight for pickup ordering. Replaced wholesale by an override.                                                                                                                                                                   |
| `issueStateColours`    | `Record<string, string>` | `{}`                                                              | Tracker state → `#rrggbb` for its chip in the cockpit. Display only. Keys match on letters and digits, so `In Review` and `in-review` are one state. Replaced wholesale by an override; live.                                            |
| `issueBoardStates`     | `string[]`               | `[]`                                                              | Tracker states as the card view's columns, left to right — see [board columns](#board-columns). Display only. Empty = every state the mirror carries, in the facets' own order. Replaced wholesale by an override; live.                 |
| `issueDefaultPriority` | `number`                 | `2`                                                               | Weight for an issue with no matching priority label.                                                                                                                                                                                     |
| `issuePickupStates`    | `string[]` (optional)    | unset                                                             | When non-empty, only items whose provider-native state is listed are eligible. Items with no such state bypass it.                                                                                                                       |
| `issueInReviewState`   | `string` (optional)      | unset                                                             | The state an item is moved to once a PR is open for it. Takes effect only alongside `issuePickupStates`.                                                                                                                                 |
| `issueInProgressState` | `string` (optional)      | unset                                                             | The state an item is moved to once an agent is **working** it. Takes effect only alongside `issuePickupStates`, and is folded into them — see [the in-progress state](#the-in-progress-state).                                           |
| `issueContainerTypes`  | `string[]`               | `["Feature", "Epic"]`                                             | Item types that **hold** work rather than being work. Never picked up, planned or assayed. Matched case-insensitively; `[]` turns the gate off; items with no type bypass it.                                                            |
| `issueFilingTypes`     | `string[]`               | `["User Story", "Bug"]`                                           | The types the harness **creates** at when filing a finding, a blueprint or unrecorded work; the **first** entry is the one it uses — see [what a filed item is](#what-type-a-filed-item-is). Azure only; `[]` falls back to the default. |
| `issueBugType`         | `string` (optional)      | `"Bug"`                                                           | The type a bug an operator raised is filed as. A project on the Basic process sets `"Issue"`. Azure only.                                                                                                                                |

#### Board columns

`issueBoardStates` is the Tickets tab's card view, which draws a column per tracker state
([17](17-cockpit.md#the-tickets-tab)). It is an **order**, and that is the part nothing else in the
harness knows: the state facets carry the words and their counts, `issuePickupStates` is a set, and no
provider reports its process template's column order. Nothing reads this key to decide anything — it
is display only, like `issueStateColours`.

Three behaviours, because each is otherwise a quiet loss:

- **Empty falls back to the state facets**, count descending — the order the State tier already shows.
  A deployment that never configures this gets a working board.
- **A listed state the tracker has nothing in still draws its column, empty.** Naming a column is you
  saying you expect work there; dropping it would make the board disagree with the file you are
  reading, on exactly the day the state went quiet.
- **A state the mirror carries that the list omits gets no column — and the board says so**, naming it
  and its count under the columns. Its items are otherwise on no board at all, and a typo in this key
  would look exactly like a quiet tracker.

#### The in-progress state

The three state keys describe one walk. With `issuePickupStates: ["Ready"]`, `issueInProgressState:
"Doing"` and `issueInReviewState: "In Review"`, a watched Azure work item goes **Ready → Doing → In
Review** under the harness alone: rule `work-item-in-progress` moves it the cycle after an agent is
actually working it, and rule `work-item-in-review` moves it on when a PR opens. Each hop is one
`set_work_item_state` decision naming the rule that made it.

**Do not also list the in-progress state in `issuePickupStates`.** It does not need listing:
`effectivePickupStates` folds it in, which is what keeps an item the harness put in "Doing"
pickup-eligible — an agent that died without opening a PR leaves one there, and it is picked up again
rather than stranded. Listing it as well is still honoured, and still has the hazard it always had:
`deliveryHold` reads the **configured** list, deliberately, because an item in a pickup state means
"a human moved it back, they want it worked" — so an assessed item sitting in a state you listed
lifts its own delivery park and is re-picked. A state the harness wrote is not a human saying
anything, which is why the fold stops short of that one call site.

A process template may forbid a direct transition — "Ready" straight to "Doing" is legal on most, but
not on all. A refused write is recorded as a `rejected` decision and the harness moves on; nothing
escalates, so the symptom is an audit row and a board that does not move.

Both transitions need a provider that can write the state back (Azure). GitHub issues carry no
`workItemState`, so all three keys are a no-op there.

### Feature policies

| Key                                   | Type             | Default                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planning.maxConcurrentPartsPerIssue` | `number`         | `2`                                  | How many parts of one plan may have live agents at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `planning.gitFetchIntervalMs`         | `number`         | `60000`                              | Floor on how often plan reconciliation runs `git fetch`. `0` = every pulse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `validation.desktopClaimMinutes`      | `number`         | `60`                                 | How long a desktop claim holds a check unreleased. A claim normally goes when the session's socket closes or the check is reported; neither survives a harness killed in between, and a stale claim blocks the fleet from a check nobody is running.                                                                                                                                                                                                                                                                                                                                                                                  |
| `validation.desktopSocketPath`        | `string`         | `<tmpdir>/lubbdubb/mcp-desktop.sock` | Where the desktop bridge connects. **Stable, not per-pid** — that is what lets the MCP server be registered in Claude Code once instead of per run. The cost is that two harnesses on one machine want the same path, so the channel refuses a _live_ socket rather than unlinking it the way the fleet's does — and since the channel is unconditional, the second harness on a machine is the case this key exists for. → [11](11-mcp-tools.md#transport)                                                                                                                                                                           |
| `validation.desktopCredentialPath`    | `string`         | `~/.lubbdubb/desktop.json`           | Where the credential is written, `0600`. A **path**, not a secret — the token inside is minted at every start, which is the point: it keeps the token out of the registration an operator pastes, and out of `ps`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `validation.desktopSkillPath`         | `string`         | `~/.claude/skills/lubbdubb/SKILL.md` | Where the skill is installed. Rewritten from scratch on every start, on every deployment — there is no setting that keeps a hand-edited copy, and the file says so in its own body.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `localRun.instruction`                | `text`           | `''`                                 | What the session bringing the machine's dev environment up is told, verbatim — the command, how long it takes, where it lands. **Empty means nothing is startable**, and the panel says so rather than offering a control that refuses. Free text rather than a command because the machine that can start a deployment is the one with the operator's own tooling on it: `/dev-environment start` is a Claude Code command, not a shell one. **Live** — an edit applies to the next start, which is the whole reason it is a config field and not a prompt override. → [23](23-local-runs.md#the-instruction-is-config-not-a-prompt) |
| `localRun.stopInstruction`            | `text`           | `''`                                 | What the session taking the environment back down is told. A second field rather than a signal, because **a dev environment is not a process tree**: reaping the session's subtree takes the session and its own children and cannot touch a Docker container, which belongs to the daemon. **Empty means a stop kills the session and no more**, and the panel says so rather than implying it took the environment with it — a supported state, since plenty of projects are one process. **Live.** → [23](23-local-runs.md#stopping-is-a-turn-not-a-signal)                                                                        |
| `localRun.url`                        | `string`         | `''`                                 | Where the application lands once it is up, drawn as a link beside the run. Declared rather than detected: matching a URL in output whose shape is every framework's own is wrong often enough that a dead link beside a working run is the likelier outcome. Frozen onto the row at each start, so a later edit does not rewrite what a past run reported. **Live.**                                                                                                                                                                                                                                                                  |
| `spendBurn.enabled`                   | `boolean`        | `true`                               | The live burn watch. On by default because it spends no agent and gates nothing. Off files nothing and **still settles rows already standing**, so turning it off drains the bench.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `spendBurn.multiple`                  | `number`         | `4`                                  | How many times its bucket's median a live run may reach before it surfaces. Must be above `1`. Generous on purpose: the spread inside one rule-and-profile bucket is real work, not noise.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `spendBurn.minimumRuns`               | `number`         | `5`                                  | Settled, measured runs a bucket needs before its median is trusted at all. Below it the bucket is silent rather than guessed at.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `spendBurn.floorUsd`                  | `number`         | `1`                                  | Absolute money a run must **also** have spent, so four times the median of a rule that costs pennies is not an alarm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `runway.enabled`                      | `boolean`        | `true`                               | The runway watch (`src/supply/runway.ts`). On by default on the burn watch's terms: it spends no agent and gates nothing. Off files nothing and **still settles rows already standing**, so turning it off drains the bench. → [25](25-supply.md)                                                                                                                                                                                                                                                                                                                                                                                     |
| `runway.warnHours`                    | `number`         | `1`                                  | Hours of queued work below which a `supply` row is filed. Roughly one goal on a three-wide fleet: late enough that a fleet dipping between goals never trips it, early enough to triage before a slot goes empty.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `runway.clearHours`                   | `number`         | `3`                                  | Hours a standing row must be back **above** before it settles. Must exceed `warnHours`, and the loader refuses anything else: at or below it the notice does not fail, it flaps — filed and settled on alternate pulses.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `runway.minimumRuns`                  | `number`         | `5`                                  | Completed goals before their median lead time is trusted. Below it the reading is `unknown` rather than guessed at — but only on the arms that need a duration: `starved` and `dry` are observations about right now and report on a deployment with no history at all.                                                                                                                                                                                                                                                                                                                                                               |
| `spendBurn.ceilingUsd`                | `number \| null` | `null`                               | A flat per-run ceiling that fires with no history whatever — the arm for a deployment where the first runaway is also the first run. `null` = no such arm, because the right number is a property of your work and nothing here can guess it.                                                                                                                                                                                                                                                                                                                                                                                         |

| `selfUpdate.enabled` | `boolean` | `true` | Whether the harness checks its **own** build for updates. Off means no check, no gauge and no upgrade route — the behaviour before this existed. |
| `selfUpdate.remote` | `string` | `"origin"` | The remote the install directory's updates come from. |
| `selfUpdate.branch` | `string` | `"main"` | The branch on it that releases land on. **Not `defaultBranch`**, which is the _worked_ repo's integration branch and a different repository's. |
| `selfUpdate.checkIntervalMs` | `number` | `3600000` | A floor on how often the remote is touched, not on how fresh the served answer is: the reading is held in memory and served from there in between. |

#### `selfUpdate`

The one config group that is not about the repository the fleet works on. It watches the directory
LubbDubb is **installed** in, resolved from the running module rather than from `repoRoot` — the two
coincide only when the harness is dogfooding itself, and a deployment working on another codebase
still wants to hear that its own build moved. There is deliberately no key pointing the watch at an
arbitrary path; only the remote and branch it tracks are configurable, because a fork tracks
somewhere else.

Cheap by construction: the steady state is one `ls-remote` an hour, which transfers no objects. Full
behaviour, including the drain and the handoff, is [21](21-self-update.md).

#### `spendBurn`

Every other cost reading is a post-mortem. This one is taken while the money is still being spent: a
live run is compared against the median of settled runs of **its own kind of work** — the dispatch
rule _and_ the profile, since a pinned goal legitimately costs several times the same rule on a cheap
profile — and one far past that becomes a `burn` human task.

It **holds nothing and kills nothing**. An expensive run is not a wrong run, and no threshold can
tell the two apart; the notice is the prompt to open the transcript and decide. It refreshes its
figures every pulse and settles itself when the run ends.

Three gates must hold together (`multiple`, `minimumRuns`, `floorUsd`) because a multiple on its own
fires constantly. A policy that would file constantly — a `multiple` at or below 1, a `minimumRuns`
of 0 — is refused at load, naming the key. **PTY mode reports no usage**, so nothing there can ever
trip the watch. → [18](18-observability.md#the-burn-watch)

### Agent launch

| Key                       | Type                            | Default                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentMode`               | `'stream' \| 'pty' \| 'raw'`    | `'stream'`              | Which runtime launches agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `claudeCommand`           | `string`                        | `'claude'`              | The command spawned for an agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `claudeArgs`              | `string[]`                      | `[]`                    | Extra args, appended **after** the harness's own, so an explicit flag there has the last word.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `agentPermissionMode`     | `string`                        | `'acceptEdits'`         | Passed to `--permission-mode`. `acceptEdits` auto-accepts file edits only. `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agentModels`             | `AgentModels` (optional)        | unset                   | Which model each kind of work runs on and how hard, keyed on the dispatch rule that proposed it (issue #321). Named profiles, a `default` and per-rule assignments; resolved once at dispatch and stored on the task. Omitted, no launch carries `--model` or `--effort`. See [Model assignment](#model-assignment-by-rule) below and [10](10-agent-runtimes.md#launch-arguments).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `agentAllowedTools`       | `string[]`                      | JS toolchain + git + gh | Tool allow rules merged into `--settings` as `permissions.allow` (Claude Code syntax, e.g. `Bash(npm:*)`). Pre-approves the mechanical validate/commit/push commands so the default config completes a task unattended without `bypassPermissions`. Never on `--allowedTools` (that carries the MCP grants). Default: `Bash(npm:*)`, `Bash(npx:*)`, `Bash(pnpm:*)`, `Bash(yarn:*)`, `Bash(node:*)`, `Bash(git:*)`, `Bash(gh:*)`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `agentPromptDelayMs`      | `number`                        | `1200`                  | Delay before the first message is delivered, giving an interactive REPL time to boot. Stream mode uses `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agentSubmitDelayMs`      | `number`                        | `60`                    | PTY only: gap between writing message text and writing the submitting carriage return.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `agentIdleWaitMs`         | `number`                        | `90000`                 | PTY (real TUI) only: park a session as waiting after this long with no terminal output. `0` disables. Unlatched — output un-parks it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `agentWaitingPatterns`    | `string[]`                      | `[]`                    | Extra literal substrings a PTY session treats as "waiting for input".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `agentStallNudges`        | `number`                        | `2`                     | How many times an agent that ends a turn with **no** sentinel in it is asked to account for itself before the stop is put to a human. A whole-life budget per agent; `0` parks on the first one. Stream runtime only — the PTY runtime has no turn boundary and parks on silence instead. → [10](10-agent-runtimes.md#the-unannounced-stop)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agentStallParkMs`        | `number`                        | `300000`                | How long that park stands in front of a person before the harness records the agent `done` itself — the click the operator was almost always going to make, made for them. The card is filed either way and draws the countdown; `agentStallExtendMs` is how they disagree with it. Nothing it does is irrecoverable: the branch, the commits and the pull request are kept, and the worktree _lease_ is released rather than the checkout deleted. `0` leaves the park standing until somebody acts on it. → [10](10-agent-runtimes.md#when-nobody-answers-the-stop)                                                                                                                                                                                                                                                                                                         |
| `agentStallExtendMs`      | `number`                        | `900000`                | What one press of the card's Extend adds to that countdown, from _now_ rather than from the deadline — the operator is making a claim about their own clock, not the agent's. → [10](10-agent-runtimes.md#when-nobody-answers-the-stop)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `agentSilenceParkMs`      | `number`                        | `1800000`               | Stream runtime only: how long a session may produce **no output at all** before the harness parks it and starts the same countdown. The endings above are read off a turn _ending_, and an agent wedged _inside_ a turn reaches none — it holds a worktree and a slot until somebody notices, with nothing red. Long by design: every byte on stdout re-arms it, so the window is the longest a legitimate step may take without a word, not an operator's window to disagree. `0` disables it. → [10](10-agent-runtimes.md#the-wedge-an-agent-that-never-reaches-a-turn-boundary) |
| `agentResumeAttempts`     | `number`                        | `3`                     | How many times a live agent whose process dies mid-run is re-attached to its own session before it is settled as `failed` (issue #318). Counted on `agents.resume_attempts`, so the budget spans the agent's whole life and survives a restart. `0` disables auto-resume; ignored by runtimes that cannot resume.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `knowledgeBlockChars`     | `number`                        | `6000`                  | How many characters of the fleet's **injected knowledge** ride in every agent's system-prompt append (#27 phase 3). Characters, not a count of claims: the cost bounded is context, and a claim runs from a line to 2,000 characters. Over it, whole facts are dropped so the newest-vouched survive, and notices survive first — never a truncated claim. `0` disables rendering entirely, and then the argv is byte-identical to a build without the feature. The agent is told how many claims it is not carrying and which tool asks for them; you see which, per row and against the budget, on the cockpit's Knowledge page. Replaced `lessonBlockChars`, which is now a retired key — a promoted lesson is mirrored into the knowledge base and rides this block. → [10](10-agent-runtimes.md#the-knowledge-block), [27](27-knowledge.md#delivery-two-prompts-not-one) |
| `knowledgeScopeStaleDays` | `number`                        | `30`                    | How many days a `check:` scope may go without matching anything before the cockpit's Knowledge page draws it as a check that probably no longer runs (#27 phase 7). A **reading and never a trigger**: nothing is demoted, lapsed or dropped from a prompt by it. Derived from records the harness already holds — the dispatches it made and the checks the provider is reporting — rather than from a new write path, because the failure it surfaces is silent non-delivery and a recorder that stopped writing would reproduce it. A check the world still reports is never stale, and a claim younger than this window cannot be. `0` turns the reading off. Live: takes effect on the next poll, no restart. → [27](27-knowledge.md#scope--who-it-is-relevant-to)                                                                                                       |
| `mcpArgsRetentionDays` | `number` | `14` | How long a recorded MCP call keeps its **arguments**, in days. The call row itself is never dropped — only the arguments go, which is the whole shape of the decision: a row without them is about eighty bytes, so every count on the Insights MCP tab stays exact at every window the page offers (`all` included), where an aggregate rolled up at some grain would fix today what a later reading may ask. What actually grows without bound is the arguments (a submitted plan document is tens of kilobytes), and they are also the only part of the row carrying issue text and code — which is why this is an operator's setting rather than a constant. `0` records **no** arguments at all rather than recording and then clearing them: the setting is the off switch, not the sweep. Lowering it is retroactive — the next sweep clears everything already past the new bound. Live in the sense that matters: the servers read it per call. → [14](14-persistence.md#mcp-calls), [11](11-mcp-tools.md#what-is-recorded) |
| `whitelistedApprovals`    | `{match, response}[]`           | `[]`                    | Waiting prompts containing `match` are auto-answered with `response` instead of escalating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sessionTranscriptRoot`   | `string` (optional)             | `~/.claude/projects`    | Where Claude Code writes session transcripts, which PTY mode tails. Override only if the agent runs under a different HOME.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docsFolderPrefix`        | `string \| string[]` (optional) | unset                   | Folder(s) whose files are promoted to artifact chips regardless of extension. Absolute entries also widen the artifact-serving boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Model assignment by rule

Planning an issue and triaging a red CI check are not the same problem, and before issue #321 the
only lever that could say so was `claudeArgs` — fleet-wide and all-or-nothing. `agentModels` assigns
a model per _kind_ of work:

```json
{
  "agentModels": {
    "profiles": {
      "fast": { "model": "haiku", "rank": 1, "description": "Mechanical, well-specified work." },
      "standard": { "model": "sonnet", "effort": "medium", "rank": 2, "description": "Ordinary feature and bug work." },
      "deep": { "model": "opus", "effort": "medium", "rank": 3, "description": "Work whose shape is unclear." }
    },
    "default": "deep",
    "byRule": {
      "pr-ci-gate": "fast",
      "issue-retro": "fast",
      "issue-assess": "standard",
      "pr-base-update": "fast",
      "pr-base-update-conflict": "deep"
    }
  }
}
```

- **The key is a `DISPATCH_RULES` id.** That id is already persisted on `Task.rule` and is already the
  axis `src/taskTypeSpend.ts` prices work by, so config, spend and the decision log share one
  vocabulary rather than growing a second. → [05](05-dispatcher.md#the-rule-book)
- **The rule id is the whole grain, so a rule with two costs is two rules.** The last pair in the
  example is the case: `pr-base-update` merges a base the provider has already called clean, and
  `pr-base-update-conflict` resolves a conflict by hand. They were one id over one predicate's two
  arms, and one id has one profile — so a deployment that wants a deep model on conflicts was buying
  one for routine base merges too. On a provider with no `update_pr_branch` endpoint (Azure DevOps has
  none) that is not hypothetical: the cheap arm dispatches an agent as well, and both were priced
  together. Splitting the id is the mechanism this file offers for that; the two still share one
  cooldown origin, because the split is about price, not about accounting.
  → [05](05-dispatcher.md#pr-base-update--two-arms)
- **A rule points at a named profile, and a profile is a model and the depth it runs at.** The
  indirection buys a name (`deep`, `fast`) that survives a model being replaced: when a new model
  ships, one profile value changes and every rule pointing at it follows. A profile deliberately
  carries nothing else — no permission mode, no extra args. `claudeArgs` stays the single global
  escape hatch, which structurally removes the risk of a profile's args clobbering the
  `--allowedTools` MCP grants; both fields a profile does carry are flags the harness emits itself,
  which is what keeps them out of that argument.
- **The two fields resolve together, as one profile.** A lookup that fell back for the model and not
  the effort could pair a cheap model with a depth chosen for an expensive one, so `resolveAgentProfile`
  returns a whole profile or nothing.
- **A profile also carries a `rank` and a `description`, and both are required.** Neither reaches the
  command line, so neither widens the one-escape-hatch property above. `rank` orders the profiles
  cheapest-first and must be unique: it is what lets the goal-profile gate say whether a proposal is
  _cheaper_ or _deeper_ than what is standing, and what orders the cockpit's dropdowns. Declaration
  order was the alternative and is not one — a key's position in a JSON object is not a value, and
  reordering the block would silently re-rank the fleet. `description` is the whole of what the
  assayer is told about a deployment's profiles when it proposes one, so it is written as
  instructions to an agent about when to pick this profile rather than as a note to the operator.
- **`effort` is optional, and omitting it is not the middle setting.** `claude --effort` takes
  `low`/`medium`/`high`/`xhigh`/`max`, and the CLI's own default is the top of that ladder — so an
  unassigned rule is the _expensive_ one, not the neutral one. This is the argument for setting
  `default`: a policy that covers only some rules leaves the rest at the CLI's default depth.
  A profile that omits `effort` passes no flag, which is what the smallest models need — they refuse
  the flag outright, so a cheap model and a shallow depth are alternative levers, not composable ones.
- **The model string and the effort level are both unvalidated.** Only the installed `claude` knows
  which models exist and which of them accept `--effort`, so either being wrong fails at _spawn_ — as
  a failed agent — rather than at boot.
- **`default` covers every rule with no `byRule` entry, and every run dispatched outside a rule.** An
  operator who sets only this has moved the whole fleet with one line. Omitted, an unassigned rule
  carries neither flag.
- **The whole block is optional.** Omitted, neither flag is ever passed and argv is exactly what it
  was before the key existed.
- **It merges whole**, not field by field like the policy blocks: an override that sets `agentModels`
  replaces it, which is what lets one _remove_ an assignment rather than only add to it. It also means
  a partial block is the whole policy — an operator who writes only `profiles` and `default` has
  cleared every `byRule` entry they were copying from, rather than adding to them.

Every rejection at load is by `validateAgentModels`, in `src/agents/modelPolicy.ts` — a pure function called
from `loadConfig` (not only `loadDeploymentConfig`, or no test could reach it):

- a profile written as a bare model string — the shape before profiles carried an effort. Accepting
  both would leave one config key with two spellings, which is the drift the named profile exists to
  end; refusing it by name stops a deployment on the old shape at boot, with the fix in the message,
  rather than starting it with a profile the resolver reads as having no model;
- an `effort` that is not one of the five levels, which would otherwise reach the CLI as a flag value
  it rejects — at spawn, per agent, rather than once at boot;
- a missing or non-numeric `rank`, a missing or empty `description`, or two profiles sharing a rank.
  The first two are refused rather than defaulted because both have a _silent_ wrong answer available:
  an inferred rank reads as a deliberate ordering, and an empty description makes every assay proposal
  a guess that looks exactly like a judgement. A shared rank is refused because "deeper or cheaper
  than what is standing" then has no answer;
- a `default` or `byRule` value naming a profile that is not in `profiles`, which would otherwise
  launch with no flag and read as working;
- a `byRule` key that is not a **pipeline** rule id. Validated against `DISPATCH_PIPELINE` rather than
  the whole registry: the `admission` and `terminal` entries (`cooldown-escalate`, `idle`) never reach
  `action.rule`, so accepting one as a key would make the typo check weaker than it looks. A key that
  can never match is the failure class the config rejections exist to prevent.

#### No policy ships, and unset is not a default model

The harness ships **no `agentModels` block**. `lubbdubb.config.example.json` carries a worked one —
that file is the discovery surface for every other knob, and a mechanism nobody is told about is the
defect issue #335 opened on — but it is an example to copy and edit, not a default in force.

The reason is that a shipped default would have to name model strings, and the harness cannot check
one: only the installed `claude` knows which models this deployment has. A wrong alias in a shipped
default fails at **spawn**, as a failed agent on a deployment that configured nothing and changed
nothing — precisely the invisible failure class the rest of this document exists to avoid. An
operator who copies the example is choosing those strings, and owns them.

So `resolveAgentProfile` returning `null` is a **meaningful value**, and it is not "the default
model". It means _pass no flag_, and leave the choice to the CLI. The two are different in a way that
matters for cost: the CLI's own effort default is the top of the ladder, so an unconfigured fleet is
not sitting in the middle of the range — it is at the expensive end of it, which is the observation
that motivates configuring the block at all.

Resolution happens **once, at dispatch** (`ActionExecutor.recordDispatchTask`), and the resolved
_strings_ are stored on the task as `model` and `effort`, beside the `profile` name they came from and
the `profileSource` that names which level of the chain below answered — see
[10](10-agent-runtimes.md#launch-arguments) and [14](14-persistence.md).

### Pinning one goal to a profile

`byRule` prices work by **kind**, which is right as the default axis — it is the vocabulary
`Task.rule`, the decision log and `rollUpTaskTypes` already share. It has no answer for the case an
operator actually hits: _this issue is harder than the rule it arrived on._ Editing config moves every
`issue-pickup` in the fleet, which is both too big and too slow to be the answer to one hard ticket
(issue #342).

The answer is a **tag on the ticket**:

```
${labelPrefix}-model-<profile>
```

written through `connector.setIssueLabel` — the same seam, and the same gesture, as the watch toggle,
so Azure DevOps needs no separate answer. Writing one clears the others.

The chain a dispatch resolves through is then three levels, in `resolveAgentProfile`:

| Level     | Where it comes from                            | `Task.profileSource` |
| --------- | ---------------------------------------------- | -------------------- |
| pin       | the plan part's `profile`, else the goal's tag | `pin`                |
| `byRule`  | the dispatch rule that proposed the run        | `rule`               |
| `default` | the fleet-wide fallback                        | `default`            |
| —         | nothing configured: pass neither flag          | (null)               |

- **The pin is keyed on the origin, never on the run.** That is what keeps `resolveAgentProfile` pure:
  a retry runs the same profile, a re-dispatch resolves the same one, and a boot-resumed agent
  re-launches on what its task row stored. Escalating on attempt count would break all three, and is a
  separate argument — see [10](10-agent-runtimes.md#launch-arguments).
- **It wins in both directions.** A pin is not an escalation; the same mechanism pins one noisy goal to
  the cheapest profile. The word is _pin_, not _bump_, for exactly that reason — you name a profile,
  not a direction.
- **It reaches every dispatch on that issue's origins, with two carve-outs.** `issue-retro` runs on its
  `byRule` entry whatever the goal is pinned to: a retrospective **gates nothing**, so inheriting a deep
  pin is real money on a write-up no dispatch reads. `issue-assay` runs on its own entry because it is
  the stage that _produces_ the pin. Both are declared in `UNPINNED_SUFFIXES` in `src/profilePin.ts`.
  Nothing outside the `issue:<n>` subtree is pinned at all, so the CI and review rules on a pull request
  the work produced resolve on `byRule` — following a pin down that lineage is a second mechanism.
- **A tag naming no configured profile is ignored, and never parks anything.** Config is the operator's
  own file and is refused at boot by name; a label is typed on a ticket by a human the harness cannot
  refuse, so the only choices are falling back to the rule's entry or parking a watched issue over a
  typo. `resolveModelTag` falls back and reports the tag it ignored, which the cockpit draws. Two valid
  tags resolve to the **deeper** one — ranks are unique, so there is always an answer, and quietly
  taking the cheaper of two is the failure that reads as ordinary output.
- **A plan may name a profile per part**, which beats the goal's pin for that part alone. The planner
  writes it, because it is the stage that just cut the decomposition and knows which part is the hairy
  one; the cockpit can override it. Clearing a part's profile is not the same as naming the goal's:
  a cleared part _inherits_, so re-pinning the goal later moves it too.
- **Nothing needs enabling.** Pins are on wherever `labelPrefix` and `agentModels.profiles` are both
  set, and off — completely, with no control drawn — where either is missing.

#### The gate: the assayer proposes, a human confirms

`assay_issue` asks the assayer for a profile alongside its `workable`/`unclear` verdict, enumerating
this deployment's own profiles with their descriptions. The assayer is the right author because it is
the only stage that reads the ticket against the repository **before** anything is spent, and it is
already dispatched in front of every fresh issue. It necessarily runs on its own `byRule` entry.

Naming the operator's profiles directly, rather than an abstract difficulty scale, deletes the
`byDifficulty` mapping table a scale would have needed — and the mapping is exactly where the meaning
would be lost, since an operator who splits `deep` into two knows what the two are for and a fixed
vocabulary cannot be told.

**A proposal that differs from what is already standing holds the funnel** until a human answers it,
as a second arm on `assayHold` — see [06](06-issue-pickup.md). Blocking rather than informing, for the
reason the `unclear` arm blocks: informing is what the cockpit already does for every verdict, and the
dispatch the gate exists to price correctly would happen anyway. What makes it safe is what makes the
first arm safe:

- **An absent proposal holds nothing.** An assayer that crashes, is killed, spends its attempt cap or
  simply names no profile leaves the issue to the funnel it would have entered anyway, on its rule's
  own entry. So does every `unclear` verdict — a goal nobody could start from has no work to size.
- **Agreement holds nothing, and costs no click.** The divergence is decided **once**, where the
  proposal is written and the ticket's tag and the operator's config are both in hand
  (`AgentManager.recordAssay`), and a proposal that matched what was standing is stored already
  answered. So the gate itself is a two-field read with no config threaded into it, and no caller can
  forget a lookup and gate the whole fleet by accident.
- **The answer is recorded, not the choice.** The operator's click writes the tag _and_ stamps
  `issue_assays.profile_answered_at`. What was chosen is the tag; a second copy of it on the row would
  be free to drift. This is also why "keep mine" works — the tag goes on deliberately disagreeing with
  the assayer, and a gate that re-read the disagreement would ask the same question for ever.
- **It does not expire on world signal**, unlike the `unclear` arm. A comment or a link is how a human
  answers "I could not act on this goal"; it is not how they authorise spending more than the rule
  allows. Three things end it: the operator answering, the ticket being rewritten (a new fingerprint,
  so a re-assay proposes against the current text), and `clearAssay`.

The tag therefore holds the **resolved answer**, not an operator override sitting beside an inferred
one — which is what collapses the precedence chain to one lookup at dispatch. Who decided is still
answerable: the assay row keeps what was proposed, and a difference between it and the tag is a human
having intervened.

### Provider targets

| Key                                           | Type                            | Default   | Behaviour                                            |
| --------------------------------------------- | ------------------------------- | --------- | ---------------------------------------------------- |
| `integrations.sourceControl`                  | `'fake' \| 'github' \| 'azure'` | `'fake'`  | Who supplies pull requests.                          |
| `integrations.issues`                         | `'fake' \| 'github' \| 'azure'` | `'fake'`  | Who supplies issues / work items.                    |
| `github.owner`, `github.repo`                 | `string`                        | unset     | Required when any capability uses `github`.          |
| `azureDevOps.organization/project/repository` | `string`                        | unset     | Required when any capability uses `azure`.           |
| `azureDevOps.filters.workItemTag`             | `string` (optional)             | unset     | Only surface work items carrying this tag.           |
| `azureDevOps.policyChecks`                    | kind → mode map (optional)      | see below | Which branch-policy kinds become CI checks, and how. |

### `userId`

**Who you are, to every provider the harness talks to.** One string, and the only place the harness
is told whose name to act under.

It replaced six keys that were all the same fact spelled per provider and per use —
`issuePickupRequireOwnLabel`, both `defaultAssignee`s, both `filters.prAuthor`s, and
`filters.workItemAssignedTo`. What it did **not** replace, and briefly did, is the decision of
whether to filter by it. That is `ownWorkOnly`, and the line between the two is
**attribution against filtering**.

| Gate           | Key                          | What it does                                                                                        |
| -------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| **Assignment** | `userId`                     | Tickets the harness _files_ are assigned to you.                                                    |
| **Naming**     | `userId`                     | Branches it opens are named as yours.                                                               |
| **Ownership**  | `ownWorkOnly` **+** `userId` | `${labelPrefix}-watch` only counts if **you** added it, so nobody else can tag work onto the fleet. |
| **Authorship** | `ownWorkOnly` **+** `userId` | Only pull requests you opened are surfaced — which is also what lets a merged branch be reaped.     |

**One string rather than one per provider**, though a GitHub login and an Azure UPN are different
identities. One project is worked at a time and each project carries its own `lubbdubb.config.json`,
so the identity that is correct is whichever provider `integrations` selects: a login where that is
`github`, a UPN where it is `azure`. Only one is ever in force, so there is nothing for a second key
to disagree with.

**Unset, filed tickets go unassigned and nothing can be filtered to you** whatever `ownWorkOnly`
says — a filter needs somebody to filter _to_. That is the `fake` provider's posture, which resolves
no identity at all, and it is why the key is optional in the type rather than required: a harness that
demanded one could not boot against the mock it ships with. Every real deployment is told about it
instead, as one outstanding check on the Setup reading ([26](26-setup.md)) — where a missing identity
is a row with the resolved login on a button, not a refusal to start.

### `ownWorkOnly`

**Whether the world arrives filtered to you.** A boolean, defaulting to `true`, and the other half of
the identity split above.

The two are separate because they answer different questions and belong to different people. Identity
is personal and lives in an operator's own `lubbdubb.config.json`; whether a project filters by owner
is a **team** decision and belongs in the `lubbdubb.project.json` they commit
([the project layer](#the-project-layer)). Folded into one key — which is exactly what
`userId !== undefined` was — a team could not state the policy without every member's login, and an
operator could not say who they were without turning the filters on.

Both halves are read together in one place, `filterToViewer` (`src/integrations/registry.ts`), which
answers who the world is narrowed to at fetch time or `undefined` for nobody. Assignment and branch
naming deliberately do not come through it: **if the harness files it, it is yours**, whatever the
project chooses to show you.

**The default is `true` so the split is invisible on upgrade.** A deployment carrying `userId` keeps
the gates it already had; one without keeps them off, because a filter needs an identity. Neither
changes behaviour on the boot somebody takes the build, which is the whole reason the default is not
`false`.

That default **is** the migration, and there is no other. Nothing is written into an operator's file
to say so: an absent key already means `true`, so a rewrite would only add a line stating what was
already the case — and a config migration that edits files is a migration that can be run twice, or
half. `test/ownWorkOnly.test.ts` holds the claim against the pre-split file shapes rather than
asserting it here, because "we chose a default that makes this a no-op" is only true while the
default says so.

**On with no identity is not refused at load.** It is a coherent thing to have written and an
incoherent thing to run, but refusing it would make the shipped mock unbootable and would gate a
harness that is otherwise fine — so it is said in the reading instead, in the operator's words. That
is the same "an offer, never a gate" line [26](26-setup.md) draws for everything else about
configuration.

**Turning it off is also the escape hatch for a provider that cannot attribute labels.** The
ownership gate reads `labelsAddedByViewer`, and a provider that never populates it resolves every
issue's labels to `[]` — so nothing is ever picked up and nothing errors ([06](06-issue-pickup.md)).
Before the split the only way out was unsetting `userId`, which silently gave up ticket assignment
too. Now it is one key, and the Setup reading offers it as a fix on exactly the reading that detects
it: watched items exist, and none of them are yours.

#### How assignment reaches the ticket

It is passed to the create (`ticketAssignee`, `src/ticketAssignment.ts` →
[`createIssue`](15-integrations.md)), and each provider spells it in its own vocabulary — `assignees`
on GitHub, `System.AssignedTo` on Azure — on the **create itself**, so a filed item is never briefly
in nobody's queue.

It used to be a `--assignee` / `--assigned-to` flag spliced into the `gh`/`az` command the filing
prompt carried, followed by a paragraph saying the flag was not optional. Those three sentences existed
because an agent editing the command down drops a flag first;
[#394](13-jobs-and-tickets.md#filing-a-ticket) removed the command, so there is no longer a sentence
to forget.

Assignment applies to the four filing arms and to nothing the harness merely reads: it is not a
filter, and it never narrows pickup. The narrowing is the other two gates, and they are separate
mechanisms that happen to share a name.

### What type a filed item is

`issueFilingTypes` names the Azure work item types the harness **creates** at, and the **first** entry
is the one it uses (`filingType`, `src/ticketTypes.ts`). The three non-bug filing arms — a deferred
finding, a blueprint, unrecorded work — used to hardcode `--type Task`, which is the altitude a story
is **broken down** at rather than the one a backlog is filed at: an item created there has no story
above it, rolls up to nothing, and appears on no backlog anybody grooms.

It used to be a menu a filing agent picked from, spliced into a `--type` flag in the create command
the prompt carried. Since [#394](13-jobs-and-tickets.md#filing-a-ticket) the harness files the item
itself, so there is no picker left — and no create that can arrive without a type, which Azure refuses
outright. The remaining entries still document what the project files at, which is what keeps the key
readable; the order is the operator's, so its head is the honest default.

A **raised bug** files at `issueBugType` instead, defaulting to `"Bug"` — its own key rather than a
bug-looking entry picked out of the list, because what a process template calls its bug type is
exactly the thing that varies (the Basic process calls it "Issue") and matching on the word would file
a story as a bug on the one project it is wrong for, with nothing red.

The default `["User Story", "Bug"]` is the Agile template's names, on the reasoning
`issueContainerTypes` already uses; a Scrum project sets `["Product Backlog Item", "Bug"]`, and a
process extended with a custom type puts it first (`["Tech Debt", "User Story"]`). Names are sent to
Azure verbatim, so they must match the project's exactly. Unlike `issueContainerTypes` there is no
"off" — a work item is created _as_ something, so `[]` falls back to the default rather than emitting
a create with no type. GitHub is untouched throughout: an issue is not created _as_ anything, so the
field is dropped there.

### `azureDevOps.policyChecks`

Azure gates a PR with **branch policies**, only some of which are automated checks. Each policy
classifies into a kind — `build`, `status`, `comments`, `workItems`, `reviewers`, `mergeStrategy`,
`other` — and each kind is surfaced in one of three modes:

| Mode       | Effect                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------- |
| `check`    | An ordinary `CiCheck`: visible, routable by a `ci.checks` rule, dispatchable.                |
| `advisory` | Visible, and structurally unable to dispatch or escalate — no `ci.checks` rule can claim it. |
| `off`      | Not emitted, and not acted on.                                                               |

Defaults: `build` and `status` are `check`, `comments` is `advisory`, everything else is `off`. An
unknown kind or mode throws at load. A **disabled** policy is dropped whatever its mode.

The modes are in order of decreasing effect and `off` is the strongest of the three, which takes one
extra thing to be true. `off` drops the check from `ciChecks` — and an **empty** `ciChecks` is the one
input every layer below reads as *the provider reported no per-check detail*, whose right answer is to
act on the red aggregate generically. Left there, `off` would be the only mode that still dispatches:
a code agent on every red pull request, carrying the generic CI-fix prompt, naming no check and
fetching no excerpt, unable to clear a failure it cannot see and ending in a `cooldown-escalate` that
blames the agent. So a build whose every reportable policy is `off` also carries
`PullRequest.ciChecksWithheld`, and the two fallback arms — `ciNeedsAttention` and
`classifyCiFailures` — read it: detail that exists and was withheld is the operator's instruction not
to act, where detail that was never reported is a provider with nothing else to answer from. Nothing
here still reaches `ciStatus`, so the pull request reads as red on the health row exactly as before —
`off` says the failure is not the fleet's to fix, never that it is not there.

`build`/`status` at `check` include **Optional** (non-blocking) policies, which carry
`blocking: false`. Such a check really does fail and an agent really can fix it, so rule `pr-ci-failing` dispatches
for it — while `aggregatePolicyCiStatus` folds enabled, blocking build/status policies only, so
`prHealth`'s blocked verdict and the merge rule are untouched. **No value here can reach `ciStatus`**,
which is what keeps "the harness will fix this" from ever becoming "the PR cannot merge".

`comments` defaults to `advisory` rather than `check` because the harness already models that signal
at higher fidelity: rule `pr-review-comment` acts per unresolved thread, with the author and body in the prompt. As an
ordinary check it would restate the same fact as a second concern on the same PR under a different
origin (`pr:<n>:ci`), carrying the generic CI-fix prompt — the same work with strictly less
information, and a PR that reads as CI-failing for as long as a review is open.

`workItems` is `off` by default, and since the harness started **writing the link itself** that is a
different statement than it used to be. `PrWorkItemDesk` links every pull request the fleet opens to
the work item it opened it for, mechanically, off a row it already holds
([07](07-pull-requests.md#linking-the-work-item)) — so the policy is normally satisfied before it is
ever evaluated, and there is nothing for a check to route. Leaving the kind `off` keeps a gate that
clears itself out of the dispatcher's sight entirely.

Promote it to `check` when you want the policy **visible** as a check on the PR, or when a class of
pull request the harness did not open is expected to fail it. Doing so is now a display choice rather
than an invitation to dispatch, and an `onFailure: "ignore"` rule beside it says so explicitly:

```jsonc
{
  "azureDevOps": { "policyChecks": { "workItems": "check" } },
  "ci": { "checks": [{ "match": "Work item linking", "onFailure": "ignore" }] },
}
```

Routing it to `dispatch` instead puts a code agent on a link the desk is about to write anyway — a
model call and a worktree spent rediscovering a number in the branch name. That was the only way to
clear the gate before the desk existed, and it is what the desk replaced.

No outbound capability is involved: the agent makes the link with a tool it already has, and
`guidance` is the channel that tells it how.

## Secrets

Credentials are **never** read from `Config` or from `lubbdubb.config.json`, so a secret cannot be
committed:

- **GitHub** — the token comes from `GITHUB_TOKEN` only. Selecting `github` without it, or without
  `github.owner`/`github.repo`, throws a clear error at `buildIntegrations` time (boot), not later as
  a network failure.
- **Azure DevOps** — `AZURE_DEVOPS_PAT` (Basic auth) is preferred; if unset, the logged-in `az` CLI
  is used (Bearer, cached). Auth is resolved lazily, so a missing login surfaces as a recorded
  connector error at snapshot time rather than blocking boot. A missing **target** is still a boot
  error. Setup's `credential` check asks **both** routes for the same reason
  ([26](26-setup.md#the-credential-check-asks-both-routes)): with `az login` done and no variable
  set the harness reads everything, and a check that asked only the variable called a working
  deployment unreadable.
- **Model credentials are inherited**, not supplied. Agents spawn with `{...process.env, ...spec.env}`
  plus only `LUBBDUBB_PROMPT`, `LUBBDUBB_TASK_ID`, and the status-file / events-dir variables. In
  non-interactive mode `claude` always uses `ANTHROPIC_API_KEY` when it is present, with no approval
  prompt, so a stray exported key moves the whole fleet onto API billing. The harness never sets one.

## Example

`lubbdubb.config.example.json` at the repo root is a complete, commented example of every key. The
same keys are legal in a project's `lubbdubb.project.json` (all but `repoRoot`), so there is one
example rather than two — what differs between the files is who they belong to, not what they may
say.

It is laid out in the **same six sections the cockpit's Settings tab draws** — Dispatch, Agents,
Integrations, Features, Paths, Server, in that order, from the `GROUPS` list in
`src/server/runningConfig.ts` — with a `"// ===== SECTION ====="` banner between them. One order for
the file and the form, because they are two ways at the same file: a key found in the tab is where
the tab said it was when the operator goes to hand-edit it. A key added to `GROUPS` in a different
place belongs in the same place here.
