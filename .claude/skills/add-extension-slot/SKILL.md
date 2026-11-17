---
name: add-extension-slot
description: Add a new extension slot to LubbDubb, so a behaviour only one project needs lives in that project's extension while LubbDubb keeps the orchestration. Use when asked to "make X a plugin/extension", "let a project supply its own X", add a slot, or move a config-switched feature out to a project. Not for writing a project's extension file itself.
---

# Adding an extension slot

An extension is a project's own JS/TS module that LubbDubb loads at boot and calls at named **slots**.
Read [`docs/spec/42-extensions.md`](../../../docs/spec/42-extensions.md) first. Its
[Adding a slot](../../../docs/spec/42-extensions.md#adding-a-slot) checklist is the contract, and this
skill tells you how to carry it out. The worked example is the tenant slots: `src/extensions/slots.ts`,
`src/validation/remote/extensionTenants.ts`, `test/extensionTenants.test.ts`, and
[36 § A tenant from the project's extension](../../../docs/spec/36-remote-validation.md#a-tenant-from-the-projects-extension).

## 0. Decide it is a slot

Ask whether a second project would need this exact thing. If yes, it is a LubbDubb feature, not a slot.
If it is one short answer (a commit, an exit code), a shell command in config may already do it.
Name the slot after the **question** (`ensureTenant`), never the mechanism (`runSeedScript`).

## 1. Find the seam

Find the interface the feature already calls through (for tenants, `TenantKeeper`) and its config-driven
implementation (`CommandTenantKeeper`). The slot becomes a **second implementation of that same
interface**. Do not put `if (extension)` branches through the desk.

## 2. Declare the slot — `src/extensions/slots.ts`

- Add its signature to `ExtensionSlots`. It must stay a `type` alias, not an `interface`, or it fails the
  `SlotMap` index-signature constraint.
- Add its definition to `EXTENSION_SLOTS` with a `timeoutMs` and a `check`.
- `check` is the **only** guard on untyped extension output. Refuse every shape you did not promise, and
  write the refusal in the operator's words. `check` runs inside the host's try, so reading a throwing
  getter is safe.
- Inputs are plain data: no store rows, no classes.
- Adding a slot needs no `EXTENSION_API_VERSION` bump. Changing an existing slot's input or answer does.

## 3. Implement the seam over the host

Write an `Extension<Thing>` class implementing the seam. It calls `host.call(slot, input)`, which never
throws: map `{ ok: false, detail }` to the seam's failure value, never to a fallback. Type the host as
`Pick<ExtensionHost<ExtensionSlots>, 'provider' | 'call'>`.

The extension runs **in-process**, so a harness restart kills it. If the old implementation survived
restarts (as detached commands do), decide and document what a restart means. Tenants answer
"not knowable" (`follow` returns null).

## 4. Opt in per deployment, and keep the old path

- Add an explicit opt-in (e.g. `validate.tenantExtension: true`). Never switch silently because an
  extension happens to fill the slot. Without the opt-in, behaviour must be byte-for-byte unchanged.
- Validate the opt-in in config (`src/environments/policy.ts` or `src/config/configChecks.ts`). Refuse it
  beside the config it replaces, because two answers to one question is a misconfiguration.
- If the opt-in counts as one "shape" among several, add it to the shared list and predicate
  (`TENANT_SHAPES` / `declaresTenant`). Do not hand-copy `a || b || c` checks.
- **Route in one object.** A `Routed<Thing>` that picks the config or extension implementation per
  deployment and also answers any "what runs this step" labels, so the two cannot disagree. Wire it in
  `src/system/systemDesks.ts`, wrapping `opts.<thing>` so test fakes keep working.
- **Boot check.** Opted in with no loaded extension filling the slot refuses to build. Put the check in
  `buildFoundation` (`src/system/systemFoundation.ts`) beside `checkLoadedExtensions`, checking the
  loaded extensions (`extension.slots.has(slot)`). The host is `base.extensions`.

## 5. Surfaces

Grep every reader of the old config fields (`grep -rn "<field>" src web/src`): cockpit views, prompts,
plan notes, step capabilities. Each one must see the opt-in. Do not change old messages' wording, since
existing tests and operators read it.

## 6. Tests — a new `test/<thing>Extension*.test.ts` at the `buildSystem` seam

- Write the extension as a temp `.mjs` in `gitRepo()` and set `extensions: ['ext.mjs']` in `loadConfig`.
  Load it with `loadExtensions({ paths: config.extensions, book: EXTENSION_SLOTS })` and pass the result
  as `opts.extensions`.
- Record what the extension was asked through `globalThis` (e.g. `globalThis.__asked ??= []`), and
  reset it per test.
- Still inject every fake `test/CLAUDE.md` requires (`stateReader`, `tenants`, `worktrees`, `backend`, …),
  plus `projectConfigFile` pointing at a missing file.
- Cover all of these:
  - the extension answering
  - not opted in, with an extension loaded, so the old path is untouched
  - no extension at all
  - a throw, which is recorded and nothing changes
  - a wrong-shaped answer
  - opted in with no extension, which refuses to build
  - the config conflicts, which are refused
  - the restart semantics
- Do not edit unrelated tests. Existing tests passing unchanged is the proof the old path still works.

## 7. Specs, in the same change

- 42: a row in [The slots](../../../docs/spec/42-extensions.md#the-slots) and the "Built" line.
- The calling feature's spec: a section for the extension path, saying what not-ok means and what a
  restart means, plus an `## Invariants` bullet that the old path is unchanged without the opt-in.
- Update config docs for any new key.

## 8. Check

`npm run check`. Known traps here:

- `src/system/system.ts` and other files sit near the 500-line cap, and comments do not count toward it,
  so move code out rather than deleting comments.
- `max-lines-per-function` is 80 and complexity is 15: extract small helpers.
- knip errors on unused exports: drop the `export`, never add an ignore.
- `docsReferences.test.ts` checks every spec anchor you link.
