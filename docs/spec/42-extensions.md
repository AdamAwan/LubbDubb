# 42 — Extensions

`src/extensions/`. **Off by default**: `extensions` is `[]`, and with it empty nothing is loaded and
nothing the harness does changes.

An **extension** is a project's own code that LubbDubb loads at boot and calls at named points, called
**slots**. It is how a behaviour that only one project needs lives _in that project_, while LubbDubb
keeps the orchestration around it: when to ask, the locks, the record, the cockpit.

**Built**: the loader, the host, the `extensions` key, and the two tenant slots
([36](36-remote-validation.md#a-tenant-from-the-projects-extension)). Each further slot is added by
the change that needs it, following [Adding a slot](#adding-a-slot).

## Invariants

- **With `extensions` empty the harness builds and behaves exactly as it does without this feature.** An operator who never opts in is never affected. → [§](#loading) · `test/extensions.test.ts`
- **Every problem with an extension's file or shape refuses boot, naming the file and what is wrong; none is skipped with a warning.** A project's behaviour quietly missing is worse than a harness that will not start. → [§](#loading) · `test/extensions.test.ts`
- **The extensions passed to `buildSystem` must be exactly the ones `extensions` names, or it refuses to build, naming each path that is missing or extra.** It also refuses two with one name or one slot, however they were loaded, and checks before anything else is built. `buildSystem` cannot load (it is synchronous), so a caller that forgot to would otherwise run without the project's code. → [§](#loading) · `test/extensions.test.ts`
- **A slot has at most one owner, and an extension may fill only slots in the book.** Two answers to one question, or an answer nobody asks for, is a misconfiguration that looks like it works. → [§](#loading) · `test/extensions.test.ts`
- **`ExtensionHost.call` never throws.** A throw of any value (even one that cannot be turned into text), a rejection, a timeout or a wrong-shaped answer comes back as `{ ok: false, detail }` and is recorded on the error log; the caller decides what not-ok means. → [§](#calling-a-slot) · `test/extensions.test.ts`
- **Every slot in the book is described to project authors, and the starter they copy loads against it.** The `/lubbdubb:extension` skill is the only place a project learns a slot exists. → [§](#writing-an-extension) · `test/extensionSkill.test.ts`
- **A slot's contract changes only with `EXTENSION_API_VERSION`.** An extension written against the old shape is then refused at boot instead of reading the new input wrongly. → [§](#adding-a-slot) · _no test_

## When to use one

LubbDubb has three ways for a project to bring its own behaviour. Pick the lightest that does the job:

| Way                                                    | Good for                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| A **shell command** in config (`environments[].at`, …) | One question with a short answer: a commit, an exit code, a JSON line.                                 |
| An **extension**                                       | Logic and state the project owns: talking to its own API, deciding from several inputs, typed answers. |
| An **MCP server** the agents are given                 | Giving _agents_ new tools. Claude Code already supports these; LubbDubb needs nothing new.             |

The test for whether something is a slot or a LubbDubb feature: **would a second project need this
exact thing?** If yes, it belongs in LubbDubb. If no, LubbDubb asks a slot and the project answers it.

## The extension file

An ES module whose default export is one object with exactly three keys:

```ts
// in the project: tools/lubbdubb.extension.ts
export default {
  apiVersion: 1,
  name: 'acme',
  slots: {
    // one function per slot this project fills: (input, { repoRoot, signal }) => answer
    ensureTenant: async ({ environment }) => ({ tenant: await provisionFor(environment) }),
  },
};
```

- `apiVersion` must equal `EXTENSION_API_VERSION` (`src/extensions/contract.ts`), today `1`.
- `name` is how the error log and the boot line name it. Unique across loaded extensions.
- `slots` maps a slot name to a function. It may return a value or a promise. It gets the slot's
  input and a context of `repoRoot` and an `AbortSignal` that fires at the slot's timeout.

A `.ts` file works, because the harness runs under `tsx`; so does `.js`/`.mjs`. The module may import
its own dependencies, resolved from its own location.

## Configuration

| Key          | Type       | Default | Behaviour                                                                                                                                                                                           |
| ------------ | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions` | `string[]` | `[]`    | Paths to extension modules, resolved against `repoRoot`. Usually set in `lubbdubb.project.json`, since the code lives in the project. Restart-only. `fileOnly`: each entry runs inside the harness. |

Like every list, the operator's file **replaces** the project's list rather than adding to it
([02](02-configuration.md#precedence)): an operator who sets `extensions` must repeat the project's.

## Loading

`main` calls `loadExtensions` (`src/extensions/load.ts`) with `EXTENSION_SLOTS` after the config
loads and **before** `buildSystem`, because `import()` is asynchronous and `buildSystem` is not. What
it returns is passed in as `opts.extensions`, and `buildSystem` wraps it in an `ExtensionHost` at
`system.extensions`. If `opts.extensions` is not exactly the paths the config names, it refuses to build,
naming each path missing or extra, and refuses two extensions with one name or one slot —
the guard against a caller (a script, a new entry point) that builds a system and silently runs
without the project's code, or with code the config no longer names.

Each of these refuses boot with `Refusing to start: the extension at <path> — <why>.`:

- the module cannot be imported (missing, syntax error, a dependency it cannot find);
- the default export is not an object, or carries a key other than the three;
- `apiVersion` is not this harness's;
- `name` is missing or empty, or another extension already has it;
- `slots` names a slot the book does not have (the refusal lists the ones it does), or a value that
  is not a function;
- a slot another extension already fills.

One rule (`extensionClash`, `src/extensions/contract.ts`) decides a clash — one file twice, one name
twice, one slot twice — for the loader, the `buildSystem` check and the host alike, and its refusal
names the files of the clash it found. A path `extensions` lists twice is also refused earlier, when the config
loads (`validateExtensions`, `src/config/configChecks.ts`), so the operator is told to list it once
rather than that a file was loaded twice. The `buildSystem`-time refusals name their files in their own
words rather than in the `the extension at <path>` form.

There is no warning-and-skip path. Every case above is a project behaviour that would be missing
while the harness looked healthy. Each loaded extension is announced on the console at boot.

## Writing an extension

The project's own developers write the extension, usually with an agent in the project's checkout,
not LubbDubb's. So the guide to writing one ships in [the plugin](11-mcp-tools.md#the-plugin) every
operator's Claude Code already has: `/lubbdubb:extension` (`plugin/skills/extension/SKILL.md`), with a
`starter.ts` beside it that fills every slot. It holds the slots table in an author's terms, the
config to turn one on, how to test it, and each boot refusal with its fix.

Because the skill is a copy of the contract in another form, it is held to it:
`test/extensionSkill.test.ts` refuses a skill whose slots table misses a slot in the book or names
another `apiVersion`, and loads `starter.ts` through `loadExtensions` against the book, so a starter
that no longer loads, or no longer fills every slot, fails the build. A slot the skill does not
describe is one no project can find.

## Calling a slot

A desk asks a slot through `system.extensions` (`src/extensions/host.ts`):

- `provider(slot)` — the name of the extension that fills it, or null. A feature with a built-in
  fallback checks this first and takes its old path when null.
- `call(slot, input)` — `{ ok: true, value }` or `{ ok: false, detail }`. **It never throws.**

On every call the host races the function against the slot's `timeoutMs`, aborts the signal on any
not-ok outcome (a timeout among them), and runs the slot's `check` over the answer. A throw, rejection, timeout or failed check
is recorded through `errors.record` with source `runtime`, and the message names the extension and the
slot. Asking a slot nobody fills is not-ok and records nothing: it is a question, not a failure.

What not-ok _means_ is the calling feature's decision, written in its own spec. It is never "fall back
to the built-in behaviour" by default: an operator who configured an extension expects it to answer,
and a fallback would hide that it is broken.

## Trust

An extension runs **inside the harness process**, with everything the harness can do. That is the same
trust the project file already has: it carries `environments` and `localRun`, shell commands the
harness runs on the operator's machine ([02](02-configuration.md#the-project-layer)). The path is read
from the checked-out working tree at `repoRoot`, so a branch or pull request does not reach it before
it is merged and pulled.

An extension gets the slot's input and the context, never the store or the system. That narrow surface
is what lets the harness change underneath without breaking projects.

## The slots

Each slot is a row here, and links the spec of the feature that asks it.

| Slot           | Asked by                                                                                                                                  | Input                                     | Answer                                      | Timeout |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- | ------- |
| `ensureTenant` | The tenant press, for an environment with `validate.tenantExtension` ([36](36-remote-validation.md#a-tenant-from-the-projects-extension)) | `{ environment, tenant: string \| null }` | `{ tenant }`, a non-blank one-line name     | 1 hour  |
| `reseedTenant` | The same press, after `ensureTenant`; optional                                                                                            | `{ environment, tenant }`                 | nothing (`undefined`); a throw is a failure | 1 hour  |

## Adding a slot

A slot is a promise to every project that fills it. Make it in one change, with all of these:

1. **Name the question, not the mechanism.** `prepareTenant`, not `runSeedScript`. The slot says
   _what_ LubbDubb needs; how is the project's business.
2. **Add its signature** to `ExtensionSlots` and its definition to `EXTENSION_SLOTS`
   (`src/extensions/slots.ts`): `timeoutMs` and a `check` that refuses any
   answer not the promised shape. The extension is untyped JavaScript at runtime, so `check` is the
   only thing between a wrong answer and the harness.
3. **Inputs are plain data.** No store rows, no classes, nothing that changes shape when the harness
   refactors.
4. **Keep the generic part in LubbDubb.** Locks, records, retries, the cockpit and the error log stay
   in the calling desk; the slot answers only the project-specific question.
5. **Decide what not-ok means**, and write it in the calling feature's spec.
6. **Keep the old path, behind an explicit opt-in.** A feature that had a built-in or config-driven
   version keeps it for every deployment that has not opted in, until a later change retires it. One
   object routes each deployment to the old or the extension implementation and answers anything the
   desk labels with it, so what runs and what is shown cannot disagree. Opting in with no extension
   filling the slot refuses to build.
7. **Test both paths** at the `buildSystem` seam: with an extension filling the slot (a temp `.mjs`
   file, as `test/extensions.test.ts` does) and without.
8. **Add a row to [The slots](#the-slots)** and update the calling feature's spec.
9. **Teach it to project authors**: a row in the `/lubbdubb:extension` skill's slots table, and the
   slot in its `starter.ts` ([Writing an extension](#writing-an-extension)). The build refuses
   either missing.

Changing an existing slot's input or answer — anything an existing extension would read wrongly — bumps
`EXTENSION_API_VERSION`, so old extensions are refused at boot with a message naming both versions
rather than misreading their input. Removing a slot does the same thing for free: an extension that
fills it is refused, naming the slots that remain.

## What it is not

| Not                               | Because                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The operator's Claude Code plugin | That is `src/plugin/` ([11](11-mcp-tools.md#the-plugin)): skills and an MCP channel installed into the operator's own Claude Code. |
| A way to change any behaviour     | An extension answers only the slots LubbDubb asks. It cannot reach the store, add rules or replace desks.                          |
| Hot-reloaded                      | Loaded once at boot. A changed extension takes a restart.                                                                          |
