# Filter Azure DevOps work items by assignee

## Problem

The Azure DevOps connector can narrow the work items it surfaces to those carrying a
configured tag (`filters.workItemTag`), and it can narrow PRs to a single author
(`filters.prAuthor`). It cannot narrow work items to a single **assignee**. An operator
running the harness against a shared project therefore sees every open work item, with no
way to say "only work the items assigned to me."

There is no regression here: work-item author/assignee filtering has never existed. This
adds the missing capability.

## Goal

Add an optional `filters.workItemAssignedTo` to the Azure DevOps config that restricts the
surfaced open work items to those whose `System.AssignedTo` matches a configured user
(exact UPN / uniqueName). It composes with the existing tag filter: when both are set, an
item must satisfy both (AND).

Out of scope: GitHub issues (no equivalent config today), "Created By" filtering, the `@Me`
WIQL macro, and any cockpit UI. This is a config-file filter, exactly like `workItemTag`.

## Approach

Filter **server-side in WIQL**, extending the same query builder the tag filter already
uses. The tag filter is expressed as a WIQL clause in the pure `buildOpenWorkItemQuery`;
the assignee filter becomes a second, independent clause there. This keeps the filter in
one pure, unit-testable place and avoids returning work items the harness would only
discard.

The rejected alternative — a client-side `.filter()` like `prAuthor` uses — would require
plumbing `System.AssignedTo` through the `AzWorkItem` DTO and `mapWorkItem`, a field
nothing else reads. WIQL filtering needs no new DTO field.

## Changes

### Config (`src/config.ts`)

`AzureDevOpsConfig.filters` gains one optional field:

```ts
filters?: {
  prAuthor?: string;
  workItemTag?: string;
  /** Only surface work items assigned to this uniqueName (UPN). Unset = all assignees. */
  workItemAssignedTo?: string;
};
```

No parsing/precedence changes — it rides the existing `filters` object through config load.

### Query builder (`src/integrations/azure/restAzureDevOpsApi.ts`)

`buildOpenWorkItemQuery(tag?)` becomes `buildOpenWorkItemQuery(tag?, assignedTo?)`. When
`assignedTo` is set it appends a clause:

```
[System.AssignedTo] = '<assignedTo, single-quote-escaped>'
```

escaped with the same `.replace(/'/g, "''")` the tag clause uses. Both clauses are
independent `AND` members of the existing `WHERE`, so tag-only, assignee-only, both, and
neither all fall out naturally. Ordering and the `SELECT`/`ORDER BY` are unchanged.

### API seam (`src/integrations/azure/azureDevOpsApi.ts`)

`listOpenWorkItems(tag?)` becomes `listOpenWorkItems(tag?, assignedTo?)` on the
`AzureDevOpsApi` interface. `RestAzureDevOpsApi.listOpenWorkItems` forwards `assignedTo`
into `buildOpenWorkItemQuery`.

### Provider (`src/integrations/azure/workItems.ts`)

`AzureWorkItemsOpts` gains `assignedTo?: string`. `snapshot()` passes it as the second arg
to `api.listOpenWorkItems(workItemTag, assignedTo)`. No mapping changes.

### Registry wiring (`src/integrations/registry.ts`)

The azure `issues` factory passes `assignedTo: az.filters?.workItemAssignedTo` into
`AzureDevOpsWorkItemsIntegration`, beside the existing `workItemTag`.

## Testing (`test/azureDevOpsIntegration.test.ts`)

All at the existing injected-fake seam — no network.

- Extend the `buildOpenWorkItemQuery` unit test: assignee-only clause, single-quote
  escaping of the assignee value, and tag + assignee combined (both clauses present, AND).
- The scripted fake `listOpenWorkItems(tag, assignedTo)` records the received `assignedTo`;
  a snapshot-level test asserts the configured assignee reaches the API call. Update the
  existing fake signature to accept the second arg (defaulting undefined) so current tests
  are unaffected.

## Verification

`npm run check` (format, lint, both typecheckers, knip, tests). Note the known Windows
CRLF false-positive in `format:check`; the unit tests are the real gate here.
