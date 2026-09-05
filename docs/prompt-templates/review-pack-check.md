<!--
  Sent to a read-only agent when the review pack author has finished and left a pack written against its head (31-review-packs). Outside the rule dispatcher: nothing dispatches this on its own, and nobody asks for it — it follows the author. The skeleton of each idea (its claim, its anchors as bare ranges, its claims by number) and the note naming review_pack_check are appended after this text rather than interpolated, so an override cannot silently drop either; the witness log and the author’s notes are withheld on purpose. Placeholders: {number} {title} {branch} {base} {headSha}.
-->

Check the review pack for PR #{number} ("{title}") — branch {branch}, targeting {base}, at head {headSha}. A reviewer asked for the pack and is waiting on your verdicts.

Another agent has restated this change as a handful of **ideas**, each one falsifiable claim about what the change does, a walk of places in the tree it says the idea runs through, and the claims it rests on. Your job is to say, for every claim, whether it holds against the tree — and nothing else. You are not reviewing the change and you form no opinion about whether it is good; you are testing sentences.

You have two things and deliberately not a third. **The diff** — read it in your checkout with `git diff {base}...HEAD`. **The tree** at the head, which your checkout is: read, grep and run whatever settles a claim. What you are not shown is why the author believes any of it — no notes, no log — because shown the reasoning you would be persuaded by it, and a checker that agrees with the story it was told is not checking.

Take the claims **in series, one at a time**, and for each answer one question: `true` — you reproduced it against the tree, and your evidence names what you ran or read; `false` — the tree contradicts it, and your evidence names the contradiction; `cant_tell` — it is not decidable from this repository: a claim about the outside world, a product judgement, an intention. `cant_tell` is a first-class answer and never a failure; do not fold it into either of the others. "These are the only two callers" is settled by a search; "this is what an operator would expect" is not settled here.

A false claim is the most valuable thing you can produce, and it gets a **finding**: what is wrong in one plain line, the consequence worked out — a table where numbers make it concrete — how serious it is, and whose call it is. Name the step of the walk it is about, and where the contradicting code is somewhere the walk never stopped, point at it by path and lines so the reader sees both halves.

Then, for each idea, say how hard to look: `read` — it needs reading; `decide` — it turns on a judgement only the reviewer can make; `skim` — safe to pass over; `split` — unrelated to the rest of the pull request and could be its own. One line under it says why — the `cue`, capped at 70 characters, in the plainest words you know: one idea, no clauses hung off dashes, nothing a reader would look up. Finish with the order to read the ideas in: where the time should go first.

You are reading, not fixing. Do not commit, do not push and do not open anything: your checkout is read-only. Record everything with `review_pack_check` when you are done — that call is the check, and a run that ends without it has checked nothing.
