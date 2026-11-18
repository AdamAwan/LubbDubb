---
name: extension
description: Write, change or debug this project's LubbDubb extension — the project's own code that LubbDubb calls at named slots (e.g. provisioning a validation tenant, routing or publishing the fleet's pull request review). Use for "/lubbdubb:extension", "make the tenant seeding an extension", "route our reviews in code", "post review findings our way", "LubbDubb refuses to start because of our extension", "add a slot to our extension".
argument-hint: '[what the extension should do]'
---

## Write a LubbDubb extension

An **extension** is one module in **this** project that LubbDubb loads at boot and
calls at named points, **slots**. The project's own logic lives here. LubbDubb
keeps the orchestration around it: when to ask, locks, records, the cockpit. Use it
when a behaviour only this project needs would otherwise have to become a generic
LubbDubb feature switched on by config.

**First, check that an extension is the right tool:**

- One question with a short answer (a commit, an exit code, a JSON line)? A **shell
  command** in config may already do it.
- Giving the fleet's _agents_ new tools? That is an **MCP server**, not an extension.
- Anything else that is the project's own logic (its API, its data, typed answers) is
  an extension. It can only answer slots LubbDubb asks. It cannot add new
  behaviour, read LubbDubb's store, or replace a desk.

### The slots

Today's slots, `apiVersion` **1**:

| Slot              | Asked when                                                                                                                 | Input                                                                            | Answer                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ensureTenant`    | The operator presses prepare on a goal's remote-validation sheet, for an environment with `validate.tenantExtension: true` | `{ environment, tenant: string \| null }`                                        | `{ tenant: "<name>" }` — the tenant you provisioned, one line                                         |
| `reseedTenant`    | Straight after `ensureTenant`, same press                                                                                  | `{ environment, tenant }`                                                        | nothing (`return;`). Throw to fail                                                                    |
| `deployedCommits` | Each probe of an environment with `"atExtension": true`                                                                    | `{ environment }`                                                                | `{ commits: ["<sha>", …] }` — at least one; several for several services                              |
| `appErrors`       | Each errors read of an environment with `"errors": { "extension": true }`                                                  | `{ environment, since }`                                                         | the errors command's report: a list of groups, or `{ groups, query?, queryLink? }`                    |
| `appErrorDetail`  | The triage agent asks for more on one group, same environments; optional                                                   | `{ environment, fingerprint, since }`                                            | `{ text }`                                                                                            |
| `watchReading`    | Each watch query on an environment with `"watch": { "extension": true }`                                                   | `{ environment, source, language, checkId, query, kind, since, until, commits }` | a list of rows, each carrying `lubbdubbWatchId: checkId`; a measure is one row with a numeric `value` |
| `watchExposure`   | Before a watch window is read, same environments, where `watch.exposure` is declared                                       | `{ environment, commits }`                                                       | `{ share }`, from 0 to 1                                                                              |
| `routeReview`     | A pull request is due the fleet's review, with `review.routeExtension: true`                                               | `{ pr: { number, title, branch, base, author, body }, modes, allowSkip }`        | `{ mode, reason }`, or `{ skip: true, reason }`                                                       |
| `publishReview`   | Straight after the reviewer records its review, with `review.publishExtension: true`                                       | `{ pr, headSha, mode, verdict, summary, findings }`                              | `{ thread: "<id>" }` of the thread you posted into, or `{ thread: null }`                             |

- `ensureTenant` must be **idempotent**. `tenant` is the one already stamped, or null the
  first time, so hand it back while it still exists. **Return the name your provisioning
  actually created, never one you made up**: environments that reap tenants by name
  pattern delete invented ones within the hour.
- `reseedTenant` is **optional**, and it **destroys** what is in the tenant. Filling it makes the cockpit's
  control a confirm-twice "Reseed". Leaving it out gives a harmless "Provision".
- The tenant slots time out after **one hour**. The context's `signal` fires when the call times out or fails.
  Pass it to `fetch`, and on abort **kill a child process's whole tree**, not only the child:
  `taskkill /PID <pid> /T /F` on Windows, and on POSIX spawn with `detached: true` and
  `process.kill(-child.pid, 'SIGKILL')`. Killing the direct child alone (which is what passing
  `signal` to `spawn` does) leaves its own children — a tool PowerShell started, say — still running
  against the tenant.
- The reading slots (`deployedCommits` to `watchExposure`) replace a shell command, and
  keep its contract: the same answers, read the same way. They time out after **30
  seconds** (`appErrors` and `appErrorDetail` after one minute). **Throw when you do
  not know.** A throw reads as _unknown_ — a landing stays unconfirmed, an errors read
  or a watch check reads `unknown` — never as "not deployed", "no errors" or "clean".
- `watchReading`'s `query` already has `{since}` and `{until}` filled in, and for `kql`
  the `lubbdubbWatchId` projection appended. Run it as given: a row without the check's
  id is not an answer.
- `routeReview` replaces the triage agent. Answer one of the `modes` you were given; `skip` only
  where `allowSkip` is true. You get the pull request's metadata, never its diff. A failure, or a
  mode not in the list, runs `review.defaultMode` **for good**: that pull request is not asked again,
  so a flaky API costs a more thorough review, never a missing one. Times out after **two minutes**.
- `publishReview` replaces `review.publish`, which must stay `"none"`. Post the findings where your team
  reads them. Return the id of the thread you opened, if any: once it is resolved, the review reads as dealt
  with. A failure leaves the review recorded but not published. It is **asked once**, never retried (a
  restart mid-call drops it), so it never double-posts. Times out after **five minutes**.
- If the slot you need is not here, **do not bend another slot to do it.** Write
  down the question LubbDubb would need to ask, with its input and answer, and
  tell the operator: a new slot is a LubbDubb change. Its repository has an
  `add-extension-slot` skill for that.

### The file

Start from [`starter.ts`](starter.ts) beside this skill. Copy it to, say,
`tools/lubbdubb.extension.ts` and delete the slots you do not fill.

- The default export carries only `apiVersion`, `name` and `slots`. Any other key refuses boot.
- Each slot is `(input, { repoRoot, signal }) => answer`, and may be `async`.
- `.ts`, `.js` and `.mjs` all work. Imports resolve from the file's own folder, so
  it can use the project's own dependencies.
- It runs **inside the LubbDubb process**, with its permissions. Keep the work on
  the slot's input. Throw rather than `process.exit`, and leave no timers or
  listeners behind.
- **Never let a stream or event handler throw.** A `data`, `close` or `exit` handler runs
  outside the slot's own call, often after the slot has already given up: output arriving
  then, written to a file you closed, throws where your `try` cannot catch it. Catch inside
  the handler, and stop writing once the signal has fired. LubbDubb contains such a throw
  (records it and fails the slot if it is still running) rather than crashing, but the work
  it belonged to is left half-done.

### Turning it on

1. List it in **`lubbdubb.project.json`** (the shared project layer):

   ```json
   { "extensions": ["tools/lubbdubb.extension.ts"] }
   ```

   Paths resolve against the repository root. If the operator's own
   `lubbdubb.config.json` sets `extensions`, it **replaces** this list, so it must
   repeat the entry.

2. Opt the feature in. For tenants, each environment that should use the extension
   sets `"validate": { "tenantExtension": true, … }` and drops `tenant`,
   `tenantEnv`, `ensureTenant` and `reseed`. Keeping them alongside refuses boot.
   Environments without the key keep their commands.
   For the review, set `"review": { "routeExtension": true }` (and drop `routingCharterFile`) and/or
   `"review": { "publishExtension": true }` (and keep `publish` at `"none"`).

   For readings, per environment: `"atExtension": true` in place of `at`;
   `"errors": { "extension": true }` in place of `list` and `detail`; and
   `"watch": { "extension": true, … }` in place of `observe`, every source's `observe`
   and `exposure.command` (sources keep their `language` and `runBy`; with no
   `sources`, it is one `kql` source named `logs`). Keeping a command beside its key
   refuses boot.

3. Restart LubbDubb. A loaded extension is named on the boot console. Every problem
   **refuses to start**, naming the file and what is wrong. Nothing is skipped with a
   warning.

### Testing it

- **Unit-test each slot as a plain function**, in the project's own test runner:
  call it with a sample input and `{ repoRoot, signal: new AbortController().signal }`,
  then check the answer's shape against the table above.
- Then boot LubbDubb against a non-production environment and make it ask the slot.
  For tenants, press prepare on a goal's sheet; the tenant panel shows what was asked
  and what came back. For reviews, open a pull request with `review.enabled` on; the
  route's reason and the review row show what your code answered. For readings, opt in one
  non-production environment and let the pulse ask: the environment's deployed commit, its
  errors read and its watch readings show what came back, or `unknown` with your slot's
  failure as the reason.
- A slot that throws, rejects, times out or answers the wrong shape is recorded on
  LubbDubb's error log as `extension "<name>" failed the "<slot>" slot: …`. What happens
  next is the slot's own rule, and it is never the old config path, because that would
  hide that your extension is broken:
  - a tenant press fails;
  - a route falls back to `review.defaultMode`;
  - a publication is skipped, and the review stays recorded;
  - a reading is `unknown` (a landing unconfirmed, an errors read or a watch check
    `unknown`), and asked again next time.

### When it will not start

| It says                                                                        | Fix                                                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `could not be loaded: …`                                                       | A syntax error, or an import it cannot resolve from the file's folder.                         |
| `its default export is not an object`                                          | Use `export default { … }`, not a named export or a function.                                  |
| `it exports "x", which no extension carries`                                   | Only `apiVersion`, `name` and `slots` are allowed.                                             |
| `written for apiVersion N and this harness speaks M`                           | A slot's contract changed. Read the table above again, update the slots, then bump the number. |
| `fills the "x" slot, which this harness does not have`                         | A misspelling, or a slot this version of LubbDubb does not ask.                                |
| `both fill the "x" slot`                                                       | Two extensions answer one slot. Merge them, or drop one.                                       |
| `set "validate.tenantExtension" and no extension fills "ensureTenant"`         | The extension is not listed in `extensions`, or does not fill `ensureTenant`.                  |
| `"validate.reseed" and "validate.tenantExtension" both reseed`                 | Delete the `reseed` command. The extension's `reseedTenant` does it.                           |
| `set "atExtension" and no extension fills the "deployedCommits" slot`          | The same for every reading key: list the extension, and fill the slot it names.                |
| `"at" and "atExtension" are two answers to one question`                       | Delete the command the key replaces. Each reading key refuses the same way.                    |
| `"review.routeExtension" is set and no extension fills the "routeReview" slot` | Fill `routeReview`, or drop the key. Same for `publishExtension` and `publishReview`.          |
| `review.routeExtension and review.routingCharterFile both choose`              | Delete `routingCharterFile`. The extension chooses.                                            |
| `review.publishExtension and review.publish (…) both decide`                   | Set `review.publish` to `"none"`.                                                              |
