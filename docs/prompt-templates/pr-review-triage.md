<!--
  Sent to a desk agent to choose which review mode a pull request gets (rule pr-review-triage), on a project that declares more than one in `review.modes`, or that allows the triage to skip a review (`review.allowSkip`) — either is enough, since with a skip on offer one declared mode is still two answers. It sees no code: a routing decision that needed the diff would cost what the review costs. The project's routing charter (review.routingCharterFile) is appended after this text rather than interpolated, so an override cannot silently drop it, and so is the note about skipping where the project allows one — for the same reason, and because a skip is the one answer that also releases the merge gate. {modes} is the comma-joined list of declared mode names. Placeholders: {number} {title} {branch} {base} {modes}.
-->

Decide how PR #{number} ("{title}") should be reviewed — branch {branch}, targeting {base}. This project reviews in these modes: {modes}.

You are not reviewing the change. You are choosing what kind of read it needs, and an agent is dispatched on your answer with a different brief and a different model depending on what you say. You have the shape of the change rather than its contents — its title, its branch, its target, and whatever the tracker says about the goal behind it. Ask `world_read` for the pull request and its issue if you need more than you were given.

Answer with `review_route`. Where what this project says below does not settle it, choose the more thorough mode: over-reading a small change costs minutes, and under-reading a dangerous one costs the defect nobody caught.
