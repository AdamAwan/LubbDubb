---
name: pr
description: Help with a pull request. `map` draws it as one interactive page — a map of what links to what, a numbered story of how it flows, and a Before/After toggle. Use for "/lubbdubb:pr map 1091", or when asked to visualise, map, diagram or explain a PR, a branch's diff, or "how this all links together".
argument-hint: '<job> [PR number | branch | blank for the current diff]'
---

## Help with a pull request

The first word of the argument names the job; the rest is the PR it is about — a number, a
branch, or nothing for the current diff. Each job's instructions are a file in this skill's base
directory. Read that file in full and follow it.

| Job   | Read         | What it makes                                                         |
| ----- | ------------ | --------------------------------------------------------------------- |
| `map` | `map/map.md` | One page: a map of the code the PR changes, its story, Before/After. |

With no job named, or one not in the table, say which jobs there are and ask which one. When the
request plainly is one of them ("draw me a map of #1091"), do that one.
