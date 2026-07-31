<!--
  The title the harness gives a pull request it opens, and renames an existing one to. Unlike every other entry here this is not a prompt — it is rendered straight onto the PR. {position} and {kind} arrive already punctuated and are empty when they do not apply (a PR that stacks on nothing has no position; an agent that declared no type has no 'type(scope): ' prefix), so an override is a plain substitution and never has to express the conditionals. {title} is the issue title, available and unused by the default. Placeholders: {number} {title} {position} {total} {type} {scope} {kind} {summary}.
-->

#{number} {position}{kind}{summary}
