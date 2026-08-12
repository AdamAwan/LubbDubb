<!--
  Sent to a code agent when a `ci.checks` rule watches a check in a non-failing state (`states`) and that check is in it — the blocking gate that sits pending until something outside the harness acts (rule `pr-ci-gate`). The check names and the rule's guidance are *appended* after this text rather than interpolated, so an override that never learned about them cannot silently drop them. Placeholders: {number} {title} {branch}.
-->

A required check on PR #{number} ("{title}", branch {branch}) is waiting, not failing. Nothing is red: there is no broken build and no failing test here. The check is a gate that stays queued until something is done to release it, and until then the pull request cannot complete.

Do what the guidance below names, and nothing else. Do not edit code, configuration or workflows to try to shift the check, and do not "fix" the branch — the gate is not a symptom of the diff. If the guidance does not apply, or you cannot carry it out, escalate to a human and say what you found; guessing at a gate somebody else owns burns attempts and changes nothing.
