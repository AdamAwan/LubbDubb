---
name: pr-map
description: Draw a pull request as one interactive page — a map of what links to what, a numbered story of how it flows, and a Before/After toggle showing what the change does. Use when asked to visualise, map, diagram or explain a PR, a branch's diff, or "how this all links together".
argument-hint: '[PR number | branch | blank for the current diff]'
---

## Draw a PR map

The page answers three reviewer questions at once:

1. **What links to what?** A left-to-right map of the code on the path the PR changes.
2. **How does it flow?** A numbered story, one step per hop. Each number is also drawn on the map.
3. **What does this PR change, and why?** A Before/After toggle that changes the map and the
   story together, built around one concrete scenario.

You never write HTML. You write one JSON file; `build.mjs` checks it and renders it into
`template.html`. `example.json` is a finished map of PR #1091. Read it before you start, and
copy its shape.

### 1. Read the change

- Get the diff: the GitHub MCP `pull_request_read` (`get_files`, `get`), `gh pr diff <n>`, or
  `git diff <base>...HEAD` for a branch.
- Read the **old** code too (`git show <base>:<path>`). The Before side has to say what the old
  code really did. Don't guess it from the PR title.
- For each changed function, type or query, find what calls it and what it calls, one step out
  (`grep -rn`). Keep only the callers on the path the change affects.
- Read the PR's new tests first. A test usually spells out the exact scenario the fix is for,
  with real values. That is your scenario.

### 2. Pick the one path

A map shows **one path**: where the data or control starts, through the changed code, to the
thing that happens at the end. Things the PR touches off that path are left out, or added as
`test` / `doc` nodes in no step. If the PR does two unrelated things, draw two maps.

- **Columns** (2 to 6) are stages, left to right: e.g. Who → Store → Inputs → Rule → Outcome.
  Name them by role, not by folder.
- **Nodes** (2 to 14) are functions, types, tables, routes, or actions, never whole folders.
  `title` is the symbol name and `file` is the repo path.
- **status**: `changed`, `new` (faded in Before), `removed` (faded in After), `path`
  (unchanged but on the path), `outside` (a person or the outcome), `test`, `doc`.
- **Notes on a card**: `note` shows in both modes. `before` (red) and `after` (green) show in
  one mode only. Keep them to a few words.
- **Edges** go `from` → `to` in the direction data or control flows. `"changed": true`
  draws it orange in After. To set the line per mode, use `before` / `after`, each one of
  `normal`, `changed`, `blocked` (red with an X), `ghost` or `absent`. An action the PR adds
  is `"before": "absent"`, and a path the old code dead-ended is `"before": "blocked"`.
  `dashed` marks a weak link, like "returns this type". `label` writes a few words on the line.

### 3. Write the story

- **Steps** (2 to 8) go in flow order and are numbered by position. Each one names the
  `nodes` it lights up, and their files are shown on the step. Every `changed`, `new` and
  `removed` node must be in some step.
- The page opens on the first changed step. Set `focusStep` (1-based) to open on another one,
  usually the one with the timeline.
- An unchanged step has `text`. A changed step has `before` and `after`: one or two short
  sentences each, about what happens, not about the code's shape.
- The last step is the outcome: what the user, the operator or the system ends up with.
- `scenario` sets up the example in one or two sentences, ending on the question the
  Before/After answers.
- **Timeline** (optional, on the step where the decision happens): use it when the change is
  about time, ordering, counting, or which items are included. Give it `events` in order
  (`item` = square marker, `event` = circle marker, `focus` = the item the scenario is about,
  `now`), each with an optional `label` below, `top` above and `time`. Add a `windows.before` /
  `windows.after` bracket (`from`, optional `to`, as event indexes, plus a `label`) for what
  each version looks at. An optional `meter` (`label`, `max`) counts the `event` markers inside
  each bracket. If the change has none of these shapes, leave the timeline out. The
  before/after sentences carry it.

### 4. Write it plainly

Readers skim this page. Use short sentences and everyday words. Name what a person sees
("a checker is sent"), not the internals ("dispatch_code_agent emitted"). Put symbols in
backticks. `**bold**` is the only other markup. Every Before claim must be true of the old
code, and every After claim true of the new code. If you can't verify one, cut it.

### 5. Build and publish

```sh
node .claude/skills/pr-map/build.mjs <scratchpad>/pr-<n>-map.json
```

It prints the HTML path, or every problem in the data with exit code 1. Fix the problems and
run it again. Don't edit the HTML it writes. If the session has the Artifact tool, publish
that HTML file (`icon: "map"`). Otherwise send the file. Keep the JSON so a later edit is
a JSON edit and a rebuild.

To change how every map looks, edit `template.html`, then rebuild `example.json` and check
that it still renders.
