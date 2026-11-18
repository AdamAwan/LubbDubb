---
name: extension
description: Write, change or debug this project's LubbDubb extension — the project's own code that LubbDubb calls at named slots (e.g. provisioning a validation tenant). Use for "/lubbdubb:extension", "make the tenant seeding an extension", "LubbDubb refuses to start because of our extension", "add a slot to our extension".
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

| Slot            | Asked when                                                                                                                 | Input                                                                     | Answer                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ensureTenant`  | The operator presses prepare on a goal's remote-validation sheet, for an environment with `validate.tenantExtension: true` | `{ environment, tenant: string \| null }`                                 | `{ tenant: "<name>" }` — the tenant you provisioned, one line             |
| `reseedTenant`  | Straight after `ensureTenant`, same press                                                                                  | `{ environment, tenant }`                                                 | nothing (`return;`). Throw to fail                                        |
| `routeReview`   | A pull request is due the fleet's review, with `review.routeExtension: true`                                               | `{ pr: { number, title, branch, base, author, body }, modes, allowSkip }` | `{ mode, reason }`, or `{ skip: true, reason }`                           |
| `publishReview` | Straight after the reviewer records its review, with `review.publishExtension: true`                                       | `{ pr, headSha, mode, verdict, summary, findings }`                       | `{ thread: "<id>" }` of the thread you posted into, or `{ thread: null }` |

- `ensureTenant` must be **idempotent**. `tenant` is the one already stamped, or null the
  first time, so hand it back while it still exists. **Return the name your provisioning
  actually created, never one you made up**: environments that reap tenants by name
  pattern delete invented ones within the hour.
- `reseedTenant` is **optional**, and it **destroys** what is in the tenant. Filling it makes the cockpit's
  control a confirm-twice "Reseed". Leaving it out gives a harmless "Provision".
- Both time out after **one hour**. The context's `signal` fires when the call times out or fails.
  Pass it to `fetch` and child processes so the work actually stops.
- `routeReview` replaces the triage agent. Answer one of the `modes` you were given; `skip` only
  where `allowSkip` is true. A failure, or a mode not in the list, runs `review.defaultMode`. Times out
  after **two minutes**.
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

3. Restart LubbDubb. A loaded extension is named on the boot console. Every problem
   **refuses to start**, naming the file and what is wrong. Nothing is skipped with a
   warning.

### Testing it

- **Unit-test each slot as a plain function**, in the project's own test runner:
  call it with a sample input and `{ repoRoot, signal: new AbortController().signal }`,
  then check the answer's shape against the table above.
- Then boot LubbDubb against a non-production environment and press the control
  that asks the slot (for tenants: prepare, on a goal's sheet). The tenant panel
  shows what was asked and what came back.
- A slot that throws, rejects, times out or answers the wrong shape is recorded on
  LubbDubb's error log as `extension "<name>" failed the "<slot>" slot: …`, and the
  press fails. LubbDubb never falls back to the old commands, because that would hide
  that your extension is broken.

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
| `"review.routeExtension" is set and no extension fills the "routeReview" slot` | Fill `routeReview`, or drop the key. Same for `publishExtension` and `publishReview`.          |
| `review.routeExtension and review.routingCharterFile both choose`              | Delete `routingCharterFile`. The extension chooses.                                            |
| `review.publishExtension and review.publish (…) both decide`                   | Set `review.publish` to `"none"`.                                                              |
