import type { TemplateDef } from './promptTemplates.js';

export const ISSUE_PROMPTS = {
  'issue-plan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile'],
    template:
      'Issue #{number} ("{title}") needs a delivery plan before any code is written.\n\n{body}\n\n' +
      'Read the repository first, and plan from what is actually there. Every field below is worth having ' +
      'from someone who has read the code and worth nothing from someone who has read only the ticket.\n\n' +
      '## How much to cut it into\n\n' +
      'A plan is a list of parts, and one part is a perfectly ordinary plan — most work is one pull request, and ' +
      'saying so is not a lesser answer or a special case. Nothing downstream treats a one-part plan differently ' +
      'from an eight-part one, so spend your judgement on whether the parts are *right*, not on getting the ' +
      'count low. Add a part when a piece has to merge before the next can be written, when two pieces would be ' +
      'reviewed by different people, or when one of them is genuinely independent work. Do not add one to make ' +
      'the plan look thorough: a twenty-minute fix cut into three parts costs far more than it saves.\n\n' +
      '## How to submit it\n\n' +
      'Use the **plan_submit** tool if you have it: it validates on the spot and hands back the reason if it ' +
      'refuses, so you can fix and call again in the same turn. Otherwise write the same JSON to {planFile} in ' +
      'this worktree, creating the directory if needed. At least one part is required:\n\n' +
      '  {"version": 1,\n' +
      '   "diagnosis": "...", "approach": "...", "reason": "...", "verification": "...",\n' +
      '   "alternatives": "...", "openQuestions": "...", "risks": "...", "outOfScope": "...",\n' +
      '   "evidence": [{"path": "src/store/plans.ts", "line": 118, "note": "what to look at here"}],\n' +
      '   "document": "<the full write-up, markdown>",\n' +
      '   "parts": [\n' +
      '     {"slug": "schema", "title": "...", "scope": "...", "touches": ["src/store/"], "size": "s",\n' +
      '      "dependsOn": [], "rationale": "...", "acceptance": "..."},\n' +
      '     {"slug": "wire-up", "title": "...", "scope": "...", "touches": ["src/system.ts"], "size": "m",\n' +
      '      "dependsOn": ["schema"], "rationale": "...", "acceptance": "..."}\n' +
      '   ],\n' +
      '   "validation": {"hint": "..."}}\n\n' +
      'Nothing here needs to be guessed at: submit it, and a rejection tells you exactly which field was wrong.\n\n' +
      '## What the fields mean\n\n' +
      '**`diagnosis`, `approach` and `verification` are a quick overview, not the argument.** Write each as ' +
      'markdown bullets — one plain-English point per bullet, a line or so each, four or five at most. No ' +
      'file paths, no line numbers: name the code in words ("the bulk workflow handler", "the target ' +
      'resolver"). The paths belong in `evidence`, which is drawn beside the diagnosis as links, and the ' +
      'full reasoning belongs in `document`. Somebody reads these three side by side to decide in a minute ' +
      'whether the work happens; a paragraph makes them hunt for the points, and a path mid-sentence is a ' +
      'token they cannot click. The prose fields — `alternatives`, `openQuestions`, `reason` — are arguments ' +
      'rather than lists, and stay sentences.\n\n' +
      'Four of them carry the whole decision, and they are the four nobody can reconstruct from the rest.\n\n' +
      '- **diagnosis** — what is actually wrong, in the code, named precisely. "The cache is never ' +
      'invalidated because the refresh writes the new value under the old key" is a diagnosis. "Users ' +
      'see stale data" is the ticket, restated. If you find yourself writing the issue text back, you have not ' +
      'read far enough yet. Leave it out only when the work is not a defect and there is genuinely nothing to ' +
      'diagnose — there is no root cause of a feature.\n' +
      '- **approach** — what you are going to do about it, one bullet per move you are ' +
      'making. Not the shape of the pull requests: the change.\n' +
      '- **alternatives** — what you considered and rejected, and why each was rejected. Name options you ' +
      'actually weighed, not strawmen. This is the field an operator reads to decide whether you looked around ' +
      'before you chose, and a plan with none reads as the first idea you had.\n' +
      '- **openQuestions** — the assumption you would most like argued with, and what would change your mind. ' +
      'Be specific about the decision rather than modest about the plan: "I assumed the retry belongs in the ' +
      'client, but if the server owns idempotency it belongs there instead" is useful; "there may be edge ' +
      'cases" is not. If the operator opens a discussion, this is its agenda. One or two short sentences: it ' +
      'is drawn as a tick box the operator must read before they may approve, and the write-up is where the ' +
      'long version goes.\n\n' +
      'And four that make the rest checkable:\n\n' +
      '- **evidence** — the places you read that the diagnosis rests on, as `path` (+ optional `line`) and a ' +
      '`note` saying what the reader is meant to see. A root cause with no citation cannot be checked, and ' +
      'one that can be checked in four seconds is worth far more than one that is merely well argued.\n' +
      '- **verification** — how anyone will know the *whole* thing worked once every part has landed, one ' +
      'bullet per thing that has to be true. Not per ' +
      'part (that is "acceptance"), and not "the tests pass" unless the tests genuinely settle it.\n' +
      '- **reason** — the narrow question of shape: why these parts. Not the fix, not the root cause. One or ' +
      'two sentences, and on a one-part plan it is usually one.\n' +
      '- **risks** and **outOfScope** — what could go wrong with this plan, and what you deliberately left ' +
      'alone. Both are read as caveats on the plan, so keep them to things that would change a mind — and ' +
      'keep `risks` to a sentence or two, since it is drawn as a tick box on the approval card.\n\n' +
      '## Per part\n\n' +
      'Slugs are short, lowercase, kebab-case and unique — and stable: a replan merges on them. "scope" names ' +
      'the files or areas that part owns in a sentence; **"touches"** is the same claim as repository paths, ' +
      'and is the form that gets compared to what the part actually wrote, so declare it even when the prose ' +
      'already says so. "size" is `s`, `m` or `l` — how big this is to *review*, not how long it takes; three ' +
      'parts is not a cost, three large ones is. "acceptance" is what makes this part done, written so a ' +
      'reviewer can tick it off. "rationale" is why it is its own PR rather than folded into a sibling.\n\n' +
      '"dependsOn" names the sibling slugs a part needs before it can start, and usually that is none or one. ' +
      '**One** means it stacks: it starts as soon as that sibling has pushed a branch, and is cut from that ' +
      'branch. **Several** means the lanes rejoin: a part naming several does not start until every one of them ' +
      'has **merged**, and is then cut from the integration branch. Use it for work that genuinely gathers ' +
      'separate lanes back together — the part that wires two independent pieces to each other — and not to ' +
      'express a vague ordering, because it waits for all of them.\n\n' +
      '"expectedKind" defaults to "code" — a part that ends in a merged pull request. Use "report" when the ' +
      'deliverable is a write-up or a measurement, "determination" when the part decides whether anything ' +
      'needs building at all, and "human" for a step no agent can run: flipping a setting in a console nobody ' +
      'gave the fleet an account for, plugging something in, a decision that is somebody else’s to make. A ' +
      '"human" part is never dispatched, and anything naming it in "dependsOn" waits for a person to mark it ' +
      'done.\n\n' +
      '## How anyone checks it worked\n\n' +
      'Beside "verification", and different from it: `verification` is the sentence, `validation` is what you ' +
      'would most want somebody to go and *run*. **You are not writing the checks.** They are written after the ' +
      'goal is delivered, by an agent reading the code that actually shipped — because a check written here is ' +
      'written against code that does not exist yet, and by the second part it is describing a screen that ' +
      'moved. What you write is one prose **hint**, and it binds nothing:\n\n' +
      '  "validation": {"hint": "..."}\n\n' +
      '**There is no "checks" array and no "resources" array.** A document carrying them is on the shape from ' +
      'before authoring moved; it still parses, and everything it declares is superseded by the set written ' +
      'against the delivered code.\n\n' +
      'The hint is read twice: by the operator deciding whether to approve this plan, and by the agent that ' +
      'writes the check set weeks later. So say what you believe **only running the finished thing** could ' +
      'settle — a real environment, the state it wrote, the logs, the screen itself — and say what ' +
      'you think is already covered without it. Anything the diff, the test suite, the type checker or a green ' +
      'build settles is not that: all four have already happened, on every branch, before anybody opens the ' +
      'sheet, and naming one here sends a person out to redo work that is done. Per-part "acceptance" is ' +
      'where "a reviewer can see this in the diff" belongs.\n\n' +
      'Write it as one short paragraph aimed at the person who will run it. Do not enumerate, do not number ' +
      'them, and do not reach for coverage: **declaring no hint is an ordinary answer** — a refactor whose ' +
      'whole claim is that behaviour did not change has nothing left once the suite is green, and saying so ' +
      'honestly is worth more than a list somebody has to read past.\n\n' +
      'A hint that clears the bar:\n\n' +
      '  "validation": {"hint": "Worth running end to end against a seeded repository with a pull request by ' +
      'another author: merge it, let one pulse run, and look at whether the part branch is actually gone — the ' +
      'ref locally and on the remote, what the goal page says, and the log line. The reaping logic is covered ' +
      'by unit tests; what nothing covers is a real git remote refusing the delete."}\n\n' +
      '## The write-up\n\n' +
      '"document" is not optional in practice: a human reads it and decides whether this work happens. The ' +
      'fields above are the summary; this is the argument. Do not repeat them back — cover how you got to the ' +
      'diagnosis, what the code actually looked like when you got there, and what a reviewer of the finished ' +
      'work should check. Markdown, and written for the person deciding.\n\n' +
      '## If there is nothing to build\n\n' +
      'Read the repository before you decide what the work is, and sometimes what you find is that the ' +
      'goal is already met: the code, the setting or the document this ticket asks for is in there now. ' +
      'Somebody fixed it by hand, another goal covered it, or the ticket was filed against a version that ' +
      'predates the fix. **Say so with the plan_not_needed tool.** Do not write a plan with a part in it ' +
      'so that there is something to submit — that part costs an agent, a branch and often a pull request ' +
      'to discover what you already know, and the person who reads it is being asked to approve work ' +
      'nobody needs. plan_not_needed takes a one-line "summary" and a required "detail": point at the ' +
      'files, the commits or the pull requests that already do what the ticket asks, and say what you ' +
      'checked to be sure nothing it asks for is missing. Nothing further is scheduled for the issue while ' +
      'that stands, the ticket is not closed, and an operator can undo it.\n\n' +
      'The bar is *met*, not *nearly met*: a goal that is half there is a plan for the other half. And a ' +
      'goal you cannot make sense of is not this either — that is not a plan you should be writing, so ' +
      'raise it instead.\n\n' +
      'Do not implement anything and do not open a pull request. Writing the plan is the whole job — you are ' +
      'on branch {branch} only so you have the repository to read.',
    doc: "Sent to a code agent when the planning funnel is enabled and a watched open issue has no plan yet (rule `issue-plan`). The agent writes its plan to the plan file; nothing else it does is read. Every plan is a list of parts and at least one is required — work that is one pull request is a one-part plan, not a separate shape. Most of its length is spent on *what a good plan says* rather than on JSON shape, since `plan_submit` validates and returns its own reasons: the headline four (`diagnosis`, `approach`, `alternatives`, `openQuestions`), the four that make them checkable (`evidence`, `verification`, `reason`, `risks`/`outOfScope`), and per-part `touches`/`size`/`acceptance`/`rationale`. All optional, so an older override that omits them still validates. The `validation` block gets a section of its own, and what it asks for is a prose **hint** and nothing executable: the check set is written after delivery, against the code that shipped, so a `checks` array here is written against code that does not exist yet and carries no `steps` — and therefore no `area`, which is what lets the browser half run at all. The section says so in as many words, states the bar the hint answers to — what only running the finished thing can settle, never the suite, the diff or a green build — and says that declaring no hint is an ordinary answer. What it deliberately does *not* say is that a screen is a person's: this text is rendered on every deployment, so `screenCheckNote` is *appended* where one declares a browser runner and says that the fleet goes and looks and a person judges what came back. `checks` and `resources` still parse, for a plan document and an operator override written before authoring moved; what they declare is superseded by the authored set. A closing section names the planner's *other* verdict, `plan_not_needed` — the goal is already met, so no plan is written at all — and says what the bar for it is, because the failure it exists to stop is a plan with an invented part in it. Placeholders: {number} {title} {body} {branch} {planFile}.",
  },
  'issue-replan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile', 'current'],
    template:
      'Issue #{number} ("{title}") already has a delivery plan, and an operator has asked for it to be replanned. ' +
      'Amend the existing plan — do not start from scratch.\n\n{body}\n\n{current}\n\n' +
      'Read the repository and the state above, then submit the amended plan with the plan_submit tool if you ' +
      'have it (it validates on the spot and tells you why if it rejects), otherwise write it to {planFile} in ' +
      'this worktree. Either way it is the same document as the original:\n\n' +
      '  {"version": 1,\n' +
      '   "diagnosis": "...", "approach": "...", "reason": "...", "verification": "...",\n' +
      '   "alternatives": "...", "openQuestions": "...", "risks": "...", "outOfScope": "...",\n' +
      '   "evidence": [{"path": "src/...", "line": 120, "note": "..."}], "document": "...",\n' +
      '   "parts": [\n' +
      '     {"slug": "schema", "title": "...", "scope": "...", "touches": ["src/store/"], "size": "s",\n' +
      '      "dependsOn": [], "rationale": "...", "acceptance": "..."}\n' +
      '   ],\n' +
      '   "validation": {"hint": "..."}}\n\n' +
      'Rules that make an amendment safe:\n\n' +
      '- **Slugs are the merge key.** Re-use the exact slug of every part you are keeping, whatever else you change ' +
      'about it. A part you re-declare under a new slug is not the same part: the old one is treated as dropped and ' +
      'a fresh branch is cut for the new one.\n' +
      '- **Re-declare parts that are already merged, dispatched or in review.** Their branches and pull requests ' +
      'exist and are not yours to withdraw; leaving them out does not undo them.\n' +
      '- **A part you leave out is retired**, and only if nothing was started for it. That is how you remove work ' +
      'that is no longer needed.\n' +
      '- New parts may be added, and dependencies rewired. "dependsOn" names the sibling slugs a part needs: none, ' +
      'one (it stacks on that branch and starts once that sibling has pushed), or several (the lanes rejoin — it ' +
      'starts only once every one of them has merged, and is cut from the integration branch). A cycle is refused.\n' +
      '- **The part count is not the point.** Amending an eight-part plan down to one part, or one part up to ' +
      'three, is an ordinary amendment either way — a plan with one part is a plan. Change the split because the ' +
      'work wants a different split, not to move the number.\n' +
      '- **The validation hint is prose, and re-stating it replaces it.** You are not writing checks here ' +
      'either: the check set is written after the goal is delivered, against the code that shipped. `hint` is ' +
      'one paragraph saying what you believe only running the finished thing could settle, and a replan is ' +
      'the moment to re-aim it at where the work actually went. Omitting the `validation` block entirely ' +
      'leaves the hint that is on file standing. A document carrying `checks` or `resources` is on the shape ' +
      'from before authoring moved, and what it declares is superseded once the goal is delivered.\n' +
      '- **Re-state the whole narrative.** `diagnosis`, `approach`, `alternatives`, `openQuestions`, ' +
      '`verification`, `evidence`, `risks`, `outOfScope` and `document` are replaced by what you submit, not ' +
      'merged — an amendment that omits them leaves the previous ones standing, which will read as though the ' +
      'old reasoning still applies to a plan that has changed.\n' +
      '- **Say what moved, in `document`.** The operator is shown this amendment as a *diff* against the last ' +
      'one, so the parts you added, dropped, re-scoped or rewired are already visible to them. What is not ' +
      'visible is why, and that is the thing worth writing: open the write-up with what changed your mind.\n\n' +
      'The field guide from a cold plan applies unchanged: `diagnosis` is the root cause in the code, ' +
      '`approach` is what you are going to do about it, `alternatives` is what you rejected and why, ' +
      '`openQuestions` is what you would most like argued with, and `reason` is the narrow question of shape. ' +
      '`diagnosis`, `approach` and `verification` are a quick overview rather than the argument: markdown ' +
      'bullets, one plain-English point each, and no file paths — the paths go in `evidence` and the ' +
      'reasoning in `document`. ' +
      'Per part, `touches` is the paths that part owns and `size` is `s`/`m`/`l` — how big it is to review.\n\n' +
      'Do not implement anything and do not open a pull request. Writing {planFile} is the whole job — you are on ' +
      'branch {branch} only so you have the repository to read.',
    doc: 'Sent to a code agent when an operator hits Replan on an existing plan (rule `issue-plan`, with the plan row back in `planning`). Unlike {issue-plan} it amends rather than plans cold: {current} is the plan and its parts as they stand, and the prompt spells out that slugs are the merge key, that in-flight parts must be re-declared, and that the whole narrative is replaced rather than merged. Its `validation` bullet asks for the same prose **hint** {issue-plan} does and says the check set is written after delivery, so a replan re-aims the hint rather than editing checks. It also tells the agent its amendment is read as a diff, so the write-up should say what changed its mind. Placeholders: {number} {title} {body} {branch} {planFile} {current}.',
  },
  'discuss-plan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile', 'current'],
    template:
      'An operator wants to talk through the delivery plan for issue #{number} ("{title}") before approving it. ' +
      'This is a conversation, not a planning run: nothing is scheduled while you are talking, and your job is to ' +
      'answer them well and amend the plan if they ask.\n\n{body}\n\n{current}\n\n' +
      'How this works:\n\n' +
      '- Read the repository and the plan above, then use the escalate tool to open the conversation. Open it on ' +
      "the plan's own **open questions** if it has any — those are the decisions its author already flagged as " +
      "the ones worth arguing about, and starting anywhere else wastes the operator's first reply. If it has " +
      'none, say what you understand the plan to be and what you think is most worth questioning about it. ' +
      'Escalating parks you until they reply; their reply arrives as your next turn.\n' +
      '- Answer honestly. If they are right that the plan is wrong, say so. If they are wrong, say that too and ' +
      'explain why — you have read the code and they may not have. A plan that ends up with one part is a fine ' +
      'outcome of a conversation, and so is one that ends up with five.\n' +
      '- Escalate again each time you need them, and keep going until they are satisfied.\n' +
      '- When they are, submit the amended plan with the plan_submit tool (or write it to {planFile}), exactly as ' +
      'a replan would: slugs are the merge key, re-declare every part that is already merged, dispatched or in ' +
      'review, and a part you leave out is retired only if nothing was started for it. Re-state the whole ' +
      'narrative — "diagnosis", "approach", "alternatives", "openQuestions", "verification", "evidence", ' +
      '"risks", "outOfScope" and "document" are replaced by what you submit, not merged, and "diagnosis", ' +
      '"approach" and "verification" stay bullets with no file paths in them. Rewrite ' +
      '"openQuestions" in particular: the ones you have just settled with them are no longer open, and leaving ' +
      'them standing puts the conversation you have had back in front of the person who had it.\n' +
      '- If they end up wanting no change at all, submit the plan unchanged. Submitting is what ends the ' +
      'conversation and puts the plan back in front of them for approval.\n\n' +
      'Do not implement anything and do not open a pull request. You are on branch {branch} only so you have the ' +
      'repository to read.',
    retired: true,
    doc:
      '**Retired — no longer rendered.** Discuss no longer dispatches anything: the cockpit deep-links the ' +
      'operator into their own Claude Code (`claude://code/new`), which reads the plan through `plan_read`, ' +
      'argues about it with the repository open, and amends it through `plan_amend`. What this prompt ' +
      'described was a dialogue conducted one line at a time through a text box in the plan sheet, which is ' +
      'the friction that replaced it. An override left here still loads — it is simply not sent.',
  },
  'plan-part': {
    placeholders: ['number', 'title', 'part', 'scope', 'branch', 'base', 'plan', 'done', 'remaining'],
    template:
      'Issue #{number} ("{title}") was split into parts, and you own the part "{part}".\n\n' +
      'Why it was split: {plan}\n\n' +
      'Your scope — the files and areas this part owns. Stay inside it; a sibling part may be running right now:\n' +
      '{scope}\n\n' +
      'Other parts whose work already exists (do not redo it; some of it may already be on your branch):\n' +
      '{done}\n\n' +
      'Other parts still to come. These are explicitly NOT yours — leave them alone:\n' +
      '{remaining}\n\n' +
      'If you find there is nothing to build here — it is already done, it duplicates other work, or the ' +
      'premise is wrong — do not open an empty pull request and do not simply stop. Call conclude_part ' +
      'with kind "determination" and say what you found, and the part closes cleanly.\n\n' +
      'Work on branch {branch}, which is cut from {base}. Open the pull request with the open_pr tool: it ' +
      'resolves the branch and the base from your own origin, so a stacked part targets the rung beneath it, ' +
      'and it writes which part of #{number} this is itself. If that tool is unavailable, open the pull ' +
      'request yourself from {branch} **into {base}** — if that is not the default branch, this PR is stacked ' +
      'on another part and must target it, not the default. Either way, reference the issue as ' +
      '"part of #{number}" and never as "closes #{number}": other parts still have to land.',
    doc: "Sent to a code agent for one part of a multi-PR plan (rule `plan-part`). {plan} is the planner's justification, {done}/{remaining} the sibling parts either side of this one, {base} the branch this part stacks on (the default branch when it stacks on nothing). Placeholders: {number} {title} {part} {scope} {branch} {base} {plan} {done} {remaining}.",
  },
  'plan-approval': {
    placeholders: ['number', 'title', 'parts', 'reason', 'list'],
    template:
      'There is a plan for issue #{number} ("{title}") and nothing is scheduled until you approve it — {parts} ' +
      'part(s) of work.\n\nWhy this shape: {reason}\n\n' +
      'Open the full plan for the parts, what it cites and what it leaves out. If you want a different one, use ' +
      'Replan there: that asks the planner again and comes back here.',
    doc: "Put to a human when a plan has landed, whatever its size (rule `plan-approval`). It is a proposal, not a question: the accept/reject buttons settle it, and free text cannot. What the planner diagnosed and what it will do about it is *not* templated — it is carried beside this as the escalation's `detail` and rendered as the body of the card, so an override cannot bury it in a paragraph. What approving and rejecting do is appended by the rule for the same reason. {list} is the parts in dispatch order; the built-in template no longer uses it (they are one click away in the plan panel, drawn) but it is still rendered, so an override written around it keeps working. Placeholders: {number} {title} {parts} (how many parts the plan has) {reason} {list}.",
  },
  'validation-plan-approval': {
    placeholders: ['number', 'title', 'checks'],
    template:
      '{checks} check(s) written against the delivered code for issue #{number} ("{title}"), and nothing runs ' +
      'them until you accept.\n\n' +
      'Accepting releases the set — the bench draws it and a check you hand to the fleet can be dispatched. ' +
      'Rejecting sends it back to be written again; say what is wrong and the next planner is given your words.',
    doc: "Put to a human when the validation planner has authored a goal's check set (rule `validation-plan-approval`). A proposal, not a question: accepting releases the set and nothing reads it as work before that. Deliberately short, because the set is *not* prose: every check, its journey and who each step falls to ride on the action as structure and are drawn as rows, so an override cannot bury the thing the verdict is actually about. The planner's own note is carried beside it as the escalation's `detail`. Placeholders: {number} {title} {checks} (how many checks the set declares).",
  },
  'plan-amendment': {
    placeholders: ['number', 'title', 'who', 'note'],
    template:
      'The plan for issue #{number} ("{title}") is running, and a change to it is waiting on you. {who} asked ' +
      'for it:\n\n{note}\n\n' +
      'Open the plan to read the amendment against what is there now. Nothing is paused while you decide — the ' +
      'parts that were being worked are still being worked.',
    doc: 'Put to a human when somebody proposes a change to a plan that is already running (rule `plan-amendment`). What changes, and what it will not change, is *not* templated — it is built from the store when the card is created and carried as the escalation\u2019s `detail`, so it describes the plan as it stands rather than as it stood when the amendment was written. What accepting and rejecting do is appended by the rule for the same reason `plan-approval` appends its settlement. Placeholders: {number} {title} {who} (who asked) {note} (their reason, verbatim).',
  },
  'issue-shortfall': {
    placeholders: ['number', 'title', 'consequence'],
    template:
      'An assessment of issue #{number} ("{title}") found that the work is finished and the goal is still not ' +
      'reached. Nothing has been scheduled about it.\n\n{consequence}\n\n' +
      'Reject and nothing happens: the issue stays exactly where it is, and the assessment stays on record so you ' +
      'can see why. Say why you rejected it — the harness will not ask again until something changes on the issue.',
    doc: "Put to a human when an assessment says the goal was not reached and named something the harness can act on (rule `issue-shortfall`). A proposal, not a question: accepting performs the arm {consequence} describes. What the assessor wrote is *not* templated — it is carried beside this as the escalation's `detail` and rendered as the body of the card, so an override cannot bury it in a paragraph. Placeholders: {number} {title} {consequence}.",
  },
  'plan-part-escalation': {
    placeholders: ['number', 'part', 'attempts'],
    template:
      'Part "{part}" of issue #{number} keeps failing: {attempts} agent attempt(s) produced no pull request. The rest of the plan may be stacked on it — please take a look.',
    doc: 'Escalated to a human when one part of a plan keeps failing to produce a PR. Placeholders: {number} {part} {attempts}.',
  },
  'issue-pickup': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'GitHub issue #{number} ("{title}") needs resolving.\n\n{body}\n\nImplement the fix on branch {branch} and open a pull request that resolves it, using the open_pr tool — it resolves the branch and the base from your own origin and writes the issue reference itself. If that tool is unavailable, open the pull request yourself from {branch}. Whether the issue closes is yours to say in the body: reference the issue as "closes #{number}" only if this PR completes the whole thing; if work remains afterwards, reference it as "part of #{number}" so it stays open for the rest.',
    doc: 'Sent to a code agent when an open work item / issue has no open PR and no agent is on it (rule `issue-pickup`). Placeholders: {number} {title} {body} {branch}.',
  },
  'issue-pickup-escalation': {
    placeholders: ['number', 'title', 'attempts'],
    template:
      'Auto-resolution of issue #{number} ("{title}") keeps failing: {attempts} agent attempt(s) produced no linked PR. Please take a look.',
    doc: 'Escalated to a human when issue pickup keeps failing to produce a linked PR. Placeholders: {number} {title} {attempts}.',
  },
  'issue-assess': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'Issue #{number} ("{title}") has had work done on it and has nothing in flight right now. Decide whether it is finished.\n\n{body}\n\nYou are in a read-only checkout of the default branch, so the repository you can see is the delivered state. Nothing here is on a branch and nothing you do is committed or pushed. Read it. Call world_read("issue", "issue:{number}") for the harness\'s own record of what was done — the pull requests that delivered this issue, including ones long gone from the world, each marked `observed` (the harness watched it merge) or `inferred` (it left the open list and the merge was assumed). An inferred merge is weaker evidence; say so if your verdict rests on one.\n\nThen call assess_issue:\n\n- "delivered" if what the issue asked for is actually present in the repository. This stops the harness scheduling anything further for it. It does NOT close the ticket — a human does that after testing, and your verdict is reversible.\n- "more_work" if something the issue asked for is missing. Say precisely what, because the next agent is given your words.\n\nDo not implement anything and do not open a pull request. Judge from what is there. If you genuinely cannot tell, say "more_work" and explain what you could not verify — a wrong "delivered" parks real work silently, while a wrong "more_work" costs one more agent.',
    doc: "Sent to a code agent for an issue that has had work and has nothing in flight (rule `issue-assess`). It reads the delivered state on the default branch plus the work graph via world_read, and casts a verdict with assess_issue. On `delivered` it also writes the goal's validation check set in the same turn, which is why the rule appends `assessAuthoringNote` and `authoringBriefing` after this text — the verdict is the moment nothing further is coming, so the reading that decided it is the reading a check set is written from, and a second agent tomorrow would re-derive it from the same checkout. Both are *appended* rather than interpolated, and the `assess_issue` tool's own answer repeats the ask, so an override that never learned the fold still hears it. They are rendered only for a goal that has a plan and no check set; rule `validation-plan` remains as the catch-up for a turn that ended before the second call. It runs in a read-only checkout rather than on a branch of its own (issue #396), so {branch} is the name its worktree is leased under and not a ref — it is still rendered for an override that predates that. Where each of the goal's pull requests is in that checkout — the merge commit a squash leaves no ancestry link to, and the branch — is *appended* after this text by `deliveredWorkBriefing` rather than interpolated, so an override that never learned of it cannot silently drop it; what each pull request was for stays with world_read, which an override telling the agent to ask is doing the right thing. Placeholders: {number} {title} {body} {branch}.",
  },
  'issue-assay': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'Nothing has been started for issue #{number} ("{title}"). Before anything is, decide whether there is a goal here an agent could work from.\n\n{body}\n\nYou are in a read-only checkout of the default branch, so what you can see is the repository as it stands. Nothing here is on a branch and nothing you do is committed or pushed. Read the ticket against it: do the things it names exist, does it say what "done" would look like, does it contradict itself or something already true of the code? Call world_read("issue", "issue:{number}") for the harness\'s own record of the issue, and read anything it points you at.\n\nThen call appraise_issue:\n\n- "workable" if there is an identifiable goal to start on. The bar is *actionable*, not *good* or *small* — an opinionated, large or awkward ticket is still workable, and saying so schedules nothing by itself.\n- "unclear" if starting would be guessing. Say exactly what you would need, addressed to the person who wrote the ticket: the specific question, not "it is vague". Nothing is dispatched for this issue while that stands, so a wrong "unclear" stops real work — but it is undone by an edit, a comment, or an operator clearing it.\n\nThen leave one note on this goal\'s scratchpad with scratch_append, on either verdict. Finding where in the repository this ticket lands is most of what you just did, and nothing else carries it out of here: the summary you hand appraise_issue is written to justify the verdict, and the next agent dispatched on this goal is given the title, the body and a branch name. Write where the goal lives — the files and areas you read to decide — what you found when you read them, and what you expect the shape of the work to be. On "unclear" it is worth more, not less: that hold ends when somebody edits the ticket, and whoever picks it up then should know what you went looking for and did not find.\n\nA paragraph, not a tour. It is read as testimony rather than instruction — the agent reading it is told to check anything it relies on, because the repository is the truth and your note is one agent\'s reading of it — so write what you actually saw, and no more of the codebase than that. A note longer than the pad takes is trimmed to fit rather than refused, so the end of a long one is lost without anyone being told.\n\nDo not implement anything, do not open a pull request, and do not edit the ticket. The note is an observation, not a head start: no design, no patch, nothing for the next agent to apply. If you are torn, say "workable": the agent that picks it up can escalate to a human from inside the work, which is a better place to ask from than here.',
    retired: true,
    doc:
      '**Retired \u2014 renamed to `issue-appraisal`.** The goal appraisal was called an *assay* until ' +
      'the rename, and the id followed the word. The old id stays loadable so a deployment holding an ' +
      '`issue-assay.md` override still boots, but it is no longer rendered \u2014 move the wording to ' +
      '`issue-appraisal`. Placeholders: {number} {title} {body} {branch}.',
  },
  'issue-appraisal': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'Nothing has been started for issue #{number} ("{title}"). Before anything is, decide whether there is a goal here an agent could work from.\n\n{body}\n\nYou are in a read-only checkout of the default branch, so what you can see is the repository as it stands. Nothing here is on a branch and nothing you do is committed or pushed. Call world_read("issue", "issue:{number}") for the harness\'s own record of the issue, and read anything it points you at.\n\nA story an agent can start on says three things, always:\n\n1. **The problem** — who has it and why it matters.\n2. **What success looks like** — observable, so someone could tell "done" from "not done".\n3. **Its words defined** where they could mean two things.\n\nAnd, where the ticket implies it:\n\n4. **A UI change** carries a design or mockup, or an exact description of layout, states and behaviour.\n5. **Data going in or out** carries an example of the shape — a real-looking sample, not just a type name.\n6. **Links to the specs or documentation** it relates to.\n\nRead the ticket against the repository and judge whether each item that applies is *answered* — in whatever words and layout the author used. This project has no required template; a heading proves nothing and a paragraph can answer all three. Check the things it names exist and that it does not contradict itself or the code. Implementation hints and an out-of-scope list are welcome and never required; do not mark a ticket unclear for lacking them.\n\nThen call appraise_issue:\n\n- "workable" if every item that applies is answered well enough that an agent could start. The bar is *actionable*, not *good* or *small* — an opinionated, large or awkward ticket is still workable, and saying so schedules nothing by itself.\n- "unclear" if starting would be guessing. Put one entry per gap in "missing", each phrased as the specific question the author has to answer — "What should happen when the export is empty?", "Attach the mockup for the settings page", "A sample row of the CSV you expect" — not "it is vague". That list is posted on the ticket as the checklist they work through, with how to get help filling it in, and nothing is dispatched for this issue until the ticket is rewritten. A wrong "unclear" costs the author a round trip; a wrong "workable" costs an agent guessing at what they meant and a review of the wrong thing. Do not lean either way — answer what the ticket says.\n\nThen leave one note on this goal\'s scratchpad with scratch_append, on either verdict. Finding where in the repository this ticket lands is most of what you just did, and nothing else carries it out of here: the summary you hand appraise_issue is written to justify the verdict, and the next agent dispatched on this goal is given the title, the body and a branch name. Write where the goal lives — the files and areas you read to decide — what you found when you read them, and what you expect the shape of the work to be. On "unclear" it is worth more, not less: that hold ends when somebody rewrites the ticket, and whoever picks it up then should know what you went looking for and did not find.\n\nA paragraph, not a tour. It is read as testimony rather than instruction — the agent reading it is told to check anything it relies on, because the repository is the truth and your note is one agent\'s reading of it — so write what you actually saw, and no more of the codebase than that. A note longer than the pad takes is trimmed to fit rather than refused, so the end of a long one is lost without anyone being told.\n\nDo not implement anything, do not open a pull request, and do not edit the ticket. The note is an observation, not a head start: no design, no patch, nothing for the next agent to apply.',
    doc: "Sent to a code agent for a watched open issue nothing has been started for (rule `issue-appraisal`). It reads the ticket against the default branch, judges it against the story rubric (`STORY_RUBRIC` in `src/mcp/goalAppraisal.ts`: the problem, what success looks like, defined terms — always; a mockup, a data sample, links to specs — where the ticket implies them), and casts a verdict with appraise_issue, putting one question per gap in `missing`. It judges substance, never headings: the target project may be any repository on any tracker, so no template is assumed. It leaves one note on the goal's scratchpad with scratch_append — on either verdict, since an `unclear` hold ends with a rewrite and the agent that picks it up then is the one with least to go on. The orientation it did to answer the question is otherwise discarded at exit, and `priorWorkBriefing` already renders the pad to every later agent on the goal as testimony, so asking for the note is the whole mechanism. A deployment that overrides this template keeps its own body and gets no note — the ordinary cost of an override, not a fault. It runs in a read-only checkout rather than on a branch of its own (issue #396), so {branch} is the name its worktree is leased under and not a ref — it is still rendered for an override that predates that. Placeholders: {number} {title} {body} {branch}.",
  },
  'criteria-alignment': {
    placeholders: ['number', 'title', 'ticket', 'criteria', 'version'],
    template:
      "Issue #{number} (\"{title}\") has acceptance criteria of its own, and the operator has written theirs (version {version}) before any plan exists. Compare the two for the gist, not the wording: the operator's will not touch every point the ticket does and will phrase the ones they share differently, and that is fine.\n\n## The ticket's acceptance criteria\n\n{ticket}\n\n## The operator's criteria (version {version})\n\n{criteria}\n\nTag every point on either side with one of: matches (both say it), extra (only the operator says it), uncovered (only the ticket says it) or contradicts (the two disagree). Then give one verdict: aligned, partial or conflicting — conflicting only where a point contradicts. Record it with criteria_alignment, naming version {version}. You have no worktree, you are not planning or implementing anything, and nothing you write reaches the ticket: your reading is shown to the operator before planning starts.",
    doc: "Sent to a desk agent while a goal's intake sitting is open, when the operator has written criteria and the ticket carries its own (rule `criteria-alignment`). It tags every point on either side — matches, extra, uncovered, contradicts — and gives one verdict through criteria_alignment, against the version it was handed. It informs the sitting and holds nothing: a run that writes no verdict leaves the sitting to close without one. Placeholders: {number} {title} {ticket} {criteria} {version}.",
  },
  'prediction-judge': {
    placeholders: ['number', 'title'],
    template:
      'Before any plan existed for issue #{number} ("{title}"), the operator wrote down what they expected the plan to say. A plan has since been written, and the operator has marked their own prediction against it. You give a second, independent reading of the same comparison.\n\nCall prediction_judge with action "read" to be handed the prediction and the plan, then call it with action "mark" to mark each filled slot. That is the whole task: you have no worktree and no other tool, and nothing you write reaches the ticket or any other agent.',
    doc: 'Sent to the sealed desk agent of rule `prediction-judge`, once the operator has marked moment one. It carries no prediction text: the agent is handed the prediction and the plan by its one tool, `prediction_judge`, so the text is in no task row, decision or launch argument. Placeholders: {number} {title}.',
  },
  'issue-retro': {
    placeholders: ['number', 'title', 'body'],
    template:
      'Issue #{number} ("{title}") has been delivered. Write the retrospective for it — the account of what shipped, and of how the work actually went.\n\n{body}\n\nYou have no worktree and you are not implementing anything. What you have is the scratchpad the agents on this goal left and the record the harness kept, both appended below, plus world_read if you need the state of a pull request or the issue itself.\n\nWrite one document, in markdown, for two readers:\n\n1. **What shipped** — for someone reviewing this goal who did not watch it happen: the pull requests, what each part delivered or decided, what was concluded to need no code or to be out of scope, and anything still outstanding.\n2. **How the run went** — for the operator: where agents were spent and on what, which gates, escalations or retries cost time, what surprised the agents, and what you would change about the process — a prompt, a gate, a config, a habit of decomposition. Be specific and name the evidence; "it went well" helps nobody, and neither does a list of everything that happened.\n\nQuote the scratchpad where it earns it and attribute it, and say plainly where the pad and the harness\'s record disagree — that disagreement is usually the most useful thing in the document.\n\n## Lessons\n\nThe document is read once, by a person. A **lesson** is the part worth keeping: something this run taught about *working this repository* that the next goal would otherwise pay to learn all over again. One question decides what qualifies — does it describe **the repository**, or **working the repository**?\n\n| What you noticed | Where it goes |\n| --- | --- |\n| The suite needs the web bundle built first; this subsystem\'s tests sit at an odd seam; a ticket naming only a symptom is under-specified for a planner every time | A **lesson** on this submission |\n| A fact about the code — a seam, an invariant, a second place a thing must be registered — or a defect you noticed in passing | **raise** it. One call, and you do not have to work out which: the harness routes it and an operator decides what it is for |\n| Something true only of this goal | The scratchpad, where it dies with the goal — correctly |\n\nAnything you would `raise` is worth raising the moment you learn it and not only here — any agent can, and a retrospective is a late place to remember one. File the one or two lessons a reader would thank you for, not everything you noticed: each lands as a *proposal* that reaches no agent until an operator vouches for it, and a list nobody finishes reading is a list nobody promotes from. A run that taught nothing general is the ordinary case — submit no lessons and the retrospective is complete.\n\nThen call retro_submit with a summary of one or two sentences, the document itself, and any lessons. Nothing you write is posted to the tracker, nothing is closed, and nothing is scheduled from it: a human reads it and decides what to change.',
    doc: "Sent to a desk agent when an issue the harness parked as delivered has no retrospective yet (rule `issue-retro`). The issue's scratchpad and the harness dossier are *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop them. An override also does not carry the three-destination discriminator this default states — `retro_submit`'s own description repeats it for that reason, so an agent hears it either way. Row two is `raise` rather than a list of kinds, and that is the whole of what the unified intake bought here: the four-way table this used to draw asked the writer to sort its own observations by what an operator would do about them, which is the operator's knowledge. What is left is the one question a retrospective is actually placed to answer — is this about working the repository, this goal alone, or neither. Placeholders: {number} {title} {body}.",
  },
  'feature-sequence': {
    placeholders: ['number', 'title'],
    template:
      'Feature #{number} ("{title}") has stories nobody has put in an order. Work out which of them have to go first, and why.\n\n' +
      'You have no worktree and you are not implementing anything. What you have is the Feature\u2019s own description and every story under it \u2014 appended below, with each story\u2019s own text and any Predecessor links the board already carries.\n\n' +
      'The question is narrow, and it is not about priority. Priority is which of two things somebody wants first; this is whether one of them **cannot be built until another has been** \u2014 because the second would otherwise invent what the first was going to design: a schema, an interface, a migration, a shape two stories both touch. Two stories that merely relate are not ordered. Two stories a person would happen to do in a particular sequence are not ordered either. Only say a story waits when starting it early would mean throwing work away.\n\n' +
      '**An order withholds work**, which is what makes a wrong edge both expensive and invisible: a story held behind one that never lands simply never starts, and nothing goes red. So the honest answer is usually a short order with most stories in the first wave. If you cannot support an order from the items\u2019 own text, say so \u2014 submit an empty order, and say in the reason that these stories look independent. That is a real answer rather than a failure, and it is the one the harness would rather have than a guess.\n\n' +
      'Then call sequence_submit once, with:\n\n' +
      '1. **order** \u2014 one entry per story that waits: { issue, waitsOn: [\u2026], why }. A story you do not list waits on nothing and starts immediately. Its why is one line about **that edge**, not about the Feature.\n' +
      '2. **reason** (required) \u2014 a paragraph on why this order, in your own voice: what you took the shape of this Feature to be, and what the ordering turns on.\n' +
      '3. **unsure** \u2014 the edge you would most like argued with, and what would change your mind. An order with no stated doubt is one nobody can disagree with usefully, and somebody is about to be asked to accept this.\n\n' +
      'It is a **proposal**. Nothing is held until a person accepts it, nothing is written to the tracker, no state is moved and no story is closed. Write the order you would defend rather than the one that is safest to submit.',
    doc: 'Sent to a desk agent when a Feature has gained or lost stories since anybody wrote an order for them, or has never had one (rule `feature-sequence`, which runs only at `issueSequencing: full`). The Feature\u2019s description and every story under it are *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop the half the agent cannot work without. Placeholders: {number} {title}.',
  },
  'feature-resequence': {
    placeholders: ['number', 'title'],
    template:
      'Feature #{number} ("{title}") has gained or lost stories since its order was written. Fit the change into the order that stands.\n\n' +
      '**Keep the order you are given.** It is appended below, and somebody has already read and accepted it — every edge in it is a decision that was made, and re-deriving the whole thing from scratch would put that decision back in front of them for no reason. Change an edge only where the new stories make the old answer wrong, and say in `reason` which edge you changed and why.\n\n' +
      'What is actually being asked is narrow: where do the **new** stories go? They are marked in the list below. Most of the time the answer is that they wait on nothing and start immediately, or that they wait on exactly one story that produces the thing they read.\n\n' +
      'It matters whether you keep the order because of what happens next. If your order keeps every accepted edge and only adds edges touching the new stories, it is taken as the same order extended and **holds work immediately** — nobody is asked again. If it changes anything else, it goes back to a person as a fresh proposal and holds nothing until they answer. Neither is wrong; the second is simply a question, so only ask it when you have something to ask.\n\n' +
      'Submit with sequence_submit, as the **whole** order rather than the change to it — what you send replaces what stands, so carry every edge you are not deliberately changing. An empty order says these stories are independent after all, and releases everything the previous one held.',
    doc: 'Sent to a desk agent when a Feature that already has an order gains or loses stories (rule `feature-sequence`). The `feature-sequence` prompt\u2019s sibling, and the distinction is `issue-replan`\u2019s: whether there is an existing answer to work *from*. The stories, the Feature\u2019s description, the standing order and which stories are new are all *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop the half the agent cannot work without. Placeholders: {number} {title}.',
  },
  'feature-summary': {
    placeholders: ['number', 'title'],
    template:
      'Feature #{number} ("{title}") has moved: something under it has changed since anybody last said where it was. Write the summary a developer would give the person who asked for this Feature.\n\n' +
      'You have no worktree and you are not implementing anything. What you have is every item under this Feature, where each one stands, and the sentence whoever ruled on it wrote \u2014 appended below, along with the summary on file if there is one.\n\n' +
      '**Short.** The reader is not in the fleet, does not read the tracker, and is giving this card about ten seconds. A card they have to read twice answers nothing, so everything below is capped, and the caps are the point rather than a guideline: what does not fit was not the most important thing on the Feature.\n\n' +
      'Five fields on the `feature_summary` tool:\n\n' +
      '0. **How far along** (`headline`) \u2014 **a few words, 90 characters at the outside.** The half-sentence the reader repeats when somebody asks them how this is going: "most of the way there, nothing on live yet", "barely started", "done bar the deploy". It is drawn as the first line of the card, above everything else. Say where the work has got to \u2014 which you have read \u2014 and not where it will get to, which you have not. Leave it out rather than hedge in it.\n' +
      '1. **Where this is** (`standing`, required) \u2014 **two sentences, 360 characters at the outside.** What works, and the one thing standing between the reader and the rest. Nothing else: the bullets carry the detail, and a lede that summarises them has said everything twice.\n' +
      '2. **What is usable** (`usable`) \u2014 **up to four bullets**, one line each, each beginning with `- `. What a person can see or do *today* and **where** \u2014 name the environment, because "built" and "on live" are the difference the reader cares about. One thing per bullet, the thing first and the environment after a dash.\n' +
      '3. **What needs a person** (`blocked`) \u2014 **up to four bullets**, same shape. Not what is merely unfinished: what is stopping and what it wants from *them*. Say which it is \u2014 an agent parked on an unanswered question is asking to be **answered**, a goal that fell short twice is asking somebody to **decide**, and a built thing sitting on a test environment is asking for a **deploy**. They read the same on a board and they are not the same ask.\n' +
      '4. **What is left** (`remaining`) \u2014 **one line**, drawn as a footnote under the two above. What nobody is working, said as a count where a count says it: an item the fleet cannot see is not queued behind anything, and a reader not told so assumes it is in hand. Where nothing is outstanding, say that in a clause and stop.\n\n' +
      'A bullet is a line, not a paragraph: name the thing, then where it is or what it wants. Restate a verdict as what it means for the Feature rather than as it was said to another agent \u2014 an assessor writes for the next agent, and "three views cross-join the unscoped mask" is not what a person needs to hear.\n\n' +
      'Three things to refuse. **No forecast**: no dates, no percentages, no "on track" or "at risk" \u2014 you have no grounds for one, and a reader given one stops reading the rest. `headline` is not an exception to this and is the field most likely to tempt you into one: "most of the way there" describes what you read, "on track" claims something about next week. **No invented section**: leave a field out where the Feature has nothing to put in it. Nothing usable yet, nothing blocked and nothing left are each ordinary states, and `standing` is where you say so. **No retelling**: the items are drawn beside your summary and the counts above it, so a bullet per ticket is the board saying the same thing twice.\n\n' +
      'Then call feature_summary once. It is drawn on the feature board and nowhere else: nothing is posted to the tracker, nothing is closed, and nothing is scheduled from it. It is rewritten the next time something under this Feature moves, so write where things are **now** rather than how they got here.',
    doc: "Sent to a desk agent when something under a Feature has moved since its summary was written, or when it has none (rule `feature-summary`). The lengths it asks for are the ones `validateFeatureSummary` enforces \u2014 an override that relaxes them has its extra prose cut at a line boundary, or its lede refused outright. Every item under the Feature, its standing and the verdicts standing on it are *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop the half the agent cannot write without — and the summary on file is appended with them, so a re-write revises rather than restarts. The five fields the tool takes are named in the tool's own description as well as here, for `retro_submit`'s reason: an override written before a field existed would otherwise lose it in silence \u2014 which is exactly why `headline`, the newest of them, is **optional** at the tool: required, it would refuse every submission from every deployment whose template predates it. Placeholders: {number} {title}.",
  },
} satisfies Record<string, TemplateDef>;
