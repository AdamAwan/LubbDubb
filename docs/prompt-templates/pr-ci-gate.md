<!--
  Sent to a code agent when a check is waiting rather than failing (rule `pr-ci-gate`): either a `ci.checks` rule watches it in a non-failing state (`states`), or the provider reports it **expired** — an Azure build policy whose last run predates the branch's commits, which resolves only when a new build is queued. The check names, the rule's guidance and the expiry note are *appended* after this text rather than interpolated, so an override that never learned about them cannot silently drop them. Placeholders: {number} {title} {branch}.
-->

A required check on PR #{number} ("{title}", branch {branch}) is waiting, not failing. Nothing is red: there is no broken build and no failing test here. The check is a gate that stays queued until something is done to release it, and until then the pull request cannot complete.

Do what the guidance below names, and nothing else. Do not edit code, configuration or workflows to try to shift the check, and do not "fix" the branch — the gate is not a symptom of the diff. If the guidance does not apply, or you cannot carry it out, escalate to a human and say what you found; guessing at a gate somebody else owns burns attempts and changes nothing.
