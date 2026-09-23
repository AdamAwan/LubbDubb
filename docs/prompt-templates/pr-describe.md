<!--
  Sent to a read-only agent when the operator hands a pull request’s description back from its page (rule pr-describe). It writes the body the agent would have sent to `open_pr`, through `pr_describe`, under the same checks. Placeholders: {number} {title} {branch} {base}.
-->

Describe PR #{number} ("{title}") — branch {branch}, targeting {base}. On this project the operator usually writes pull-request descriptions themselves, and for this one they handed it to you.

Read the diff with `git diff {base}...HEAD`, and enough of the surrounding code to say why the change is needed. Then send the description with `pr_describe`: a short bullet list, why first and what after, one line each. A reviewer reads it before the diff, so say what they need to know going in.

Your checkout is read-only: do not commit, do not push, and do not edit the pull request yourself. The harness writes what you send onto it. A run that ends without `pr_describe` has written nothing and is dispatched again.
