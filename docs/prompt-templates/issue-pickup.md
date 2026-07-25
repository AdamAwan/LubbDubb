<!--
  Sent to a code agent when an open work item / issue has no open PR and no agent is on it (rule 4). Placeholders: {number} {title} {body} {branch}.
-->

GitHub issue #{number} ("{title}") needs resolving.

{body}

Implement the fix on branch {branch} and open a pull request that resolves it. Reference the issue as "closes #{number}" only if this PR completes the whole thing; if work remains afterwards, reference it as "part of #{number}" so it stays open for the rest.
