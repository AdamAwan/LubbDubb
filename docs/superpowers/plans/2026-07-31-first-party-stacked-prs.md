# First-party stacked PRs and PR naming — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the harness open, name and restack pull requests itself, and understand a chain of stacked PRs whether or not a plan created it.

**Architecture:** Three new outbound capabilities on the existing `ActionSink` seam (`createPullRequest`, `setPullTitle`, `setPullBase`), one new MCP tool (`open_pr`) whose identity is structural, one overridable `pr-title` prompt-book entry, and a **pure derived** stack model in `src/stacks/` that is a read-only lens — nothing in `src/dispatcher/` may import it. Restacking is an extension of the existing rule 2 (base-update), not a new rule.

**Tech Stack:** TypeScript ESM (`nodenext`, explicit `.js` import extensions), `node:test` via `tsx`, better-sqlite3, Fastify, React (cockpit under `web/`).

## Global constraints

- **ESM with explicit `.js` import extensions** in every new/edited file, even from `.ts` sources.
- **`npm run check` is the gate** (format:check, lint, typecheck, typecheck:web, knip, test). On this Windows checkout `format:check` reports a CRLF false alarm across nearly every file — verify with `npx tsx --test test/<file>.test.ts` and `npm run typecheck` directly, and do not "fix" formatting repo-wide.
- **knip runs with every rule at `error`.** An export nothing imports, a type nothing names, or an unused public class member fails the build. Prefer dropping the `export` keyword over deleting.
- **Comments explain _why_, not _what_.** Match the terse, high-signal house style. Do not narrate code.
- **A new seam method lands with its scripted fake in the same change** — `FakeGitHubIntegration`, the `github` fake `GitHubApi`, and the `azure` fake `AzureDevOpsApi` together.
- **Domain types live in `src/types.ts`;** the cockpit has its own `web/src/types.ts` and must not import server code.
- **Update the owning spec document under `docs/spec/` in the same change as the behaviour.**
- Commit after each task. Do not skip hooks.

## File structure

| File                                                                          | Responsibility                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/sink/actionSink.ts`                                                      | Add `PrCreateInput`, `PrTitleInput`, `PrBaseInput` + three `ActionSink` methods |
| `src/integrations/integration.ts`                                             | Add `PrCreateCapable` / `PrTitleCapable` / `PrBaseCapable` + type guards        |
| `src/integrations/compositeConnector.ts`                                      | Route the three new methods                                                     |
| `src/integrations/fake/fakeGitHub.ts`                                         | Fake implementations that reflect into the fake world                           |
| `src/integrations/github/{githubApi,octokitGitHubApi,sourceControl}.ts`       | GitHub arm                                                                      |
| `src/integrations/azure/{azureDevOpsApi,restAzureDevOpsApi,sourceControl}.ts` | Azure arm                                                                       |
| `src/prTitle.ts`                                                              | **Pure** `prTitleFields` + `renderPrTitle` — no provider call, no world read    |
| `src/dispatcher/promptTemplates.ts`                                           | The `pr-title` entry                                                            |
| `src/mcp/openPr.ts`                                                           | Pure origin → `{branch, base, issue, position, total}` resolution for `open_pr` |
| `src/mcp/tools.ts`                                                            | The `open_pr` tool definition + handler                                         |
| `src/stacks/stack.ts`                                                         | **Pure** `buildStacks` — the derived stack model (lens)                         |
| `src/prHealth.ts`                                                             | Add `needsRestack` beside `needsBaseUpdate`                                     |
| `src/dispatcher/ruleDispatcher.ts`                                            | Rule 2 also fires on `needsRestack`                                             |
| `src/plans/planReconciler.ts`                                                 | Retarget-on-merge, idempotent                                                   |
| `src/server/app.ts`                                                           | Ship `stacks` on `/api/state` — the stack model's **only** importer             |
| `web/src/components/StackPanel.tsx`                                           | The panel                                                                       |
| `web/src/types.ts`                                                            | `Stack` / `StackRung` mirror types                                              |

Tests: `test/prTitle.test.ts`, `test/stacks.test.ts`, `test/openPr.test.ts`, plus additions to `test/stackedPrs.test.ts` and `test/mcpChannel.test.ts`.

---

## Task 1: The three sink capabilities

**Files:**

- Modify: `src/sink/actionSink.ts`
- Modify: `src/integrations/integration.ts`
- Modify: `src/integrations/compositeConnector.ts`
- Modify: `src/integrations/fake/fakeGitHub.ts`
- Test: `test/stacks.test.ts` (create)

**Interfaces:**

- Produces: `PrCreateInput {branch, base, title, body}`, `PrTitleInput {prNumber, title}`, `PrBaseInput {prNumber, base}`; `ActionSink.createPullRequest/setPullTitle/setPullBase` each returning `Promise<SendResult>`; capability interfaces `PrCreateCapable`/`PrTitleCapable`/`PrBaseCapable` and guards `isPrCreateCapable`/`isPrTitleCapable`/`isPrBaseCapable`.
- `SendResult.ref` carries the created PR number as a string for `createPullRequest`.

- [ ] **Step 1: Write the failing test**

```ts
// test/stacks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem } from '../src/system.js';
import { defaultConfig } from './helpers/config.js'; // follow whatever existing tests use

test('the sink can open a pull request and it appears in the world', async () => {
  const sys = await buildSystem({ ...defaultConfig(), dbPath: ':memory:' } as never, { errorMirror: () => {} });
  const result = await sys.sink.createPullRequest({
    branch: 'issue/12/schema',
    base: 'main',
    title: '#12 [1/2] feat(store): schema',
    body: 'part of #12',
  });
  assert.equal(result.ok, true);
  assert.ok(result.ref, 'the created PR number comes back for the audit log');
  const world = await sys.connector.snapshot();
  assert.ok(world.pullRequests.some((p) => p.branch === 'issue/12/schema'));
  await sys.shutdown();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test test/stacks.test.ts`
Expected: FAIL — `sys.sink.createPullRequest is not a function`.

- [ ] **Step 3: Add the input types and seam methods**

In `src/sink/actionSink.ts`, beside `PrLabelInput`:

```ts
export interface PrCreateInput {
  /** The head branch — the work. */
  branch: string;
  /** The branch this PR targets. The default branch, or the rung beneath it in a stack. */
  base: string;
  title: string;
  body: string;
}

export interface PrTitleInput {
  prNumber: number;
  title: string;
}

export interface PrBaseInput {
  prNumber: number;
  /** The branch the PR should target. Retarget-on-merge writes the merged rung's own base here. */
  base: string;
}
```

And on the `ActionSink` interface:

```ts
  /** Open a pull request. `SendResult.ref` is the new PR number. Throws if creation fails. */
  createPullRequest(input: PrCreateInput): Promise<SendResult>;
  /** Rewrite a pull request's title to the house convention. Idempotent — callers skip a no-op. */
  setPullTitle(input: PrTitleInput): Promise<SendResult>;
  /** Retarget a pull request's base — a stack rung whose parent merged. Idempotent. */
  setPullBase(input: PrBaseInput): Promise<SendResult>;
```

- [ ] **Step 4: Add the capabilities and guards**

In `src/integrations/integration.ts`, following the `PrLabelCapable` pattern exactly:

```ts
/** An integration that can open a pull request — the harness authoring its own PRs. */
export interface PrCreateCapable {
  createPullRequest(input: PrCreateInput): Promise<SendResult>;
}

export function isPrCreateCapable(x: Integration): x is Integration & PrCreateCapable {
  return typeof (x as Partial<PrCreateCapable>).createPullRequest === 'function';
}

/** An integration that can rewrite a pull request's title — the naming convention. */
export interface PrTitleCapable {
  setPullTitle(input: PrTitleInput): Promise<SendResult>;
}

export function isPrTitleCapable(x: Integration): x is Integration & PrTitleCapable {
  return typeof (x as Partial<PrTitleCapable>).setPullTitle === 'function';
}

/** An integration that can retarget a pull request's base — a stack rung whose parent merged. */
export interface PrBaseCapable {
  setPullBase(input: PrBaseInput): Promise<SendResult>;
}

export function isPrBaseCapable(x: Integration): x is Integration & PrBaseCapable {
  return typeof (x as Partial<PrBaseCapable>).setPullBase === 'function';
}
```

Import the three input types at the top of the file alongside the existing sink-input imports.

- [ ] **Step 5: Route them in the composite**

In `src/integrations/compositeConnector.ts`, mirroring `setPrLabel`:

```ts
  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrCreateCapable);
    if (!handler) throw new Error('no integration can open PRs (no sourceControl provider is PrCreateCapable)');
    return handler.createPullRequest(input);
  }

  async setPullTitle(input: PrTitleInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrTitleCapable);
    if (!handler) throw new Error('no integration can retitle PRs (no sourceControl provider is PrTitleCapable)');
    return handler.setPullTitle(input);
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrBaseCapable);
    if (!handler) throw new Error('no integration can retarget PRs (no sourceControl provider is PrBaseCapable)');
    return handler.setPullBase(input);
  }
```

- [ ] **Step 6: Implement the fake**

In `src/integrations/fake/fakeGitHub.ts`, add the three capabilities to the `implements` clause and reflect each into the fake world: `createPullRequest` pushes a new open `PullRequest` (next free number, `state: 'open'`, `ciStatus` whatever the fake's default is, `baseBranch` from `input.base`) and returns `{ok: true, ref: String(number)}`; `setPullTitle` mutates `title` on the matching row; `setPullBase` mutates `baseBranch`. Each throws if the PR number is unknown.

- [ ] **Step 7: Run the test**

Run: `npx tsx --test test/stacks.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/sink/actionSink.ts src/integrations/ test/stacks.test.ts
git commit -m "Add PR create, retitle and retarget to the outbound seam"
```

---

## Task 2: The GitHub and Azure arms

**Files:**

- Modify: `src/integrations/github/githubApi.ts`, `octokitGitHubApi.ts`, `sourceControl.ts`
- Modify: `src/integrations/azure/azureDevOpsApi.ts`, `restAzureDevOpsApi.ts`, `sourceControl.ts`
- Test: `test/githubIntegration.test.ts`, `test/azureDevOpsIntegration.test.ts`

**Interfaces:**

- Consumes: the three capability interfaces from Task 1.
- Produces: `GitHubApi.createPull/setPullTitle/setPullBase` and `AzureDevOpsApi.createPull/setPullTitle/setPullBase`, each added to the narrow seam **and its scripted fake together**.

- [ ] **Step 1: Write the failing GitHub test**

```ts
test('github createPullRequest posts to the pulls API and returns the number', async () => {
  const api = fakeGitHubApi({ createPullResult: { number: 77 } });
  const sc = new GitHubSourceControl({ api, owner: 'o', repo: 'r' });
  const res = await sc.createPullRequest({ branch: 'f', base: 'main', title: 't', body: 'b' });
  assert.deepEqual(res, { ok: true, ref: '77' });
  assert.deepEqual(api.calls.createPull.at(-1), { head: 'f', base: 'main', title: 't', body: 'b' });
});
```

Extend the existing scripted fake in that test file with `createPull`, `setPullTitle`, `setPullBase` recorders — do not create a second fake.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test test/githubIntegration.test.ts`
Expected: FAIL — `sc.createPullRequest is not a function`.

- [ ] **Step 3: Extend the `GitHubApi` seam**

```ts
  createPull(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number }>;
  setPullTitle(input: { number: number; title: string }): Promise<void>;
  setPullBase(input: { number: number; base: string }): Promise<void>;
```

`OctokitGitHubApi` implements them with `pulls.create`, and `pulls.update` for the other two (`{title}` and `{base}` respectively). It stays the only file importing octokit.

- [ ] **Step 4: Implement on `GitHubSourceControl`**

Add `PrCreateCapable, PrTitleCapable, PrBaseCapable` to the `implements` clause and delegate to the API, wrapping the created number as `{ok: true, ref: String(number)}`.

- [ ] **Step 5: Do the same for Azure**

`AzureDevOpsApi` gains the same three methods. `RestAzureDevOpsApi` implements them against `/_apis/git/repositories/{repo}/pullrequests` (POST with `sourceRefName`/`targetRefName` as full `refs/heads/...` refs) and PATCH of the same resource for title (`title`) and base (`targetRefName`). Branch names must be converted to `refs/heads/<branch>` on the way out and back on the way in — follow whatever existing helper `sourceControl.ts` already uses for ref names rather than inlining a second conversion.

- [ ] **Step 6: Run both integration suites**

Run: `npx tsx --test test/githubIntegration.test.ts test/azureDevOpsIntegration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/ test/githubIntegration.test.ts test/azureDevOpsIntegration.test.ts
git commit -m "Implement PR authoring on the github and azure arms"
```

---

## Task 3: The `pr-title` template and pure rendering

**Files:**

- Create: `src/prTitle.ts`
- Modify: `src/dispatcher/promptTemplates.ts`
- Create: `test/prTitle.test.ts`
- Modify: `docs/prompt-templates/README.md` + add `docs/prompt-templates/pr-title.md`

**Interfaces:**

- Produces: `prTitleFields(input: PrTitleFieldsInput): Record<string, string>` and `renderPrTitle(template: string, fields: Record<string, string>): string`.
- `PrTitleFieldsInput = {number: number; title: string; position: number; total: number; type?: string; scope?: string; summary: string}`.

- [ ] **Step 1: Write the failing test**

```ts
// test/prTitle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prTitleFields, renderPrTitle } from '../src/prTitle.js';
import { DEFAULT_PROMPT_TEMPLATES } from '../src/dispatcher/promptTemplates.js';

const tpl = DEFAULT_PROMPT_TEMPLATES['pr-title'].template;

test('a stacked PR renders position, type and scope', () => {
  const fields = prTitleFields({
    number: 182,
    title: 'Ticket sync rewrite',
    position: 2,
    total: 4,
    type: 'feat',
    scope: 'store',
    summary: 'sync cursor table',
  });
  assert.equal(renderPrTitle(tpl, fields), '#182 [2/4] feat(store): sync cursor table');
});

test('a lone PR omits the position clause entirely', () => {
  const fields = prTitleFields({
    number: 182,
    title: 'Ticket sync rewrite',
    position: 1,
    total: 1,
    type: 'feat',
    scope: 'store',
    summary: 'sync cursor table',
  });
  assert.equal(renderPrTitle(tpl, fields), '#182 feat(store): sync cursor table');
});

test('an undeclared type and scope leave no punctuation behind', () => {
  const fields = prTitleFields({
    number: 182,
    title: 'Ticket sync rewrite',
    position: 1,
    total: 1,
    summary: 'sync cursor table',
  });
  assert.equal(renderPrTitle(tpl, fields), '#182 sync cursor table');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test test/prTitle.test.ts`
Expected: FAIL — cannot find module `../src/prTitle.js`.

- [ ] **Step 3: Write `src/prTitle.ts`**

The clause-assembly is the whole point: the template names `{position}`, `{type}` and `{scope}` as **already-punctuated clauses**, so an operator's template is a straight substitution and never has to express "omit the brackets when there is one rung".

```ts
/**
 * The title fields, assembled as finished clauses rather than raw values.
 *
 * An operator's template is a plain substitution, so anything conditional —
 * the position clause on a lone PR, the parentheses around an undeclared
 * scope — has to be resolved here or every override re-implements it and
 * they drift.
 */
interface PrTitleFieldsInput {
  number: number;
  title: string;
  position: number;
  total: number;
  type?: string;
  scope?: string;
  summary: string;
}

export function prTitleFields(input: PrTitleFieldsInput): Record<string, string> {
  const scope = input.scope?.trim() ?? '';
  const type = input.type?.trim() ?? '';
  const kind = type ? (scope ? `${type}(${scope}): ` : `${type}: `) : '';
  return {
    number: String(input.number),
    title: input.title,
    // A PR that stacks on nothing is not "1/1" — it has no position to state.
    position: input.total > 1 ? `[${input.position}/${input.total}] ` : '',
    total: String(input.total),
    type,
    scope,
    kind,
    summary: input.summary.trim(),
  };
}

export function renderPrTitle(template: string, fields: Record<string, string>): string {
  const filled = template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in fields ? fields[key] : whole));
  return filled.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Add the template entry**

In `src/dispatcher/promptTemplates.ts`, following the shape of the surrounding entries:

```ts
  'pr-title': {
    placeholders: ['number', 'title', 'position', 'total', 'type', 'scope', 'kind', 'summary'],
    template: '#{number} {position}{kind}{summary}',
    doc: "The title the harness gives a pull request it opens (and renames to). {position} and {kind} arrive pre-punctuated and empty when they do not apply — a PR that stacks on nothing has no position, and an agent that declared no type has no 'type(scope): ' prefix — so an override is a plain substitution. {title} is the issue title, available but unused by the default. Placeholders: {number} {title} {position} {total} {type} {scope} {kind} {summary}.",
  },
```

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test test/prTitle.test.ts`
Expected: PASS, all three.

- [ ] **Step 6: Document the template**

Create `docs/prompt-templates/pr-title.md` holding the default template body, and add its row to `docs/prompt-templates/README.md` alongside the existing entries.

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add src/prTitle.ts src/dispatcher/promptTemplates.ts test/prTitle.test.ts docs/prompt-templates/
git commit -m "Render PR titles from an overridable template"
```

---

## Task 4: `open_pr`

**Files:**

- Create: `src/mcp/openPr.ts`
- Modify: `src/mcp/tools.ts`
- Create: `test/openPr.test.ts`
- Modify: `test/mcpChannel.test.ts`

**Interfaces:**

- Consumes: `prTitleFields`/`renderPrTitle` (Task 3), `ActionSink.createPullRequest` (Task 1).
- Produces: `resolveOpenPr(originRef, ctx): OpenPrTarget | {error: string}` where `OpenPrTarget = {issueNumber: number; issueTitle: string; branch: string; base: string; position: number; total: number}`.

- [ ] **Step 1: Write the failing resolution test**

```ts
// test/openPr.test.ts
test('a part origin resolves its branch, base and stack position', () => {
  const target = resolveOpenPr('issue:182:part:cursor', {
    issue: { number: 182, title: 'Ticket sync rewrite' },
    parts: [
      { slug: 'migrations', seq: 1, branch: 'issue/182/migrations' },
      { slug: 'cursor', seq: 2, branch: 'issue/182/cursor', base: 'issue/182/migrations' },
    ],
    defaultBranch: 'main',
  });
  assert.deepEqual(target, {
    issueNumber: 182,
    issueTitle: 'Ticket sync rewrite',
    branch: 'issue/182/cursor',
    base: 'issue/182/migrations',
    position: 2,
    total: 2,
  });
});

test('a pickup origin is a lone PR onto the default branch', () => {
  const target = resolveOpenPr('issue:182', {
    issue: { number: 182, title: 'Ticket sync rewrite' },
    parts: [],
    defaultBranch: 'main',
  });
  assert.equal(target.total, 1);
  assert.equal(target.base, 'main');
});

test('an origin with no work behind it is refused rather than guessed', () => {
  const target = resolveOpenPr('pr:42:ci', {
    issue: null,
    parts: [],
    defaultBranch: 'main',
  });
  assert.ok('error' in target);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test test/openPr.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `src/mcp/openPr.ts`**

Reuse `partBase` from `src/plans/parts.ts` for base selection rather than re-deriving it — two answers to "what does this part stack on" is the drift class this repo pays for repeatedly. `position` is the part's `seq` among **live** parts (`liveParts`), `total` their count; a non-part issue origin is `1/1` onto `defaultBranch`. Every other origin shape (`pr:*`, `job:*`, `:plan`, `:assay`, `:assess`, `:retro`) returns `{error}` naming the origin and saying `open_pr` is for issue and part agents — refusing beats guessing, exactly as `conclusionOrigin` and `partConclusionOrigin` refuse.

- [ ] **Step 4: Add the tool to `src/mcp/tools.ts`**

```ts
    {
      name: 'open_pr',
      description:
        'Open the pull request for the work you were dispatched to do. The harness supplies the branch, ' +
        'the base (which is the rung beneath you when your work is stacked) and the title convention — you ' +
        'supply what the change does. You cannot open a pull request for another agent\'s work. If this ' +
        'tool is unavailable, open the pull request yourself with the branch and base named in your prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What the change does, in a few words. Becomes the title.' },
          type: { type: 'string', description: 'Optional conventional-commit type, e.g. "feat", "fix", "refactor".' },
          scope: { type: 'string', description: 'Optional module the change lands in, e.g. "store".' },
          body: { type: 'string', description: 'Optional PR body. The harness adds the issue reference itself.' },
        },
        required: ['summary'],
      },
      handler: async (args) => { /* resolve → render title → sink.createPullRequest → ok({number}) */ },
    },
```

The handler resolves the target from `agent`'s origin (never from an argument), renders the title through Task 3, calls `deps.sink.createPullRequest`, and returns `ok({ number })`. A refused origin returns `toolError(...)`.

Register the name in `src/mcp/names.ts` so the launch-config key, the tool name and the `mcp__lubbdubb__open_pr` grant agree — drift there yields a connected server whose every call is refused.

- [ ] **Step 5: Assert structural identity and the degradation floor**

In `test/mcpChannel.test.ts`:

```ts
test('open_pr refuses an agent whose origin is not its own issue work', async () => {
  // dispatch a pr:42:ci agent, call open_pr, expect an error mentioning the origin
});

test('open_pr is absent when the tool channel is off, and the prompt still names the base', async () => {
  // buildSystem with mcp: {enabled: false}; assert the plan-part prompt still says "into {base}"
});
```

- [ ] **Step 6: Run the suites**

Run: `npx tsx --test test/openPr.test.ts test/mcpChannel.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add src/mcp/ test/openPr.test.ts test/mcpChannel.test.ts
git commit -m "Let an agent open its pull request through the tool channel"
```

---

## Task 5: Rename, gated on `filters.prAuthor`

**Files:**

- Create: `src/prRename.ts`
- Modify: `src/harness.ts` (call it on the pulse, beside the plan reconciler)
- Modify: `src/config.ts` (nothing new — read the existing `filters.prAuthor`)
- Test: `test/prTitle.test.ts` (extend)

**Interfaces:**

- Consumes: `renderPrTitle`/`prTitleFields` (Task 3), `ActionSink.setPullTitle` (Task 1).
- Produces: `renamablePrs(prs, ctx): PrTitleInput[]` — pure; returns only PRs whose live title differs from the rendered one **and** which the gate admits.

- [ ] **Step 1: Write the failing test**

```ts
test('with prAuthor set every PR in the world is renamable', () => {
  const out = renamablePrs([pr({ number: 39, title: 'reclaim stale worktree dirs', branch: 'issue/164/reclaim' })], {
    prAuthorConfigured: true,
    harnessOpened: new Set<number>(),
    template: tpl,
    issues,
    defaultBranch: 'main',
  });
  assert.deepEqual(out, [{ prNumber: 39, title: '#164 reclaim stale worktree dirs' }]);
});

test('with prAuthor unset only PRs the harness opened are renamable', () => {
  const ctx = { prAuthorConfigured: false, harnessOpened: new Set([44]), template: tpl, issues, defaultBranch: 'main' };
  const out = renamablePrs(
    [pr({ number: 39, branch: 'issue/164/reclaim' }), pr({ number: 44, branch: 'issue/182/x' })],
    ctx,
  );
  assert.deepEqual(
    out.map((o) => o.prNumber),
    [44],
  );
});

test('a PR already on convention is not rewritten', () => {
  const out = renamablePrs([pr({ number: 44, title: '#182 sync cursor table', branch: 'issue/182/x' })], {
    prAuthorConfigured: true,
    harnessOpened: new Set(),
    template: tpl,
    issues,
    defaultBranch: 'main',
  });
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test test/prTitle.test.ts`
Expected: FAIL — cannot find module `../src/prRename.js`.

- [ ] **Step 3: Implement `src/prRename.ts`**

The doc comment carries the argument:

```ts
/**
 * Which pull requests the harness may rename.
 *
 * `filters.prAuthor` is already the operator's answer to "which PRs are mine",
 * and both providers apply it *at fetch time* — so when it is set, every PR in
 * the world is the operator's own by construction and no attribution logic is
 * needed here at all. When it is unset the world holds everyone's PRs and the
 * harness cannot tell them apart, so it falls back to the ones it opened itself.
 * A colleague's pull request is renamed under neither arm.
 */
```

The rename set requires the PR to resolve to an issue (via `linkedPrNumber` or an `issue/<n>` branch); a PR that resolves to none is left alone, since the convention is keyed on an issue number.

- [ ] **Step 4: Call it on the pulse**

In `src/harness.ts`, beside the plan reconciler, iterate `renamablePrs(...)` and `await sink.setPullTitle(...)` for each, recording a failure through `errors.record` rather than throwing the cycle. It is mechanical bookkeeping — **not** auto-send gated — like `setWorkItemState` and `upsertIssueComment`.

- [ ] **Step 5: Run and commit**

Run: `npx tsx --test test/prTitle.test.ts`
Expected: PASS.

```bash
npm run typecheck
git add src/prRename.ts src/harness.ts test/prTitle.test.ts
git commit -m "Rename pull requests onto the convention, scoped by the prAuthor filter"
```

---

## Task 6: The derived stack model

**Files:**

- Create: `src/stacks/stack.ts`
- Modify: `web/src/types.ts` (mirror types)
- Test: `test/stacks.test.ts` (extend)

**Interfaces:**

- Consumes: `basePrOf`, `isStackedPr`, `prHealth`, `prAttentionStatus` (all existing).
- Produces: `buildStacks(openPrs: PullRequest[], plans: Plan[], parts: PlanPart[], defaultBranch: string): Stack[]`, with `Stack = {ref: string; issueNumber: number | null; issueTitle: string | null; planId: string | null; rungs: StackRung[]}` and `StackRung = {prNumber: number; title: string; branch: string; base: string; position: number; partSlug: string | null}`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a hand-made chain is a stack with no plan behind it', () => {
  const stacks = buildStacks(
    [
      pr({ number: 38, branch: 'issue/164/prune', baseBranch: 'main' }),
      pr({ number: 39, branch: 'issue/164/reclaim', baseBranch: 'issue/164/prune' }),
    ],
    [],
    [],
    'main',
  );
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].planId, null);
  assert.deepEqual(
    stacks[0].rungs.map((r) => r.prNumber),
    [38, 39],
  );
});

test('a plan adopts the stack its parts opened', () => {
  const stacks = buildStacks(prs, [plan({ id: 'p1', issueNumber: 182 })], parts, 'main');
  assert.equal(stacks[0].planId, 'p1');
  assert.equal(stacks[0].rungs[1].partSlug, 'cursor');
});

test('an unstacked PR is not a stack of one', () => {
  const stacks = buildStacks([pr({ number: 5, branch: 'f', baseBranch: 'main' })], [], [], 'main');
  assert.deepEqual(stacks, []);
});
```

Plus the two structural lens assertions, modelled on `test/prAttention.test.ts`:

```ts
test('the stack model is a lens — the dispatcher never reads it', async () => {
  const files = await readdir('src/dispatcher', { recursive: true });
  for (const f of files) {
    const body = await readFile(join('src/dispatcher', f), 'utf8');
    assert.ok(!body.includes('stacks/'), `${f} must not import the stack model`);
  }
});

test('the stack model has exactly one importer', async () => {
  // walk src/, collect files naming 'stacks/stack', assert it is ['src/server/app.ts']
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test test/stacks.test.ts`
Expected: FAIL — cannot find module `../src/stacks/stack.js`.

- [ ] **Step 3: Implement the fold**

Group PRs into chains by the `pr.baseBranch === other.branch` edge (the same edge `basePrOf` walks), discard chains of length 1, order each bottom-first, and attach a plan when every rung's branch matches one of that plan's live parts. Takes the **unfiltered** open list (dispatch world plus `ctx.excludedPrs`) so an `-ignore`d rung does not put a hole in the chain. Guard against a cycle in the base edges — a malformed world must not hang the fold.

- [ ] **Step 4: Mirror the types in the cockpit**

Add `Stack`/`StackRung` to `web/src/types.ts` by hand. The web bundle does not import server code.

- [ ] **Step 5: Run and commit**

Run: `npx tsx --test test/stacks.test.ts`
Expected: PASS, including both lens assertions.

```bash
npm run typecheck && npm run typecheck:web
git add src/stacks/ web/src/types.ts test/stacks.test.ts
git commit -m "Derive the stack model from the world, as a lens"
```

---

## Task 7: `needsRestack`, and rule 2

**Files:**

- Modify: `src/prHealth.ts`
- Modify: `src/dispatcher/ruleDispatcher.ts`
- Modify: `src/dispatcher/promptTemplates.ts` (a `pr-restack` entry)
- Test: `test/stackedPrs.test.ts`

**Interfaces:**

- Produces: `needsRestack(pr: PullRequest, openPrs: PullRequest[]): PullRequest | null` — the base PR this one has fallen behind, or null. Pure; the git-level "how far behind" is read by the reconciler, not here.

- [ ] **Step 1: Write the failing test**

```ts
test('a rung whose base PR moved needs a restack', () => {
  const base = pr({ number: 44, branch: 'issue/182/migrations', headSha: 'bbb' });
  const rung = pr({ number: 45, branch: 'issue/182/cursor', baseBranch: 'issue/182/migrations', baseSha: 'aaa' });
  assert.equal(needsRestack(rung, [base, rung])?.number, 44);
});

test('restack and inherited CI stay apart', () => {
  // a rung whose base is red but has not moved: inheritedCiFailure returns the base, needsRestack returns null
});

test('rule 2 dispatches a restack, and rule 1 still does not fire for inherited CI', async () => {
  // drive the fake world through buildSystem; assert exactly one dispatch, on the rung, from rule 2
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test test/stackedPrs.test.ts`
Expected: FAIL — `needsRestack is not exported`.

- [ ] **Step 3: Implement `needsRestack`**

```ts
/**
 * The base PR this one has fallen behind — a rung to rebase, not a rung to
 * leave alone.
 *
 * Deliberately distinct from {@link inheritedCiFailure}, which is *suppression*:
 * that one says the red CI belongs to an ancestor and an agent sent here would be
 * fixing code that is not its own. This one is actionable — the base branch moved
 * and this PR needs rebasing onto it. Folded together they would put an agent on
 * the upper PR to fix the lower one's code.
 */
export function needsRestack(pr: PullRequest, openPrs: PullRequest[]): PullRequest | null {
  const base = basePrOf(pr, openPrs);
  if (!base) return null;
  return pr.baseSha && base.headSha && pr.baseSha !== base.headSha ? base : null;
}
```

If `PullRequest` carries no `baseSha`/`headSha` today, add them as optional fields on the type and map them through both providers' `Gh*`/`Az*` types and their scripted fakes in this task — a missing value must read as "cannot tell", i.e. `null`, never as "needs restack".

- [ ] **Step 4: Extend rule 2**

In `ruleDispatcher.ts`, the base-update rule's condition becomes `needsBaseUpdate(pr) || isConflicted(pr) || needsRestack(pr, openPrs)`, with the restack arm selecting the new `pr-restack` prompt and naming the base PR. Route it through the existing `Candidate` list — an inline `raw.push` would bypass both the headroom cut and the Up-next queue.

- [ ] **Step 5: Run and commit**

Run: `npx tsx --test test/stackedPrs.test.ts`
Expected: PASS.

```bash
npm run typecheck
git add src/prHealth.ts src/dispatcher/ src/types.ts src/integrations/ test/stackedPrs.test.ts
git commit -m "Dispatch a restack when a stack rung falls behind its base"
```

---

## Task 8: Retarget on merge

**Files:**

- Modify: `src/plans/planReconciler.ts`
- Test: `test/planReconcile.test.ts`

**Interfaces:**

- Consumes: `ActionSink.setPullBase` (Task 1), `buildStacks` is **not** used here — the reconciler reads PRs directly, keeping the lens unimported outside `app.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test('when a rung merges the rung above it is retargeted to the merged rungs base', async () => {
  // #44 (base main) merges; #45 targeted issue/182/migrations
  // expect one setPullBase({prNumber: 45, base: 'main'})
});

test('retargeting is idempotent — a second pulse writes nothing', async () => {
  // run the reconciler twice, assert setPullBase was called once
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test test/planReconcile.test.ts`
Expected: FAIL — no `setPullBase` call recorded.

- [ ] **Step 3: Implement**

In the reconciler's pulse, for each open PR whose `baseBranch` names a branch belonging to a PR that has left the open set as **merged** (the `closedPullRequests` window — `prState` folds a missing value onto `merged` and never invents `closed`), write the merged PR's own base. Skip when the live base already equals the target. Mechanical bookkeeping, so not auto-send gated; a failure is recorded through `errors.record` and never fails the cycle.

- [ ] **Step 4: Run and commit**

Run: `npx tsx --test test/planReconcile.test.ts`
Expected: PASS both.

```bash
npm run typecheck
git add src/plans/planReconciler.ts test/planReconcile.test.ts
git commit -m "Retarget a stack rung when the rung beneath it merges"
```

---

## Task 9: The cockpit stack panel

**Files:**

- Modify: `src/server/app.ts` (ship `stacks`)
- Create: `web/src/components/StackPanel.tsx`
- Modify: `web/src/App.tsx` (mount it)
- Test: `test/stacks.test.ts` (snapshot shape)

**Interfaces:**

- Consumes: `buildStacks` (Task 6) — `app.ts` is its **only** importer, which Task 6's structural test enforces.

- [ ] **Step 1: Write the failing snapshot test**

```ts
test('/api/state ships the stacks', async () => {
  const state = await buildStateSnapshot(/* … */);
  assert.equal(state.stacks[0].rungs.length, 2);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test test/stacks.test.ts`
Expected: FAIL — `state.stacks` is undefined.

- [ ] **Step 3: Ship it**

Call `buildStacks` in `buildStateSnapshot` with the unfiltered open list, and add `stacks` to the snapshot type in both `src/types.ts` and `web/src/types.ts`.

- [ ] **Step 4: Build the panel**

`StackPanel.tsx` draws each stack as a column, bottom rung last, reusing the existing `prHealth` and `attentionChip` chips rather than inventing new ones — see the approved mockup. Two actions: **Restack** on a rung (queues the rule-2 dispatch) and **Merge** on the bottom rung only, routed through the existing proposal machinery so `autoSend` and human approval apply unchanged. **There is no "merge stack" button** — that would queue several merges ahead of CI results.

- [ ] **Step 5: Verify in the browser**

Start the dev server through `preview_start`, open the cockpit, and confirm the panel renders against the fake provider's world. Check `read_console_messages` for errors.

- [ ] **Step 6: Run the whole gate and commit**

```bash
npm run typecheck && npm run typecheck:web && npm test
git add src/server/app.ts src/types.ts web/ test/stacks.test.ts
git commit -m "Draw the stacks in the cockpit"
```

---

## Task 10: Specs

**Files:**

- Modify: `docs/spec/07-pull-requests.md`, `11-mcp-tools.md`, `15-integrations.md`, `17-cockpit.md`
- Modify: `CLAUDE.md` (a bullet for the stack model's lens property and the rename gate)

- [ ] **Step 1: Write the spec changes**

`07` gains the stack model, the naming convention and restack-vs-inherited-CI. `11` gains `open_pr`. `15` gains the three capabilities. `17` gains the panel. `CLAUDE.md` gains a short bullet recording _why_ the stack model is a lens and _why_ rename is gated on `filters.prAuthor` — the reasoning, not the mechanics.

- [ ] **Step 2: Run the full gate**

```bash
npm run check
```

Expected: pass, modulo the known Windows CRLF false alarm in `format:check`.

- [ ] **Step 3: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "Document stacked PRs and the naming convention"
```

---

## Self-review

**Spec coverage.** Stage A → Tasks 1, 2, 4. Stage B → Tasks 3, 5. Stage C → Task 6. Stage D → Tasks 7, 8, 9. Spec-updates section → Task 10. The spec's "no merge stack button" and "no off-convention chip" decisions are carried in Task 9. The `prAuthor` two-arm gate is Task 5. The degradation floor is Task 4 Step 5.

**Type consistency.** `prTitleFields`/`renderPrTitle` are used by name in Tasks 4 and 5. `buildStacks` returns `Stack[]` in Task 6 and is consumed under that name in Task 9. `needsRestack` returns `PullRequest | null` in Task 7 and is consumed in the same task. `PrCreateInput`/`PrTitleInput`/`PrBaseInput` are defined in Task 1 and used in Tasks 2, 4, 5, 8.

**Known risk.** Task 7 depends on `PullRequest` carrying the head/base SHAs; the task explicitly includes adding them to the type and both providers if absent, rather than assuming they exist.
