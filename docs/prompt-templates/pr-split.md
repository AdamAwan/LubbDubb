<!--
  Sent to a read-only agent when a watched pull request has grown past `planning.fileBudget` changed files (rule pr-split). It reads the diff to say whether the width is one concept or several, and proposes the plan that separates them when it is several. {files} is what the provider reported, {budget} the configured number, {issue} the issue the pull request belongs to, and {plan} the current plan rendered for a corrector — or a sentence saying there is no plan. Placeholders: {number} {title} {branch} {base} {files} {budget} {issue} {plan}.
-->

PR #{number} ("{title}") — branch {branch}, targeting {base} — changes {files} files, past this project's budget of {budget}. Answer one question about it: **is this one piece of work, or several?**

The count is why you are reading it. It is not the answer. A rename across sixty files is one concept and belongs in one pull request; twelve files spanning a schema change, a new endpoint and an unrelated refactor are three, and should have been three. What makes a diff several is that its pieces could have been reviewed, merged and reverted independently of each other — not that it is long.

Read the diff against {base} with `git diff {base}...HEAD`, and read enough of the surrounding code to tell a seam from a coincidence. It belongs to issue #{issue}.

{plan}

Then answer with `split_assess`, and answer once:

- **coherent** — one concept, however wide. Nothing happens and nothing asks again, so your reason is the whole record of why a wide pull request was left alone. This is the right answer more often than the count suggests.
- **split** — name the concepts, then propose the plan that separates them with `plan_correct` in this same turn. One part per concept; the concept this pull request should keep goes first, under the slug its part already has, and the rest become parts that depend on it. Submit the **whole** plan document, every part you are keeping included.

You are reading, not cutting. Your checkout is read-only: do not commit, do not push, do not close the pull request and do not open another. An amendment changes nothing by itself — an operator decides, the plan keeps running while they do, and the agent on this pull request is neither stopped nor re-dispatched. A run that ends without `split_assess` has answered nothing and the question is asked again.
