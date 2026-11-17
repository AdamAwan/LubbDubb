---
name: add-extension-slot
description: Add a new extension slot to LubbDubb, so a behaviour only one project needs lives in that project's extension while LubbDubb keeps the orchestration. Use when asked to "make X a plugin/extension", "let a project supply its own X", add a slot, or move a config-switched feature out to a project. Not for writing a project's extension file itself.
---

# Adding an extension slot

The contract is [42 § Adding a slot](../../../docs/spec/42-extensions.md#adding-a-slot). Read it and
[42 § When to use one](../../../docs/spec/42-extensions.md#when-to-use-one) first. This skill is the
how-to. The worked example is the tenant slots: `src/extensions/slots.ts`,
`src/validation/remote/extensionTenants.ts`, `test/extensionTenants.test.ts`, and
[36 § A tenant from the project's extension](../../../docs/spec/36-remote-validation.md#a-tenant-from-the-projects-extension).

## 1. Find the seam

Find the interface the feature already calls through (for tenants, `TenantKeeper` in
`src/validation/remote/tenants.ts`) and its config-driven implementation (`CommandTenantKeeper`). The slot
becomes a **second implementation of that interface**. Keep `if (extension)` branches out of the desk.

## 2. Declare the slot in `src/extensions/slots.ts`

`ExtensionSlots` must stay a `type` alias, not an `interface`. An interface fails the `SlotMap`
index-signature constraint. `check` runs inside the host's try, so reading a throwing getter there is
safe.

## 3. Implement the seam over the host

Write an `Extension<Thing>` class that calls `host.call(slot, input)`, typing the host as
`Pick<ExtensionHost<ExtensionSlots>, 'provider' | 'call'>`. `call` never throws. Map
`{ ok: false, detail }` to the seam's failure value, never to the old behaviour.

The extension runs in-process, so a restart kills it. If the old implementation outlived restarts,
write down what a restart now means. Tenants answer "not knowable": `follow` returns null.

## 4. Opt in, and route in one object

- **Explicit opt-in.** Add a config key, e.g. `validate.tenantExtension: true`. Validate it in
  `src/environments/policy.ts` or `src/config/configChecks.ts`, and refuse it next to the config it
  replaces. If it is one shape among several, add it to the shared list and predicate
  (`TENANT_SHAPES` / `declaresTenant`). Do not copy `a || b || c` checks.
- **Route in one object.** Write a `Routed<Thing>` that picks the config or extension implementation per
  deployment. Have it also answer any labels the desk shows (as `RoutedTenantKeeper.steps`), so the
  implementation that runs and the label shown always agree. Wire it in `src/system/systemDesks.ts`,
  wrapping `opts.<thing>` so test fakes keep working. Route on one key only, and make the label method
  part of the seam, so every implementation, fakes included, answers it. The cockpit asks the desk
  (`system.remoteRuns.tenantSteps`), never the config.
- **Boot check.** In `buildFoundation` (`src/system/systemFoundation.ts`), beside
  `checkLoadedExtensions`, refuse to build if the key is opted in and no loaded extension fills the slot.
  Test that with `opts.extensions`' `slots.has(slot)`.

## 5. Surfaces

Run `grep -rn "<old field>" src web/src` to find every reader of the old config fields: cockpit views,
prompts, plan notes, step capabilities. Each must see the opt-in. Keep the old messages' wording, since
existing tests and operators read it.

## 6. Tests: `test/extension<Thing>.test.ts`, at the `buildSystem` seam

- Write the extension as a temp `.mjs` in `gitRepo()`, and set `extensions: ['ext.mjs']` in `loadConfig`.
  Pass `await loadExtensions({ paths: config.extensions, book: EXTENSION_SLOTS })` as `opts.extensions`.
- Record what it was asked on `globalThis` (`globalThis.__asked ??= []`), and reset it per test.
- Still inject every fake `test/CLAUDE.md` requires, and set `projectConfigFile` to a missing file.
- Cover these cases:
  - it answers
  - opted out with an extension loaded, so the old path is untouched
  - no extension at all
  - a throw, which is recorded and changes nothing
  - a wrong-shaped answer
  - opted in with no extension, which refuses to build
  - config conflicts, which are refused
  - a restart
- Do not edit existing tests. Their passing unchanged is the proof the old path still works.

## 7. Specs and check

- Spec 42: add a row to [The slots](../../../docs/spec/42-extensions.md#the-slots).
- The feature's own spec: add a section on the extension path, and an `## Invariants` bullet that the
  old path is unchanged without the opt-in.
- Run `npm run check`. Two traps:
  - Files near the 500-line cap do not count comments, so move code out rather than deleting comments.
  - Functions are capped at 80 lines and complexity 15, so extract small helpers.
