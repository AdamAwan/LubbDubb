---
name: pr
description: Help with a pull request. `map` draws it as one interactive page — a map of what links to what, a numbered story of how it flows, and a Before/After toggle. `walk` goes through it with the person one stop at a time, answering their questions and noting possible issues, with a side panel that follows along. Use for "/pr-assistant:pr map 1091" or "/pr-assistant:pr walk 1091", when asked to visualise, map, diagram or explain a PR, a branch's diff, or "how this all links together", or to go through or review a PR together.
argument-hint: '<job> [PR number | branch | blank for the current diff]'
---

## Help with a pull request

The first word of the argument names the job; the rest is the PR it is about — a number, a
branch, or nothing for the current diff. Each job's instructions are a file in this skill's base
directory. Read that file in full and follow it.

| Job    | Read           | What it makes                                                                      |
| ------ | -------------- | ---------------------------------------------------------------------------------- |
| `map`  | `map/map.md`   | One page: a map of the code the PR changes, its story, Before/After.               |
| `walk` | `walk/walk.md` | A walk through the PR with the person, one stop at a time, noting possible issues. |

With no job named, or one not in the table, say which jobs there are and ask which one. When the
request plainly is one of them ("draw me a map of #1091", "go through #1091 with me"), do that one.
