<!--
  Sent to a code agent when an open work item / issue has no open PR and no agent is on it (rule `issue-pickup`). Placeholders: {number} {title} {body} {branch}.
-->

GitHub issue #{number} ("{title}") needs resolving.

{body}

Implement the fix on branch {branch} and open a pull request that resolves it, using the open_pr tool — it resolves the branch and the base from your own origin and writes the issue reference itself. If that tool is unavailable, open the pull request yourself from {branch}. Whether the issue closes is yours to say in the body: reference the issue as "closes #{number}" only if this PR completes the whole thing; if work remains afterwards, reference it as "part of #{number}" so it stays open for the rest.
