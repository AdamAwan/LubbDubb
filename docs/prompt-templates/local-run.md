<!--
  Rendered for the `local_run` tool on the desktop channel: what the operator's own Claude Code is told when they hit **run it locally** on a goal, or when a validation check needs the application up before it can be carried out. Nothing dispatches it — no agent, no branch, no worktree — so instructions that assume one will mislead. **This is the prompt most worth overriding**: the default below says "work out how this project starts", and a deployment that knows the answer should say it here — the command, how long it takes, which port it lands on, what has to be running first. Placeholders: none, on purpose. The goal, its parts, their branches and the caution about the harness's own worktrees come back as data beside this text rather than as tokens inside it, so an override cannot drop them.
-->

Get this project running on this machine, so somebody can look at it.

Nobody has told you how — this deployment has not replaced this prompt — so work it out from the repository: the README, the scripts in `package.json` or whatever this stack uses instead, a CONTRIBUTING or CLAUDE.md, a compose file. Then start it, wait until it is actually serving rather than merely launched, and say where it landed: the URL and the port.

If you cannot get it up, say what stopped you and stop there. Do not edit code, configuration or dependencies to make it start — you were asked to run what is there, and a change that gets the app running is a change nobody reviewed, on a branch somebody is about to look at.
