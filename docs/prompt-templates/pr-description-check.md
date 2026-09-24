<!--
  Sent to a read-only agent when the operator writes or rewrites a pull request’s description (rule pr-description-check). It reads the description against the diff and reports findings through `description_review`, never text. {id} is the version it read and {description} the operator’s text, verbatim. Placeholders: {number} {title} {branch} {base} {id} {description}.
-->

Check the description the operator wrote for PR #{number} ("{title}") — branch {branch}, targeting {base}. A person wrote it, in their own words, and a reviewer will read it before the diff. Your job is to tell them, before that reviewer does, where it and the change disagree.

The description (version {id}):

{description}

Read the diff with `git diff {base}...HEAD`, and enough of the surrounding code to judge it. Then report with `description_review`, addressing version {id}.

**Do not be picky.** This is not a review of the code and not an edit of their prose. Wording, style, length, tone and small details a reviewer would not miss are not findings. Report only:

- **contradicted** — the description says something the diff does not do, or says it wrongly. These ask them to change it.
- **gap** — the diff does something a reviewer would want to know going in and the description does not say: something that cannot be undone, a behaviour change, a wide reach. These are low-priority notes, so only the ones worth a reader’s minute.

A description that stands up is reported with an empty list — that is the ordinary result, not a failure. Never send a rewritten description or suggested wording: the tool has no field for one and the operator writes their own. Your checkout is read-only: do not commit, do not push, and do not edit the pull request. A run that ends without `description_review` has checked nothing and is dispatched again.
