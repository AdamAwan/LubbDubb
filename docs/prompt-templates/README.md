# Customising dispatch prompts

When LubbDubb picks up a work item (or reacts to a PR, meeting, or story), the **rule
dispatcher** sends the agent a prompt built from a template. Every template has a built-in
default, and any of them can be overridden per deployment — so a team can phrase the work in
terms of its own flow ("open a PR into `develop`", "link the Jira key", house conventions,
etc.) without touching code.

> Only the `rule` dispatcher uses these. The `claude` dispatcher composes its prompts with the
> LLM and is steered via `steeringPriorities` instead.

## How to override

1. Create the prompt-templates directory (default `.lubbdubb/prompts`, configurable via
   `promptTemplatesDir` in `lubbdubb.config.json`).
2. Copy the sample file for the prompt you want to change from this folder into it, keeping the
   filename (`<prompt-id>.md`) exactly.
3. Edit the body. Leave the ids you don't override alone — they keep their defaults.
4. Restart. Overrides are read once at boot.

The `.md` files in this folder are ready-to-copy samples of the current defaults, one per
prompt id.

## The doc header

A template file may start with an HTML comment describing what the prompt is for, when it
fires, and which placeholders it supports:

```md
<!--
  Sent to a code agent when an open issue has no linked PR. Placeholders: {number} {title} {body} {branch}.
-->

GitHub issue #{number} ("{title}") needs resolving.
...
```

The leading comment is **stripped before the prompt reaches the agent** — it's documentation
for whoever edits the file, not part of the prompt.

## Placeholders

Write `{name}` where you want a value substituted. Each prompt id supports a fixed set of
placeholders (listed in its sample's doc header); referencing one that isn't supported, or
naming a file after an id that doesn't exist, fails fast at boot with a clear error. Omitting a
placeholder is fine.

## Prompt ids

| id                        | when it fires                                               |
| ------------------------- | ----------------------------------------------------------- |
| `issue-pickup`            | an open work item has no linked PR and no agent is on it    |
| `issue-pickup-escalation` | issue pickup keeps failing to produce a linked PR (→ human) |
| `pr-ci-fix`               | a PR has failing CI and no agent is on its branch           |
| `pr-base-update-behind`   | a PR is behind its base branch (clean update)               |
| `pr-base-update-conflict` | a PR conflicts with its base branch                         |
| `pr-review-comment`       | a PR has an unhandled review comment                        |
| `pr-concern-escalation`   | a PR concern keeps failing to clear (→ human)               |
| `meeting-prep`            | a meeting has unread prep docs                              |
| `story-groom`             | a ready story lacks a description / acceptance criteria     |
| `story-waf`               | a ready story has no Well-Architected pillars               |
| `story-pickup`            | idle capacity; implement the highest-priority ready story   |
