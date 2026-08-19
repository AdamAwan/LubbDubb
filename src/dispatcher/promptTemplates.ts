import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/**
 * Operator-customisable dispatch prompts.
 *
 * Every agent- (and escalation-) facing prompt the harness composes itself has a
 * stable id and a built-in default here — the {@link RuleDispatcher}'s, plus the
 * route-driven `finding-ticket`, which is here rather than inline in the route
 * precisely because *how a ticket should be written* is the operator's opinion,
 * not the harness's. An operator can override any of
 * them by dropping a `<id>.md` file into the prompt-templates directory
 * (`promptTemplatesDir`, default `.lubbdubb/prompts`); unset ids keep their
 * default. Overrides are read once at boot — templates don't change per-cycle.
 *
 * A template is a plain string with `{placeholder}` tokens filled at dispatch
 * time. Each id declares the exact placeholders it supports; an override that
 * references an unknown placeholder (or lives in a file whose name matches no
 * id) fails fast at load, so a typo can't silently ship a broken prompt.
 */
type PromptId =
  | 'issue-plan'
  | 'issue-replan'
  | 'discuss-plan'
  | 'plan-part'
  | 'plan-approval'
  | 'issue-shortfall'
  | 'plan-part-escalation'
  | 'issue-pickup'
  | 'issue-pickup-escalation'
  | 'issue-assess'
  | 'issue-assay'
  | 'issue-retro'
  | 'validation-check'
  | 'pr-ci-fix'
  | 'pr-ci-gate'
  | 'pr-base-update-behind'
  | 'pr-base-update-conflict'
  | 'pr-review-comment'
  | 'pr-concern-escalation'
  | 'finding-ticket'
  | 'work-item-ticket'
  | 'raise-bug'
  | 'blueprint-ticket'
  | 'work-item-ticket-body'
  | 'blueprint-ticket-body'
  | 'pr-title';

interface TemplateDef {
  /** The placeholder names this template may reference (validated on override). */
  readonly placeholders: readonly string[];
  /** Built-in default, used unless an operator override replaces it. */
  readonly template: string;
  /**
   * Human-facing note on what the prompt is for and when it fires, plus its
   * placeholders. Seeds the strippable doc header of the sample override files
   * so operators start from a self-documenting template.
   */
  readonly doc: string;
  /**
   * Set on an id the harness no longer renders (issue #394 filed two of the four
   * ticket arms directly, so their prompts have no agent left to send them to).
   *
   * The id stays in the book rather than being deleted, because `loadPromptTemplates`
   * **throws** on a file naming no known id: removing one would turn an operator's
   * customised deployment into a harness that will not boot. It is surfaced on
   * {@link PromptTemplates.describe} instead, so the Prompts panel says the override
   * is no longer sent rather than leaving it looking live.
   */
  readonly retired?: true;
}

const REGISTRY: Record<PromptId, TemplateDef> = {
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
      '   "validation": {"resources": [...], "checks": [...]}}\n\n' +
      'Nothing here needs to be guessed at: submit it, and a rejection tells you exactly which field was wrong.\n\n' +
      '## What the fields mean\n\n' +
      'Four of them carry the whole decision, and they are the four nobody can reconstruct from the rest.\n\n' +
      '- **diagnosis** — what is actually wrong, in the code, named precisely. "The cache is never invalidated ' +
      'because `refresh()` writes the new value under the old key (`src/cache.ts:88`)" is a diagnosis. "Users ' +
      'see stale data" is the ticket, restated. If you find yourself writing the issue text back, you have not ' +
      'read far enough yet. Leave it out only when the work is not a defect and there is genuinely nothing to ' +
      'diagnose — there is no root cause of a feature.\n' +
      '- **approach** — what you are going to do about it, in two or three sentences. Not the shape of the ' +
      'pull requests: the change.\n' +
      '- **alternatives** — what you considered and rejected, and why each was rejected. Name options you ' +
      'actually weighed, not strawmen. This is the field an operator reads to decide whether you looked around ' +
      'before you chose, and a plan with none reads as the first idea you had.\n' +
      '- **openQuestions** — the assumption you would most like argued with, and what would change your mind. ' +
      'Be specific about the decision rather than modest about the plan: "I assumed the retry belongs in the ' +
      'client, but if the server owns idempotency it belongs there instead" is useful; "there may be edge ' +
      'cases" is not. If the operator opens a discussion, this is its agenda.\n\n' +
      'And four that make the rest checkable:\n\n' +
      '- **evidence** — the places you read that the diagnosis rests on, as `path` (+ optional `line`) and a ' +
      '`note` saying what the reader is meant to see. A root cause with no citation cannot be checked, and ' +
      'one that can be checked in four seconds is worth far more than one that is merely well argued.\n' +
      '- **verification** — how anyone will know the *whole* thing worked once every part has landed. Not per ' +
      'part (that is "acceptance"), and not "the tests pass" unless the tests genuinely settle it.\n' +
      '- **reason** — the narrow question of shape: why these parts. Not the fix, not the root cause. One or ' +
      'two sentences, and on a one-part plan it is usually one.\n' +
      '- **risks** and **outOfScope** — what could go wrong with this plan, and what you deliberately left ' +
      'alone. Both are read as caveats on the plan, so keep them to things that would change a mind.\n\n' +
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
      'gave the fleet an account for, plugging something in, looking at a rendered screen. A "human" part is ' +
      'never dispatched, and anything naming it in "dependsOn" waits for a person to mark it done.\n\n' +
      '## How anyone checks it worked\n\n' +
      'Beside "verification", and different from it: `verification` is the sentence, `validation` is the ' +
      'steps. One bar decides what belongs in the block, and it is the only thing in this section worth ' +
      'getting right:\n\n' +
      '**A check is something that can only be found out by running the delivered goal.** If the diff, the ' +
      'test suite, the type checker or a green build settles it, it is not a check — all four have already ' +
      'happened, on every branch, before anybody opens this sheet. "The unit tests pass", "the build is ' +
      'green", "CI passes", "the old helper is no longer called anywhere", "the new module is wired into ' +
      'the composition root", "the function returns an empty list for an empty input" — each of those is ' +
      'either a test somebody is writing anyway or a line a reviewer reads straight off the diff, and ' +
      'putting it here sends a person out to redo work that is already done. It is worse than writing ' +
      'nothing: a sheet of them buries the one check that genuinely had to be carried out by hand. ' +
      'Per-part "acceptance" is where "a reviewer can see this in the diff" belongs — do not restate those ' +
      'here either.\n\n' +
      'What is left is what only a running system, a real environment or a person’s eyes can answer:\n\n' +
      '- Drive the built thing end to end somewhere real, and watch what it actually does.\n' +
      '- Look at the state it left behind: rows in a database, what a migration did to a database that ' +
      'existed *before* this change, files on disk, refs in a repository, a queued job.\n' +
      '- Read the logs, the error records and the metrics — for what should be there, and for what should ' +
      'not be.\n' +
      '- Open the screen: what renders against real data, what survives a reload, where the back button ' +
      'goes, what it does at a narrow width.\n' +
      '- Conditions no test stages: a restart mid-run, two of them at once, a dependency that is slow or ' +
      'gone, a real credential, real volume, a cold start.\n' +
      '- The judgement call: whether the wording reads right, whether the number is believable beside the ' +
      'source it came from.\n\n' +
      'The shape, with one check that clears the bar — it runs the thing and looks at what it left:\n\n' +
      '  "validation": {\n' +
      '    "resources": [{"name": "fixture-repo.tar.gz", "kind": "fixture", "note": "seeded repo, one PR by another author"},\n' +
      '                  {"name": "test-env login", "kind": "access", "provided": false}],\n' +
      '    "checks": [{"id": "merged-branch-gone", "title": "A squash-merged part branch is gone on both sides",\n' +
      '                "do": "Run the harness against the fixture repo and merge the seeded PR…",\n' +
      '                "expect": "No issue/284/reap ref, locally or on the remote.",\n' +
      '                "uses": ["fixture-repo.tar.gz"], "covers": ["reap-writer"],\n' +
      '                "fleetCandidate": true, "why": "reads the repo and runs git; no login, no browser"}]}\n\n' +
      '- **"id"** is kebab-case, unique and *stable* — an amended plan merges on it, like a part slug.\n' +
      '- **"do"** is the procedure — the commands, the URL, the clicks, in enough detail that somebody who ' +
      'has not read your plan can follow it. **"expect"** is what they would *see*, and where: the row, the ' +
      'log line, the ref that is gone, the screen. A check that cannot say what a pass looks like is not a ' +
      'check.\n' +
      '- **How many.** Write the ones this goal actually has and stop — most have one to three. **Declaring ' +
      'none is a legitimate answer**: a refactor whose whole claim is that behaviour did not change, or a ' +
      'documentation change, has nothing left for a person to run once the suite is green, and an empty ' +
      'block says so honestly. Nothing counts checks, and a filler one costs somebody an afternoon.\n' +
      '- **"covers"** names the part slugs a check exercises, so the sheet can show which parts nothing ' +
      'checks. Validation is per *goal*, so a check spanning several parts is normal.\n' +
      '- **"resources"** are what a check needs that is not in the repository. Name them; never write paths. ' +
      '`"provided": false` says you need something you cannot produce, and files an ask for it.\n' +
      '- **"fleetCandidate"** is a *suggestion* that an agent could run this one, with "why". Every check is ' +
      'a person\u2019s until they say otherwise, and you cannot say otherwise: you do not know whether this ' +
      'deployment\u2019s fleet has a browser, a login or an environment. **There is no "actor" field and a ' +
      'document carrying one is refused.**\n\n' +
      '## The write-up\n\n' +
      '"document" is not optional in practice: a human reads it and decides whether this work happens. The ' +
      'fields above are the summary; this is the argument. Do not repeat them back — cover how you got to the ' +
      'diagnosis, what the code actually looked like when you got there, and what a reviewer of the finished ' +
      'work should check. Markdown, and written for the person deciding.\n\n' +
      'Do not implement anything and do not open a pull request. Writing the plan is the whole job — you are ' +
      'on branch {branch} only so you have the repository to read.',
    doc: 'Sent to a code agent when the planning funnel is enabled and a watched open issue has no plan yet (rule `issue-plan`). The agent writes its plan to the plan file; nothing else it does is read. Every plan is a list of parts and at least one is required — work that is one pull request is a one-part plan, not a separate shape. Most of its length is spent on *what a good plan says* rather than on JSON shape, since `plan_submit` validates and returns its own reasons: the headline four (`diagnosis`, `approach`, `alternatives`, `openQuestions`), the four that make them checkable (`evidence`, `verification`, `reason`, `risks`/`outOfScope`), and per-part `touches`/`size`/`acceptance`/`rationale`. All optional, so an older override that omits them still validates. The `validation` block gets a section of its own stating the bar — a check is what only running the delivered goal can answer, never the suite, the diff or a green build, and declaring none is a legitimate answer. Placeholders: {number} {title} {body} {branch} {planFile}.',
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
      '   "validation": {"resources": [...], "checks": [...]}}\n\n' +
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
      '- **Validation checks answer to the same bar as a cold plan.** A check is something that can only be ' +
      'found out by running the delivered goal — a real environment, the state it wrote, the logs, the ' +
      'screen. Anything the diff, the suite, the type checker or a green build settles is not one, and a ' +
      'replan is the moment to drop the checks that turned out to be that. **Ids are a merge key too.** ' +
      'Re-use the exact "id" of every check you are keeping. A ' +
      'check you leave out is *superseded*, not deleted — it stays on the record, greyed, with its letter ' +
      'retired. Rewording a check\u2019s "title", "do" or "expect" withdraws whatever result it had, which is ' +
      'correct: you have changed what a pass means. Re-state the whole "validation" block, and omitting it ' +
      'entirely leaves the existing checks exactly as they are.\n' +
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
      'Per part, `touches` is the paths that part owns and `size` is `s`/`m`/`l` — how big it is to review.\n\n' +
      'Do not implement anything and do not open a pull request. Writing {planFile} is the whole job — you are on ' +
      'branch {branch} only so you have the repository to read.',
    doc: 'Sent to a code agent when an operator hits Replan on an existing plan (rule `issue-plan`, with the plan row back in `planning`). Unlike {issue-plan} it amends rather than plans cold: {current} is the plan and its parts as they stand, and the prompt spells out that slugs are the merge key, that in-flight parts must be re-declared, and that the whole narrative is replaced rather than merged. It also tells the agent its amendment is read as a diff, so the write-up should say what changed its mind. Placeholders: {number} {title} {body} {branch} {planFile} {current}.',
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
      '"risks", "outOfScope" and "document" are replaced by what you submit, not merged. Rewrite ' +
      '"openQuestions" in particular: the ones you have just settled with them are no longer open, and leaving ' +
      'them standing puts the conversation you have had back in front of the person who had it.\n' +
      '- If they end up wanting no change at all, submit the plan unchanged. Submitting is what ends the ' +
      'conversation and puts the plan back in front of them for approval.\n\n' +
      'Do not implement anything and do not open a pull request. You are on branch {branch} only so you have the ' +
      'repository to read.',
    doc: 'Sent to a code agent when an operator hits Discuss on a plan (rule `issue-plan`, with the plan row in `planning` and `discussing` set). Unlike {issue-replan} it is a dialogue: the agent escalates to talk, and submitting the amended plan is what ends it. Placeholders: {number} {title} {body} {branch} {planFile} {current}.',
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
    doc: "Put to a human when `planning.requireApproval` is on and a plan has landed, whatever its size (rule `plan-approval`). It is a proposal, not a question: the accept/reject buttons settle it, and free text cannot. What the planner diagnosed and what it will do about it is *not* templated — it is carried beside this as the escalation's `detail` and rendered as the body of the card, so an override cannot bury it in a paragraph. What approving and rejecting do is appended by the rule for the same reason. {list} is the parts in dispatch order; the built-in template no longer uses it (they are one click away in the plan panel, drawn) but it is still rendered, so an override written around it keeps working. Placeholders: {number} {title} {parts} (how many parts the plan has) {reason} {list}.",
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
      'Issue #{number} ("{title}") has had work done on it and has nothing in flight right now. Decide whether it is finished.\n\n{body}\n\nYou are on branch {branch}, cut from the default branch, so the repository you can see is the delivered state. Read it. Call world_read("issue", "issue:{number}") for the harness\'s own record of what was done — the pull requests that delivered this issue, including ones long gone from the world, each marked `observed` (the harness watched it merge) or `inferred` (it left the open list and the merge was assumed). An inferred merge is weaker evidence; say so if your verdict rests on one.\n\nThen call assess_issue:\n\n- "delivered" if what the issue asked for is actually present in the repository. This stops the harness scheduling anything further for it. It does NOT close the ticket — a human does that after testing, and your verdict is reversible.\n- "more_work" if something the issue asked for is missing. Say precisely what, because the next agent is given your words.\n\nDo not implement anything and do not open a pull request. Judge from what is there. If you genuinely cannot tell, say "more_work" and explain what you could not verify — a wrong "delivered" parks real work silently, while a wrong "more_work" costs one more agent.',
    doc: 'Sent to a code agent for an issue that has had work and has nothing in flight (rule `issue-assess`). It reads the delivered state on the default branch plus the work graph via world_read, and casts a verdict with assess_issue. Placeholders: {number} {title} {body} {branch}.',
  },
  'issue-assay': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'Nothing has been started for issue #{number} ("{title}"). Before anything is, decide whether there is a goal here an agent could work from.\n\n{body}\n\nYou are on branch {branch}, cut from the default branch, so what you can see is the repository as it stands. Read the ticket against it: do the things it names exist, does it say what "done" would look like, does it contradict itself or something already true of the code? Call world_read("issue", "issue:{number}") for the harness\'s own record of the issue, and read anything it points you at.\n\nThen call assay_issue:\n\n- "workable" if there is an identifiable goal to start on. The bar is *actionable*, not *good* or *small* — an opinionated, large or awkward ticket is still workable, and saying so schedules nothing by itself.\n- "unclear" if starting would be guessing. Say exactly what you would need, addressed to the person who wrote the ticket: the specific question, not "it is vague". Nothing is dispatched for this issue while that stands, so a wrong "unclear" stops real work — but it is undone by an edit, a comment, or an operator clearing it.\n\nThen leave one note on this goal\'s scratchpad with scratch_append, on either verdict. Finding where in the repository this ticket lands is most of what you just did, and nothing else carries it out of here: the summary you hand assay_issue is written to justify the verdict, and the next agent dispatched on this goal is given the title, the body and a branch name. Write where the goal lives — the files and areas you read to decide — what you found when you read them, and what you expect the shape of the work to be. On "unclear" it is worth more, not less: that hold ends when somebody edits the ticket, and whoever picks it up then should know what you went looking for and did not find.\n\nA paragraph, not a tour. It is read as testimony rather than instruction — the agent reading it is told to check anything it relies on, because the repository is the truth and your note is one agent\'s reading of it — so write what you actually saw, and no more of the codebase than that. A note longer than the pad takes is trimmed to fit rather than refused, so the end of a long one is lost without anyone being told.\n\nDo not implement anything, do not open a pull request, and do not edit the ticket. The note is an observation, not a head start: no design, no patch, nothing for the next agent to apply. If you are torn, say "workable": the agent that picks it up can escalate to a human from inside the work, which is a better place to ask from than here.',
    doc: "Sent to a code agent for a watched open issue nothing has been started for (rule `issue-assay`). It reads the ticket against the default branch and casts a verdict with assay_issue, and leaves one note on the goal's scratchpad with scratch_append — on either verdict, since an `unclear` hold ends with an edit and the agent that picks it up then is the one with least to go on. The orientation it did to answer the question is otherwise discarded at exit, and `priorWorkBriefing` already renders the pad to every later agent on the goal as testimony, so asking for the note is the whole mechanism. A deployment that overrides this template keeps its own body and gets no note — the ordinary cost of an override, not a fault. Placeholders: {number} {title} {body} {branch}.",
  },
  'issue-retro': {
    placeholders: ['number', 'title', 'body'],
    template:
      'Issue #{number} ("{title}") has been delivered. Write the retrospective for it — the account of what shipped, and of how the work actually went.\n\n{body}\n\nYou have no worktree and you are not implementing anything. What you have is the scratchpad the agents on this goal left and the record the harness kept, both appended below, plus world_read if you need the state of a pull request or the issue itself.\n\nWrite one document, in markdown, for two readers:\n\n1. **What shipped** — for someone reviewing this goal who did not watch it happen: the pull requests, what each part delivered or decided, what was concluded to need no code or to be out of scope, and anything still outstanding.\n2. **How the run went** — for the operator: where agents were spent and on what, which gates, escalations or retries cost time, what surprised the agents, and what you would change about the process — a prompt, a gate, a config, a habit of decomposition. Be specific and name the evidence; "it went well" helps nobody, and neither does a list of everything that happened.\n\nQuote the scratchpad where it earns it and attribute it, and say plainly where the pad and the harness\'s record disagree — that disagreement is usually the most useful thing in the document.\n\n## Lessons\n\nThe document is read once, by a person. A **lesson** is the part worth keeping: something this run taught about *working this repository* that the next goal would otherwise pay to learn all over again. One question decides what qualifies — does it describe **the repository**, or **working the repository**?\n\n| What you noticed | Where it goes |\n| --- | --- |\n| The suite needs the web bundle built first; this subsystem\'s tests sit at an odd seam; a ticket naming only a symptom is under-specified for a planner every time | A **lesson** on this submission |\n| A fact about the code — a seam, an invariant, a second place a thing must be registered | The repository\'s own docs, as a change a human merges. Say so in the document; do not file it as a lesson |\n| A defect noticed in passing | **report_finding** |\n| Something true only of this goal | The scratchpad, where it dies with the goal — correctly |\n\nFile the one or two a reader would thank you for, not everything you noticed: each lands as a *proposal* that reaches no agent until an operator vouches for it, and a list nobody finishes reading is a list nobody promotes from. A run that taught nothing general is the ordinary case — submit no lessons and the retrospective is complete.\n\nThen call retro_submit with a summary of one or two sentences, the document itself, and any lessons. Nothing you write is posted to the tracker, nothing is closed, and nothing is scheduled from it: a human reads it and decides what to change.',
    doc: "Sent to a desk agent when an issue the harness parked as delivered has no retrospective yet (rule `issue-retro`). The issue's scratchpad and the harness dossier are *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop them. An override also does not carry the lesson discriminator this default states — `retro_submit`'s own description repeats it for that reason, so an agent hears it either way. Placeholders: {number} {title} {body}.",
  },
  'validation-check': {
    placeholders: ['number', 'title', 'letter', 'root'],
    template:
      'Issue #{number} ("{title}") has been delivered, and check {letter} of its validation plan has been handed to the fleet to run. Run it, and report what you saw.\n\n' +
      'The check itself is appended below: a procedure and what a pass looks like. Follow the procedure as written. You are on a branch cut from the default branch, so the repository you can see is the delivered state — this is not a branch to build on, and nothing you do here should be committed or pushed.\n\n' +
      'Anything the check needs that is not in the repository lives under {root}. It is named there, not pathed, so look for the names the check lists.\n\n' +
      'Then call validation_report exactly once. Which check you are reporting on is already decided by what you were dispatched to run, so you say only what happened:\n\n' +
      '- "passed" — you followed the procedure and saw what it says to expect. Say what you actually saw, not that it passed.\n' +
      '- "failed" — you followed the procedure and did not see it. Say what happened instead. A failure here is a finding about the goal and it is worth having.\n' +
      '- "handback" — you could not run it. Say what stopped you. This is the right answer, not a last resort: the fleet has no interactive login, no browser and no account on whatever environment this deployment tests against, and a check that needs one is a check for a person. It records no result and returns the check to the operator with your reason.\n\n' +
      '**Do not report "passed" from evidence you did not gather.** A green build, a merged pull request, code that looks correct and a test suite that already covers it are none of them this check: it exists precisely because those had all happened and somebody still wanted the thing exercised. If you did not carry out the procedure, the answer is "handback".\n\n' +
      'If the check describes something that no longer exists — a screen that moved, a command that was renamed — call validation_amend to correct its wording rather than failing it, and then report against what you did.',
    doc: "Sent to a code agent when an operator has handed a validation check to the fleet and the goal is parked as delivered (rule `validate-check`). The check's own procedure, expectation and resources are *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop the half the agent cannot act without. Placeholders: {number} {title} {letter} {root}.",
  },
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
  'pr-review-comment': {
    placeholders: ['number', 'branch', 'author', 'comment'],
    template:
      'There is unaddressed review feedback on PR #{number} (branch {branch}), from {author}. Every unresolved thread is listed below.\n\n' +
      'Read all of them before you change anything. They usually come from one review pass, so they are related: a fix for one may already resolve another, or contradict it. Work out what the reviewer is asking for as a whole, then make one coherent set of changes.\n\n' +
      'For each thread, decide whether to fix the code or defend the current approach, and say which you did. If defending, prepare a concise reply naming the thread.',
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
  'finding-ticket': {
    placeholders: ['kind', 'kindHelp', 'ref', 'summary', 'originRef', 'tracker'],
    template:
      'An operator wants a finding filed as a ticket so it can be dealt with later. **Write it up — ' +
      'do not fix it, and do not create it yourself.**\n\n' +
      'It was reported by an agent working {originRef}, about {ref}, as a "{kind}" finding ({kindHelp}).\n\n' +
      'The report, verbatim:\n\n{summary}\n\n' +
      'It will be filed in {tracker}. The harness creates the item itself, so the type it is created ' +
      'as, the labels it carries and who it is assigned to are already settled and there is no ' +
      'command for you to run — your job is the words.\n\n' +
      'Write the ticket for someone who was not there: a title that says what is wrong, and a body ' +
      'carrying the report above, where it was found, and what you were able to verify. Verify what ' +
      'you reasonably can from the repository first, and say in the body which parts you confirmed ' +
      "and which are the reporting agent's word — it is one agent's reading, not established fact.\n\n" +
      'When you have both, call the link_ticket tool with `title` and `body`. That call is what files ' +
      'the ticket and finishes this task: without it the operator sees a filing that never completed. ' +
      'If an existing item already covers this, do not write a second — call link_ticket with that ' +
      'item\u2019s ref ("issue:314") instead, and it is linked rather than filed.',
    doc:
      'Sent to a desk agent when an operator clicks "File ticket" on a finding. The agent writes the ' +
      'ticket; since #394 the **harness** creates it, so this prompt no longer carries a `gh`/`az` ' +
      'command and an agent cannot forget a label, a type or an assignee. Override this to control ' +
      'how tickets are worded. Candidate duplicates from the harness\u2019s ticket mirror are appended ' +
      'after this text rather than interpolated, so an override cannot silently drop them. ' +
      'Placeholders: {kind} {kindHelp} {ref} {summary} {originRef} {tracker}.',
  },
  'raise-bug': {
    placeholders: ['number', 'title', 'summary', 'tracker'],
    template:
      'An operator ran work item #{number} ("{title}") and it does not do what they expect. **Write ' +
      'the bug up — do not fix it, and do not create it yourself.**\n\n' +
      'Their report, verbatim:\n\n{summary}\n\n' +
      'This is the operator speaking, not an agent: it is what they observed running the thing, which ' +
      'is not something you can find in the repository. Treat it as the goal. Where you cannot ' +
      'reproduce or locate it, say so in the bug — do not narrow it to whatever you did find, and do ' +
      'not decide it is not a bug.\n\n' +
      'It will be filed in {tracker}. The harness creates the item itself and links it back to ' +
      'story #{number}, so the type, the labels, the assignee and the relation are already settled ' +
      'and there is no command for you to run — your job is the words.\n\n' +
      'Write the bug for someone who was not there: a title naming the symptom (not the suspected ' +
      'cause), and a body carrying the report above verbatim, what you were able to verify against ' +
      'the repository, and where you think it lives if you found it. Say which parts you confirmed ' +
      'and which are the operator\u2019s word — they observed a symptom, and the diagnosis is yours and ' +
      'provisional.\n\n' +
      'When you have both, call the link_ticket tool with `title` and `body`. That call is what files ' +
      'the bug and finishes this task: without it the operator sees a filing that never completed. If ' +
      'an existing item already covers this symptom, do not write a second — call link_ticket with ' +
      'that item\u2019s ref ("issue:314") instead, and it is linked rather than filed.',
    doc:
      'Sent to a desk agent when an operator clicks "raise issue" on a work item. The operator types ' +
      'the symptom; the agent writes it up; since #394 the **harness** files it and draws the link ' +
      'back to the story, so neither the bug type nor the relation depends on an agent remembering a ' +
      'flag. A project whose bug type is not called "Bug" sets `issueBugType` rather than overriding ' +
      'here. Candidate duplicates from the ticket mirror are appended after this text. Placeholders: ' +
      '{number} {title} {summary} {tracker}.',
  },
  'blueprint-ticket': {
    placeholders: ['request', 'tracker', 'watchLabel', 'labelling'],
    template:
      'An operator asked for a piece of work. Before it is done, it needs a ticket, so it flows ' +
      'through the same planning funnel as any other issue rather than being coded straight off this ' +
      'prompt. **File the ticket — do not do the work.**\n\n' +
      'The request, verbatim:\n\n{request}\n\n' +
      'File it in {tracker}\n\n' +
      '{labelling}\n\n' +
      'Before you create anything, search the existing open items for one that already covers this. ' +
      'If one does, do not file a second — link the existing one instead (and if it is not already ' +
      'watched, the operator can tag it). Write the ticket for someone who was not there: a title ' +
      'that names the work, and a body carrying the request above and any scope or acceptance you can ' +
      'infer from it. Do not begin the work yourself, and do not open a pull request — the harness ' +
      'will plan and dispatch it once the ticket exists.\n\n' +
      'When the ticket exists, call the link_ticket tool with its ref ("issue:314"). That call is what ' +
      'finishes this task: without it the operator sees a filing that never completed. If you decided ' +
      'not to file because a suitable item already exists, call link_ticket with that item\u2019s ref.',
    retired: true,
    doc:
      '**Retired in #394 — no longer rendered.** A blueprint\u2019s ticket is now filed by the harness ' +
      'directly, because its body is the operator\u2019s own request verbatim and its correctness rested ' +
      'entirely on the agent remembering to add the watch label: without it the item is created, the ' +
      'filing shows as complete, and nothing is ever dispatched for it. Word the item through ' +
      '`blueprint-ticket-body` instead. An override left here still loads — it is simply not sent.',
  },
  'work-item-ticket': {
    placeholders: ['ref', 'workTitle', 'produced', 'tracker'],
    template:
      'An operator wants a work item filed for work the harness has already done. **Record it — do not ' +
      'do it again.** The work is finished or under way; what is missing is a tracker item accounting ' +
      'for it, so that someone reading the board can see it happened and close it when they are ' +
      'satisfied.\n\n' +
      'It ran as {ref}: "{workTitle}".\n\n' +
      'What it produced, as the harness recorded it:\n\n{produced}\n\n' +
      'File it in {tracker}\n\n' +
      'Before you create anything, search the existing items for one that already covers this work. If ' +
      'one does, do not file a second — link the existing one instead. Write the ticket for someone who ' +
      'was not there: a title naming the change, and a body saying what was done, which pull requests ' +
      'carried it, and what state they are in. Where the list above says a merge was "inferred", the ' +
      'harness assumed it from the pull request disappearing rather than watching it merge — say so ' +
      'rather than asserting it as fact. Do not describe work as complete if you cannot confirm it.\n\n' +
      'When the item exists, call the link_ticket tool with its ref ("issue:314"). That call is what ' +
      'finishes this task and what attaches the work to the item in the record: without it the operator ' +
      'sees a filing that never completed. If you decided not to file because a suitable item already ' +
      'exists, call link_ticket with that item\u2019s ref.',
    retired: true,
    doc:
      '**Retired in #394 — no longer rendered.** The harness files this item directly: its body was ' +
      'already composed here in full (`produced` is the harness\u2019s own walk of the work subtree), so ' +
      'the only thing being delegated was a title, and a whole desk agent was being spent on one API ' +
      'call. Word the item through `work-item-ticket-body` instead. An override left here still ' +
      'loads — it is simply not sent.',
  },
  'work-item-ticket-body': {
    placeholders: ['ref', 'workTitle', 'produced'],
    template:
      'This item records work the harness has already done. It is finished or under way; what was ' +
      'missing is a tracker item accounting for it, so that someone reading the board can see it ' +
      'happened and close it when they are satisfied.\n\n' +
      'It ran as {ref}: "{workTitle}".\n\n' +
      'What it produced, as the harness recorded it:\n\n{produced}\n\n' +
      'Where the list above says a merge was "inferred", the harness assumed it from the pull request ' +
      'disappearing rather than watching it merge, rather than observing the merge itself.',
    doc:
      'The **body** of the work item the harness files when an operator clicks "File a work item" on ' +
      'unrecorded work in the Work panel — an operator job that produced commits with no issue behind ' +
      'it. Not a prompt: it is written straight into the tracker, so an override is house style for ' +
      'how such an item reads. The title is the work\u2019s own. Replaces the retired `work-item-ticket`, ' +
      'which asked an agent to do the same filing by hand (#394). Placeholders: {ref} {workTitle} ' +
      '{produced}.',
  },
  'blueprint-ticket-body': {
    placeholders: ['request'],
    template:
      'An operator asked for this work from the cockpit, as a blueprint. It is filed as a ticket ' +
      'rather than coded straight off, so it flows through the same planning funnel as any other ' +
      'issue.\n\nThe request, verbatim:\n\n{request}',
    doc:
      'The **body** of the ticket the harness files when an operator injects a code blueprint and a ' +
      'tracker is configured (issue #198). Not a prompt: it is written straight into the tracker, so ' +
      'an override is house style for how such a ticket reads. The harness adds the watch label ' +
      'itself, which is what makes the funnel pick the ticket up. Replaces the retired ' +
      '`blueprint-ticket` (#394). Placeholders: {request}.',
  },
};

const KNOWN_IDS = Object.keys(REGISTRY) as PromptId[];

/** Every `{token}` referenced in a template body. */
function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

/**
 * Fill `{name}` tokens from `vars`. Pure. A token with no matching var is left
 * untouched (a default template only ever references vars the caller supplies;
 * an override is placeholder-validated at load, so this can't silently drop
 * data). Values stringify — numbers included.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars && vars[name] !== undefined ? String(vars[name]) : whole,
  );
}

/**
 * Strip a single leading HTML-comment block (the operator's "what/when" doc)
 * plus surrounding whitespace, so a documented override file never leaks its
 * documentation into the agent's prompt. Only a *leading* comment is removed —
 * a comment inside the prompt body is left alone.
 */
export function stripTemplateDoc(raw: string): string {
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
}

/** The `<!-- doc -->` + body a sample/scaffold override file should contain. */
export function sampleTemplateFile(id: PromptId): string {
  return `<!--\n  ${REGISTRY[id].doc}\n-->\n\n${REGISTRY[id].template}\n`;
}

/** One template as the cockpit shows it: what it is, and what it says. */
export interface PromptTemplateDescription {
  readonly id: PromptId;
  /** What the prompt is for and when it fires — the registry's own note. */
  readonly doc: string;
  /** The `{token}`s this id may reference, i.e. what an override may use. */
  readonly placeholders: readonly string[];
  /** The **effective** text: the override where there is one, else the default. */
  readonly template: string;
  /** Whether an operator override replaced the built-in. */
  readonly overridden: boolean;
  /** True for an id the harness no longer renders — see {@link TemplateDef.retired}. */
  readonly retired: boolean;
}

/**
 * The resolved template book handed to the dispatcher: defaults overlaid with
 * any operator overrides. Construct via {@link loadPromptTemplates} (reads the
 * override dir) or {@link defaultPromptTemplates} (defaults only, for tests).
 */
export class PromptTemplates {
  private readonly templates: Record<PromptId, string>;
  private readonly overridden: Set<PromptId>;
  constructor(overrides: Partial<Record<PromptId, string>> = {}) {
    this.templates = {} as Record<PromptId, string>;
    for (const id of KNOWN_IDS) this.templates[id] = overrides[id] ?? REGISTRY[id].template;
    // Held rather than re-derived: the book is the one thing that knows an
    // override happened, and a consumer comparing the text back against
    // REGISTRY would be a second opinion able to disagree with it.
    this.overridden = new Set(KNOWN_IDS.filter((id) => overrides[id] !== undefined));
  }
  /** Render prompt `id` with `vars`. */
  render(id: PromptId, vars: Record<string, string | number | undefined>): string {
    return renderTemplate(this.templates[id], vars);
  }
  /**
   * The whole book, for `GET /api/prompts`. The effective text, so the cockpit
   * shows what the dispatcher actually sends rather than what ships in the box.
   */
  describe(): PromptTemplateDescription[] {
    return KNOWN_IDS.map((id) => ({
      id,
      doc: REGISTRY[id].doc,
      placeholders: REGISTRY[id].placeholders,
      template: this.templates[id],
      overridden: this.overridden.has(id),
      retired: REGISTRY[id].retired === true,
    }));
  }
}

/** Defaults only — the built-in prompts, no overrides. */
export function defaultPromptTemplates(): PromptTemplates {
  return new PromptTemplates();
}

/**
 * Read `<id>.md` overrides from `dir` and fold them onto the defaults. Absent
 * dir => defaults. Fails fast on a file that names no known id, references an
 * unknown placeholder, or is empty once its doc header is stripped — an
 * operator typo surfaces at boot, not as a silently broken prompt.
 */
export function loadPromptTemplates(dir: string | undefined): PromptTemplates {
  if (!dir || !existsSync(dir)) return defaultPromptTemplates();
  const overrides: Partial<Record<PromptId, string>> = {};
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.md') continue;
    const id = basename(file, '.md') as PromptId;
    if (!KNOWN_IDS.includes(id)) {
      throw new Error(
        `Prompt template "${file}" in ${dir} names no known prompt id. Known ids: ${KNOWN_IDS.join(', ')}.`,
      );
    }
    const body = stripTemplateDoc(readFileSync(join(dir, file), 'utf8'));
    if (!body) throw new Error(`Prompt template "${file}" in ${dir} is empty after its doc header.`);
    const allowed = REGISTRY[id].placeholders;
    const unknown = [...new Set(placeholdersIn(body))].filter((p) => !allowed.includes(p));
    if (unknown.length > 0) {
      throw new Error(
        `Prompt template "${file}" references unknown placeholder(s) {${unknown.join('}, {')}}. ` +
          `Allowed for "${id}": ${allowed.length ? `{${allowed.join('}, {')}}` : '(none)'}.`,
      );
    }
    overrides[id] = body;
  }
  return new PromptTemplates(overrides);
}
