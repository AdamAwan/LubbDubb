import type { TemplateDef } from './promptTemplates.js';

export const PULL_REQUEST_PROMPTS = {
  'pr-ci-fix': {
    placeholders: ['number', 'title', 'branch'],
    template: 'CI is failing on PR #{number} ("{title}", branch {branch}). Investigate the failure and push a fix.',
    doc: 'Sent to a code agent when a PR has failing CI and no agent is on its branch. Placeholders: {number} {title} {branch}.',
  },
  'pr-ci-gate': {
    placeholders: ['number', 'title', 'branch'],
    template:
      'A required check on PR #{number} ("{title}", branch {branch}) is waiting, not failing. Nothing is red: there is no broken build and no failing test here. The check is a gate that stays queued until something is done to release it, and until then the pull request cannot complete.\n\n' +
      'Do what the guidance below names, and nothing else. Do not edit code, configuration or workflows to try to shift the check, and do not "fix" the branch — the gate is not a symptom of the diff. ' +
      'If the guidance does not apply, or you cannot carry it out, escalate to a human and say what you found; guessing at a gate somebody else owns burns attempts and changes nothing.',
    doc: "Sent to a code agent when a check is waiting rather than failing (rule `pr-ci-gate`): either a `ci.checks` rule watches it in a non-failing state (`states`), or the provider reports it **expired** — an Azure build policy whose last run predates the branch's commits, which resolves only when a new build is queued. The check names, the rule's guidance and the expiry note are *appended* after this text rather than interpolated, so an override that never learned about them cannot silently drop them. Placeholders: {number} {title} {branch}.",
  },
  'pr-base-update-behind': {
    placeholders: ['number', 'title', 'branch', 'base'],
    template:
      'PR #{number} ("{title}") is behind its base branch {base}. Merge {base} into {branch} to bring it up to date, then push. No conflicts are expected — this is a routine update.',
    doc: 'Sent to a code agent when a PR is behind its base branch (clean, no conflicts). Placeholders: {number} {title} {branch} {base}.',
  },
  'pr-base-update-conflict': {
    placeholders: ['number', 'title', 'branch', 'base'],
    template:
      'PR #{number} ("{title}") has merge conflicts with its base branch {base}. Merge {base} into {branch}, resolve the conflicts, and push. If you cannot resolve them cleanly, escalate for a human.',
    doc: 'Sent to a code agent when a PR conflicts with its base branch. Placeholders: {number} {title} {branch} {base}.',
  },
  'pr-review-triage': {
    placeholders: ['number', 'title', 'branch', 'base', 'modes'],
    template:
      'Decide how PR #{number} ("{title}") should be reviewed — branch {branch}, targeting {base}. This ' +
      'project reviews in these modes: {modes}.\n\n' +
      'You are not reviewing the change. You are choosing what kind of read it needs, and an agent is ' +
      'dispatched on your answer with a different brief and a different model depending on what you say. ' +
      'You have the shape of the change rather than its contents — its title, its branch, its target, and ' +
      'whatever the tracker says about the goal behind it. Ask `world_read` for the pull request and its ' +
      'issue if you need more than you were given.\n\n' +
      'Answer with `review_route`. Where what this project says below does not settle it, choose the more ' +
      'thorough mode: over-reading a small change costs minutes, and under-reading a dangerous one costs ' +
      'the defect nobody caught.',
    doc: "Sent to a desk agent to choose which review mode a pull request gets (rule pr-review-triage), on a project that declares more than one in `review.modes`. It sees no code: a routing decision that needed the diff would cost what the review costs. The project's routing charter (review.routingCharterFile) is appended after this text rather than interpolated, so an override cannot silently drop it. {modes} is the comma-joined list of declared mode names. Placeholders: {number} {title} {branch} {base} {modes}.",
  },
  'pr-split': {
    placeholders: ['number', 'title', 'branch', 'base', 'files', 'budget', 'issue', 'plan'],
    template:
      'PR #{number} ("{title}") — branch {branch}, targeting {base} — changes {files} files, past this ' +
      "project's budget of {budget}. Answer one question about it: **is this one piece of work, or several?**\n\n" +
      'The count is why you are reading it. It is not the answer. A rename across sixty files is one concept ' +
      'and belongs in one pull request; twelve files spanning a schema change, a new endpoint and an ' +
      'unrelated refactor are three, and should have been three. What makes a diff several is that its ' +
      'pieces could have been reviewed, merged and reverted independently of each other — not that it is ' +
      'long.\n\n' +
      'Read the diff against {base} with `git diff {base}...HEAD`, and read enough of the surrounding code to ' +
      'tell a seam from a coincidence. It belongs to issue #{issue}.\n\n{plan}\n\n' +
      'Then answer with `split_assess`, and answer once:\n\n' +
      '- **coherent** — one concept, however wide. Nothing happens and nothing asks again, so your reason is ' +
      'the whole record of why a wide pull request was left alone. This is the right answer more often than ' +
      'the count suggests.\n' +
      '- **split** — name the concepts, then propose the plan that separates them with `plan_correct` in this ' +
      'same turn. One part per concept; the concept this pull request should keep goes first, under the slug ' +
      'its part already has, and the rest become parts that depend on it. Submit the **whole** plan document, ' +
      'every part you are keeping included.\n\n' +
      'You are reading, not cutting. Your checkout is read-only: do not commit, do not push, do not close the ' +
      'pull request and do not open another. An amendment changes nothing by itself — an operator decides, ' +
      'the plan keeps running while they do, and the agent on this pull request is neither stopped nor ' +
      're-dispatched. A run that ends without `split_assess` has answered nothing and the question is asked ' +
      'again.',
    doc: 'Sent to a read-only agent when a watched pull request has grown past `planning.fileBudget` changed files (rule pr-split). It reads the diff to say whether the width is one concept or several, and proposes the plan that separates them when it is several. {files} is what the provider reported, {budget} the configured number, {issue} the issue the pull request belongs to, and {plan} the current plan rendered for a corrector — or a sentence saying there is no plan. Placeholders: {number} {title} {branch} {base} {files} {budget} {issue} {plan}.',
  },
  'pr-describe': {
    placeholders: ['number', 'title', 'branch', 'base'],
    template:
      'Describe PR #{number} ("{title}") — branch {branch}, targeting {base}. On this project the operator ' +
      'usually writes pull-request descriptions themselves, and for this one they handed it to you.\n\n' +
      'Read the diff with `git diff {base}...HEAD`, and enough of the surrounding code to say why the change ' +
      'is needed. Then send the description with `pr_describe`: a short bullet list, why first and what ' +
      'after, one line each. A reviewer reads it before the diff, so say what they need to know going in.\n\n' +
      'Your checkout is read-only: do not commit, do not push, and do not edit the pull request yourself. The ' +
      'harness writes what you send onto it. A run that ends without `pr_describe` has written nothing and ' +
      'is dispatched again.',
    doc: 'Sent to a read-only agent when the operator hands a pull request\u2019s description back from its page (rule pr-describe). It writes the body the agent would have sent to `open_pr`, through `pr_describe`, under the same checks. Placeholders: {number} {title} {branch} {base}.',
  },
  'pr-description-check': {
    placeholders: ['number', 'title', 'branch', 'base', 'id', 'description'],
    template:
      'Check the description the operator wrote for PR #{number} ("{title}") — branch {branch}, targeting ' +
      '{base}. A person wrote it, in their own words, and a reviewer will read it before the diff. Your job ' +
      'is to tell them, before that reviewer does, where it and the change disagree.\n\n' +
      'The description (version {id}):\n\n{description}\n\n' +
      'Read the diff with `git diff {base}...HEAD`, and enough of the surrounding code to judge it. Then ' +
      'report with `description_review`, addressing version {id}.\n\n' +
      '**Do not be picky.** This is not a review of the code and not an edit of their prose. Wording, ' +
      'style, length, tone and small details a reviewer would not miss are not findings. Report only:\n' +
      '- **contradicted** — the description says something the diff does not do, or says it wrongly. ' +
      'These ask them to change it.\n' +
      '- **gap** — the diff does something a reviewer would want to know going in and the description ' +
      'does not say: something that cannot be undone, a behaviour change, a wide reach. These are ' +
      'low-priority notes, so only the ones worth a reader\u2019s minute.\n\n' +
      'A description that stands up is reported with an empty list — that is the ordinary result, not a ' +
      'failure. Never send a rewritten description or suggested wording: the tool has no field for one and ' +
      'the operator writes their own. Your checkout is read-only: do not commit, do not push, and do not ' +
      'edit the pull request. A run that ends without `description_review` has checked nothing and is ' +
      'dispatched again.',
    doc: 'Sent to a read-only agent when the operator writes or rewrites a pull request\u2019s description (rule pr-description-check). It reads the description against the diff and reports findings through `description_review`, never text. {id} is the version it read and {description} the operator\u2019s text, verbatim. Placeholders: {number} {title} {branch} {base} {id} {description}.',
  },
  'pr-review': {
    placeholders: ['number', 'title', 'branch', 'base'],
    template:
      'Review PR #{number} ("{title}") — branch {branch}, targeting {base}. You are the first reader this ' +
      'change gets, before the person whose approval it needs.\n\n' +
      'Read the diff against {base}, then read enough of the surrounding code to say whether the change is ' +
      'right — not merely whether it is tidy. What a reviewer wants raised: something that does not do what ' +
      'the pull request says it does, a case the change breaks, a value that can be absent where it is read, ' +
      'a convention of this repository the change quietly departs from, a test that asserts the thing that ' +
      'was already true. Say where each one is.\n\n' +
      'You are reading, not fixing. Do not commit, do not push and do not open anything: your checkout is ' +
      'read-only, and a finding is worth more than a fix nobody asked you for. Report with `review_report` ' +
      'when you are done — that call is the review, and a run that ends without it has reviewed nothing.\n\n' +
      'You get one pass. Nothing reviews this pull request again after a push, so say everything you have ' +
      'to say now — and say nothing you would not want a colleague to have stopped a merge for.',
    doc: 'Sent to a read-only agent when a watched pull request has not been reviewed by the fleet (rule pr-review). What the project asks its reviewers to look at (review.charterFile) and what to do with the findings (review.publish) are appended after this text rather than interpolated, so an override cannot silently drop either. Placeholders: {number} {title} {branch} {base}.',
  },
  'review-pack-author': {
    placeholders: ['number', 'title', 'branch', 'base', 'headSha'],
    template:
      'Write the review pack for PR #{number} ("{title}") — branch {branch}, targeting {base}, at head {headSha}. ' +
      'A reviewer asked for it and is waiting.\n\n' +
      'A review pack restates the change for the person who has to read it: a handful of **ideas**, each ' +
      'followed through every file it touched in the order the reasoning ran — never the order the files sort ' +
      'in. An idea is one falsifiable claim plus a walk of anchors; the anchors carry the code, and under each ' +
      'idea sit the claims it rests on. It is not a summary and not a review: every sentence in it is something ' +
      'a second agent can mark true or false against the tree, or a gist attached to code the reader can see. ' +
      'You form no opinion about whether the change is good.\n\n' +
      'You have three things. **The diff** — read it in your checkout with `git diff {base}...HEAD`; its hunks ' +
      'are listed below by id. **The witness log** — what the agents that made the change wrote as they went, ' +
      'appended below verbatim, forks and all; it is where the rejected alternatives live, which a diff can ' +
      'never recover. **The tree** at the head, which your checkout is: read whatever the change cannot be ' +
      'judged without.\n\n' +
      'The log is unreliable in one exact way: **where an entry and the code disagree, the code wins, and the ' +
      'disagreement is a finding** — a `disputed` claim stating what the code does, citing the entry it ' +
      'contradicts. Do not hedge everything and do not manufacture disagreements; quote the log where it ' +
      'holds, cite it as `witnessed`, and mark your own reading `inferred`.\n\n' +
      'What makes a pack worth more than the diff is the **`region` anchor**: a range of a file the diff does ' +
      'not touch. Two kinds, and reach for both — context the change cannot be judged without, and the ' +
      '**deliberate absence**: the file a reader would expect to have changed, shown unchanged, with the reason. ' +
      'Most of what goes wrong in this repository is "changed A and did not change B", and no diff can show ' +
      'an absence. Read `CLAUDE.md` for the pairs that must move together.\n\n' +
      'Write for the person: the `title` of an idea and the `gist` of an anchor say what changed and why it ' +
      'matters the way a colleague would across a desk, with the identifiers in the code and not the prose; ' +
      'the `claim` is for the checker and is one sentence that can be shown false. "This is cleaner" is not a ' +
      'claim; "these are the only two callers" is. The `summary` is bullets, not a paragraph — it is the part ' +
      'every reader reads, and prose is the part they skim. **Put no bold in it**: a bullet with three bolded ' +
      'fragments is read as three keywords and no sentence, and the reader takes nothing from it.\n\n' +
      '**A `gist` says why, never what.** The code is directly under it, so a gist the reader could have ' +
      'written from the diff is a line spent saying nothing: "new interface member", "the comment now says X", ' +
      '"fold and predicate become shared consts". Say what the reader would otherwise have had to work out — ' +
      'why the change is there, what it means for them, what it would have broken done the other way. If the ' +
      'only true thing to say is what the diff already shows, the anchor is one to drop, not to caption.\n\n' +
      '**Say it in as few words as you can, in the plainest ones you know.** Your reader is a developer with ' +
      'ten minutes and four other tabs open. Every field is capped and the tool refuses one that runs over, so ' +
      'write short first rather than trimming afterwards. Four rules, and the tool refuses a field that breaks ' +
      'any of them, naming the sentence:\n\n' +
      '1. **No semicolon.** It is a full stop that will not admit it. Use the full stop.\n' +
      '2. **No clause hung off a dash.** A dash with a space each side is how one long sentence hides that it ' +
      'is two. Write the two.\n' +
      '3. **No sentence over 24 words.** One idea per sentence.\n' +
      '4. **The plainest word that is still true**, and the identifiers in the code rather than the prose. The ' +
      'pack as a whole is scored for reading ease and refused under 60, which is about a newspaper.\n\n' +
      'Before and after:\n\n' +
      "- *No:* \"Which pull requests are the goal's, and in what order. Archive first, the world's closed " +
      'window second, so the fresher reading of the same PR wins."\n' +
      '- *Yes:* "Get the relevant pull requests in the right order, use the latest."\n\n' +
      'And a warning about the tree you are standing in: **this codebase is written in a dense house style**, ' +
      'long sentences and dashes and all. Do not copy it. You will have just read a great deal of it, which is ' +
      'exactly when it starts coming out in your own writing.\n\n' +
      '**Tests are never an idea of their own.** A "Tests" section separates a change from its evidence, so the ' +
      'reader who has just decided whether the code is right has to go elsewhere to learn whether it is ' +
      "exercised. Give each test hunk to the idea it exercises, and list what it covers as that idea's " +
      '`coverage`: one short line per scenario, named and not explained — "an unwitnessed pull request still ' +
      'renders", never a paragraph about the test. The reader wants assurance the cases were thought of, and ' +
      'nothing more. A pack whose idea owns test hunks and lists no scenarios is refused.\n\n' +
      'You are reading, not fixing. Do not commit, do not push and do not open anything: your checkout is ' +
      'read-only. Submit with `review_pack_submit` when you are done — that call is the pack, and a run that ' +
      'ends without it has written nothing.',
    retired: true,
    doc:
      '**Retired — no longer rendered.** It was sent to the agent that wrote a review pack, and review packs ' +
      'were removed from the harness. The id stays loadable so a deployment that overrode it still boots; the ' +
      'override is read and never used.',
  },
  'review-pack-check': {
    placeholders: ['number', 'title', 'branch', 'base', 'headSha'],
    template:
      'Check the review pack for PR #{number} ("{title}") — branch {branch}, targeting {base}, at head {headSha}. ' +
      'A reviewer asked for the pack and is waiting on your verdicts.\n\n' +
      'Another agent has restated this change as a handful of **ideas**, each one falsifiable claim about what ' +
      'the change does, a walk of places in the tree it says the idea runs through, and the claims it rests ' +
      'on. Your job is to say, for every claim, whether it holds against the tree — and nothing else. You are ' +
      'not reviewing the change and you form no opinion about whether it is good; you are testing sentences.\n\n' +
      'You have two things and deliberately not a third. **The diff** — read it in your checkout with ' +
      '`git diff {base}...HEAD`. **The tree** at the head, which your checkout is: read, grep and run whatever ' +
      'settles a claim. What you are not shown is why the author believes any of it — no notes, no log — ' +
      'because shown the reasoning you would be persuaded by it, and a checker that agrees with the story it ' +
      'was told is not checking.\n\n' +
      'Take the claims **in series, one at a time**, and for each answer one question: `true` — you reproduced ' +
      'it against the tree, and your evidence names what you ran or read; `false` — the tree contradicts it, ' +
      'and your evidence names the contradiction; `cant_tell` — it is not decidable from this repository: a ' +
      'claim about the outside world, a product judgement, an intention. `cant_tell` is a first-class answer ' +
      'and never a failure; do not fold it into either of the others. "These are the only two callers" is ' +
      'settled by a search; "this is what an operator would expect" is not settled here.\n\n' +
      'A false claim is the most valuable thing you can produce, and it gets a **finding**: what is wrong in ' +
      'one plain line, the consequence worked out — a table where numbers make it concrete — how serious it ' +
      'is, and whose call it is. Name the step of the walk it is about, and where the contradicting code is ' +
      'somewhere the walk never stopped, point at it by path and lines so the reader sees both halves.\n\n' +
      "The finding's **first paragraph is the whole of it** in plain words — what is wrong, and what it costs. " +
      'Everything after that paragraph is the argument for it, and both renderings fold the argument away, so ' +
      'a reader who reads only the opening must still have the finding. Do not open with the setup and arrive ' +
      'at the point in the third paragraph.\n\n' +
      'Everything you write is held to the same four rules as the author, and refused the same way: **no ' +
      'semicolon**, **no clause hung off a dash**, **no sentence over 24 words**, and the plainest word that is ' +
      'still true — the finding and the cues are scored for reading ease as a whole and refused under 60.\n\n' +
      'Then, for each idea, say how hard to look: `read` — it needs reading; `decide` — it turns on a judgement ' +
      'only the reviewer can make; `skim` — safe to pass over; `split` — unrelated to the rest of the pull ' +
      'request and could be its own. One line under it says why — the `cue`, capped at 70 characters, in the ' +
      'plainest words you know: one idea, no clauses hung off dashes, nothing a reader would look up. Finish ' +
      'with the order to read the ideas in: where the time should go first.\n\n' +
      'You are reading, not fixing. Do not commit, do not push and do not open anything: your checkout is ' +
      'read-only. Record everything with `review_pack_check` when you are done — that call is the check, and a ' +
      'run that ends without it has checked nothing.',
    retired: true,
    doc:
      '**Retired — no longer rendered.** It was sent to the agent that checked a review pack’s claims, and ' +
      'review packs were removed from the harness. The id stays loadable so a deployment that overrode it still ' +
      'boots; the override is read and never used.',
  },
  'pr-review-comment': {
    placeholders: ['number', 'branch', 'author', 'comment'],
    template:
      'There is unaddressed review feedback on PR #{number} (branch {branch}), from {author}. Every unresolved thread is listed below.\n\n' +
      'Read all of them before you change anything. They usually come from one review pass, so they are related: a fix for one may already resolve another, or contradict it. Work out what the reviewer is asking for as a whole, then make one coherent set of changes.\n\n' +
      'For each thread, decide whether to fix the code or defend the current approach, and reply to that thread saying which you did — a thread you fix silently is still open in front of the reviewer, and the fleet is sent back to it.',
    doc: "Sent to a code agent to address the unhandled review comments on a PR — all of them, in one dispatch, since comments from a single review are related and answering them one at a time produces contradictory fixes. The threads themselves are appended after this text rather than interpolated, so an override cannot silently drop them, and after those the instruction to re-read them with world_read before finishing — a reviewer can add a thread or reword one while the agent works. {author} is the comma-joined list of thread authors and {comment} the first thread's body; both are kept filled so an override written against the older single-comment prompt still renders something true. Placeholders: {number} {branch} {author} {comment}.",
  },
  'pr-concern-escalation': {
    placeholders: ['number', 'title', 'attempts'],
    template:
      'Auto-resolution of "{title}" keeps failing: {attempts} agent attempt(s) on PR #{number} left the concern unresolved. Please handle it manually.',
    doc: 'Escalated to a human when a PR concern (CI / base / comment) keeps failing to clear. Placeholders: {number} {title} {attempts}.',
  },
  'pr-title': {
    placeholders: ['number', 'title', 'position', 'total', 'type', 'scope', 'kind', 'summary'],
    template: '#{number} {position}{kind}{summary}',
    doc: "The title the harness gives a pull request it opens, and renames an existing one to. Unlike every other entry here this is not a prompt — it is rendered straight onto the PR. {position} and {kind} arrive already punctuated and are empty when they do not apply (a PR that stacks on nothing has no position; an agent that declared no type has no 'type(scope): ' prefix), so an override is a plain substitution and never has to express the conditionals. {title} is the issue title, available and unused by the default. Placeholders: {number} {title} {position} {total} {type} {scope} {kind} {summary}.",
  },
} satisfies Record<string, TemplateDef>;
