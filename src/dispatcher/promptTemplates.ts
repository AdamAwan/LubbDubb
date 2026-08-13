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
}

const REGISTRY: Record<PromptId, TemplateDef> = {
  'issue-plan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile'],
    template:
      'Issue #{number} ("{title}") needs a delivery plan before any code is written.\n\n{body}\n\n' +
      'Read the repository and decide whether this work is ONE pull request or several. ' +
      'Bias hard toward one: splitting is the exception, and turning a twenty-minute fix into three PRs ' +
      'costs far more than it saves. Split only when the work genuinely cannot land as a single reviewable ' +
      'PR — for example when a schema or interface change must merge before the code that consumes it.\n\n' +
      'Submit your verdict with the plan_submit tool if you have it — it validates on the spot, so a ' +
      'rejected plan comes back with the reason and you can fix it and call again. Otherwise write the ' +
      'same document to {planFile} in this worktree, creating the directory if needed. For one PR:\n\n' +
      '  {"version": 1, "verdict": "single", "reason": "<one sentence: why this shape>",\n' +
      '   "diagnosis": "<what is actually wrong>", "approach": "<what you are going to do about it>",\n' +
      '   "risks": "<what could go wrong>", "outOfScope": "<what you are not doing>",\n' +
      '   "document": "<the full write-up, markdown>"}\n\n' +
      'For several, each part being one reviewable PR:\n\n' +
      '  {"version": 1, "verdict": "parts", "reason": "<one sentence: why this shape>",\n' +
      '   "diagnosis": "...", "approach": "...",\n' +
      '   "risks": "...", "outOfScope": "...", "document": "...", "parts": [\n' +
      '    {"slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": [],\n' +
      '     "rationale": "why this is its own PR", "acceptance": "what makes it done"},\n' +
      '    {"slug": "dispatcher", "title": "...", "scope": "src/dispatcher/...", "dependsOn": ["schema"],\n' +
      '     "rationale": "...", "acceptance": "..."},\n' +
      '    {"slug": "wire-up", "title": "...", "scope": "src/system.ts", "dependsOn": ["schema", "dispatcher"],\n' +
      '     "rationale": "...", "acceptance": "..."}\n' +
      '  ]}\n\n' +
      'Slugs are short, lowercase, kebab-case and unique; "scope" names the files or areas that part owns, ' +
      'so parts running at the same time do not collide; "dependsOn" names the sibling slugs a part needs before ' +
      'it can start. Usually that is none or one. **One** means it stacks: it starts as soon as that sibling has ' +
      'pushed a branch, and is cut from that branch. **Several** means the lanes rejoin: a part naming several ' +
      'does not start until every one of them has **merged**, and is then cut from the integration branch. Use it ' +
      'for work that genuinely gathers separate lanes back together — the part that wires two independent pieces ' +
      'to each other — and not to express a vague ordering, because it waits for all of them.\n\n' +
      '"expectedKind" is optional and defaults to "code" — a part that ends in a merged pull request. Use ' +
      '"report" when the deliverable is a write-up or a measurement, and "determination" when the part ' +
      'decides whether anything needs building at all. They exist so investigative work can be decomposed ' +
      'honestly instead of inventing pull requests for it; do not reach for them when the work is code.\n\n' +
      '"diagnosis" and "approach" are the two the operator reads first, and they are the two nobody can ' +
      'reconstruct from the rest: **diagnosis** is what is actually wrong — the root cause you found in the ' +
      'code, named precisely, not a restatement of the issue text you were given; **approach** is what you ' +
      'are going to do about it, in two or three sentences. Neither one is about how the work is split. ' +
      'Leave "diagnosis" out only when the work is not a defect and there is genuinely nothing to diagnose. ' +
      '"reason" is the narrow question of shape — why one PR, or why these parts — and is not the place ' +
      'for either of the above.\n\n' +
      '"document" is not optional in practice: a human reads it and decides whether this work happens. ' +
      'Write it for them, in markdown — why the work is shaped this way, what you considered and rejected, ' +
      'and a section naming whatever you are least sure about. A plan with no write-up is one they have to ' +
      'take on trust.\n\n' +
      'Do not implement anything and do not open a pull request. Writing {planFile} is the whole job — you ' +
      'are on branch {branch} only so you have the repository to read.',
    doc: 'Sent to a code agent when the planning funnel is enabled and a watched open issue has no plan yet (rule `issue-plan`). The agent writes its verdict to the plan file; nothing else it does is read. Asks for the headline pair (`diagnosis`, `approach` — the root cause and the fix, which is what the plan modal leads with), the write-up (`risks`, `outOfScope`, `document`) and per-part `rationale`/`acceptance` — all optional, so an older override that omits them still validates. Placeholders: {number} {title} {body} {branch} {planFile}.',
  },
  'issue-replan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile', 'current'],
    template:
      'Issue #{number} ("{title}") already has a delivery plan, and an operator has asked for it to be replanned. ' +
      'Amend the existing plan — do not start from scratch.\n\n{body}\n\n{current}\n\n' +
      'Read the repository and the state above, then submit the amended plan with the plan_submit tool if you ' +
      'have it (it validates on the spot and tells you why if it rejects), otherwise write it to {planFile} in ' +
      'this worktree. Either way it is the same document as the original:\n\n' +
      '  {"version": 1, "verdict": "parts", "reason": "<one sentence: why this shape>",\n' +
      '   "diagnosis": "<what is actually wrong>", "approach": "<what you are going to do about it>",\n' +
      '   "risks": "...", "outOfScope": "...", "document": "...", "parts": [\n' +
      '    {"slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": [],\n' +
      '     "rationale": "...", "acceptance": "..."}\n' +
      '  ]}\n\n' +
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
      '- A "single" verdict is only honoured while no part has a branch or a pull request yet.\n' +
      '- **Re-state the write-up.** `diagnosis`, `approach`, `document`, `risks` and `outOfScope` are replaced by ' +
      'what you submit, not merged — an amendment that omits them leaves the previous ones standing, which will ' +
      'read as though the old reasoning still applies. `diagnosis` is the root cause in the code and `approach` ' +
      'is what you are going to do about it; neither is about how the work is split, which is `reason`.\n\n' +
      'Do not implement anything and do not open a pull request. Writing {planFile} is the whole job — you are on ' +
      'branch {branch} only so you have the repository to read.',
    doc: 'Sent to a code agent when an operator hits Replan on an existing plan (rule `issue-plan`, with the plan row back in `planning`). Unlike {issue-plan} it amends rather than plans cold: {current} is the plan and its parts as they stand, and the prompt spells out that slugs are the merge key, that in-flight parts must be re-declared, and that the write-up (`diagnosis`/`approach`/`document`/`risks`/`outOfScope`) is replaced rather than merged. Placeholders: {number} {title} {body} {branch} {planFile} {current}.',
  },
  'discuss-plan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile', 'current'],
    template:
      'An operator wants to talk through the delivery plan for issue #{number} ("{title}") before approving it. ' +
      'This is a conversation, not a planning run: nothing is scheduled while you are talking, and your job is to ' +
      'answer them well and amend the plan if they ask.\n\n{body}\n\n{current}\n\n' +
      'How this works:\n\n' +
      '- Read the repository and the plan above, then use the escalate tool to open the conversation — say what ' +
      'you understand the plan to be and what you think is most worth questioning about it. Escalating parks you ' +
      'until they reply; their reply arrives as your next turn.\n' +
      '- Answer honestly. If they are right that a split is wrong, say so. If they are wrong, say that too and ' +
      'explain why — you have read the code and they may not have.\n' +
      '- Escalate again each time you need them, and keep going until they are satisfied.\n' +
      '- When they are, submit the amended plan with the plan_submit tool (or write it to {planFile}), exactly as ' +
      'a replan would: slugs are the merge key, re-declare every part that is already merged, dispatched or in ' +
      'review, and a part you leave out is retired only if nothing was started for it. Re-state "diagnosis", ' +
      '"approach", "document", "risks" and "outOfScope" — they are replaced by what you submit, not merged.\n' +
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
      'Work on branch {branch}, which is cut from {base}. Open a pull request from {branch} **into {base}** — if ' +
      'that is not the default branch, this PR is stacked on another part and must target it, not the default. ' +
      'Say in the PR body which part of #{number} this is and what it stacks on. Reference the issue as ' +
      '"part of #{number}" and never as "closes #{number}": other parts still have to land.',
    doc: "Sent to a code agent for one part of a multi-PR plan (rule `plan-part`). {plan} is the planner's justification, {done}/{remaining} the sibling parts either side of this one, {base} the branch this part stacks on (the default branch when it stacks on nothing). Placeholders: {number} {title} {part} {scope} {branch} {base} {plan} {done} {remaining}.",
  },
  'plan-approval': {
    placeholders: ['number', 'title', 'parts', 'reason', 'list'],
    template:
      'Issue #{number} ("{title}") was planned as {parts} pull request(s), and nothing is scheduled until you ' +
      'approve the plan.\n\nWhy it was planned this way: {reason}\n\n{list}\n\n' +
      'If you want a different plan, use Replan on the plan panel: that asks the planner again and comes back here.',
    doc: "Put to a human when `planning.requireApproval` is on and a planner's verdict has landed — either arm, a decomposition or a single pull request (rule `plan-approval`). It is a proposal, not a question: the accept/reject buttons settle it, and free text cannot. What approving and rejecting *this* verdict do is appended by the rule rather than templated, so an override cannot lose it. Placeholders: {number} {title} {parts} (the pull requests the plan produces — 1 on a single verdict) {reason} {list}.",
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
      'GitHub issue #{number} ("{title}") needs resolving.\n\n{body}\n\nImplement the fix on branch {branch} and open a pull request that resolves it. Reference the issue as "closes #{number}" only if this PR completes the whole thing; if work remains afterwards, reference it as "part of #{number}" so it stays open for the rest.',
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
      'Nothing has been started for issue #{number} ("{title}"). Before anything is, decide whether there is a goal here an agent could work from.\n\n{body}\n\nYou are on branch {branch}, cut from the default branch, so what you can see is the repository as it stands. Read the ticket against it: do the things it names exist, does it say what "done" would look like, does it contradict itself or something already true of the code? Call world_read("issue", "issue:{number}") for the harness\'s own record of the issue, and read anything it points you at.\n\nThen call assay_issue:\n\n- "workable" if there is an identifiable goal to start on. The bar is *actionable*, not *good* or *small* — an opinionated, large or awkward ticket is still workable, and saying so schedules nothing by itself.\n- "unclear" if starting would be guessing. Say exactly what you would need, addressed to the person who wrote the ticket: the specific question, not "it is vague". Nothing is dispatched for this issue while that stands, so a wrong "unclear" stops real work — but it is undone by an edit, a comment, or an operator clearing it.\n\nDo not implement anything, do not open a pull request, and do not edit the ticket. If you are torn, say "workable": the agent that picks it up can escalate to a human from inside the work, which is a better place to ask from than here.',
    doc: 'Sent to a code agent for a watched open issue nothing has been started for (rule `issue-assay`). It reads the ticket against the default branch and casts a verdict with assay_issue. Placeholders: {number} {title} {body} {branch}.',
  },
  'issue-retro': {
    placeholders: ['number', 'title', 'body'],
    template:
      'Issue #{number} ("{title}") has been delivered. Write the retrospective for it — the account of what shipped, and of how the work actually went.\n\n{body}\n\nYou have no worktree and you are not implementing anything. What you have is the scratchpad the agents on this goal left and the record the harness kept, both appended below, plus world_read if you need the state of a pull request or the issue itself.\n\nWrite one document, in markdown, for two readers:\n\n1. **What shipped** — for someone reviewing this goal who did not watch it happen: the pull requests, what each part delivered or decided, what was concluded to need no code or to be out of scope, and anything still outstanding.\n2. **How the run went** — for the operator: where agents were spent and on what, which gates, escalations or retries cost time, what surprised the agents, and what you would change about the process — a prompt, a gate, a config, a habit of decomposition. Be specific and name the evidence; "it went well" helps nobody, and neither does a list of everything that happened.\n\nQuote the scratchpad where it earns it and attribute it, and say plainly where the pad and the harness\'s record disagree — that disagreement is usually the most useful thing in the document. Then call retro_submit with a summary of one or two sentences and the document itself. Nothing you write is posted to the tracker, nothing is closed, and nothing is scheduled from it: a human reads it and decides what to change.',
    doc: "Sent to a desk agent when an issue the harness parked as delivered has no retrospective yet (rule `issue-retro`). The issue's scratchpad and the harness dossier are *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop them. Placeholders: {number} {title} {body}.",
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
    doc: "Sent to a code agent when a `ci.checks` rule watches a check in a non-failing state (`states`) and that check is in it — the blocking gate that sits pending until something outside the harness acts (rule `pr-ci-gate`). The check names and the rule's guidance are *appended* after this text rather than interpolated, so an override that never learned about them cannot silently drop them. Placeholders: {number} {title} {branch}.",
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
      'An operator wants a finding filed as a ticket so it can be dealt with later. File it — do not fix it.\n\n' +
      'It was reported by an agent working {originRef}, about {ref}, as a "{kind}" finding ({kindHelp}).\n\n' +
      'The report, verbatim:\n\n{summary}\n\n' +
      'File it in {tracker}\n\n' +
      'Before you create anything, search the existing open items for the same thing. If one already ' +
      'covers it, do not file a second — link the existing one instead. Write the ticket for someone ' +
      'who was not there: a title that says what is wrong, and a body carrying the report above, where ' +
      'it was found, and what you were able to verify. Verify what you reasonably can from the ' +
      'repository first, and say in the body which parts you confirmed and which are the reporting ' +
      "agent's word — it is one agent's reading, not established fact.\n\n" +
      'When the ticket exists, call the link_ticket tool with its ref ("issue:314") so it shows up ' +
      'against the finding in the cockpit. That call is what finishes this task: without it the ' +
      'operator sees a filing that never completed. If you decided not to file because it already ' +
      'exists, call link_ticket with the existing item’s ref.',
    doc:
      'Sent to a desk agent when an operator clicks "File ticket" on a finding, to create it in ' +
      'GitHub/Azure DevOps and report the ref back via link_ticket. Override this to control how ' +
      'tickets are worded, labelled, or typed in your tracker. Placeholders: {kind} {kindHelp} {ref} ' +
      '{summary} {originRef} {tracker}.',
  },
  'raise-bug': {
    placeholders: ['number', 'title', 'summary', 'tracker'],
    template:
      'An operator ran work item #{number} ("{title}") and it does not do what they expect. **File a ' +
      'bug for it — do not fix it.**\n\n' +
      'Their report, verbatim:\n\n{summary}\n\n' +
      'This is the operator speaking, not an agent: it is what they observed running the thing, which ' +
      'is not something you can find in the repository. Treat it as the goal. Where you cannot ' +
      'reproduce or locate it, say so in the bug — do not narrow it to whatever you did find, and do ' +
      'not decide it is not a bug.\n\n' +
      'File it in {tracker}\n\n' +
      'Before you create anything, search the existing open items for the same symptom. If one already ' +
      'covers it, do not file a second — link the existing one instead. Write the bug for someone who ' +
      'was not there: a title naming the symptom (not the suspected cause), and a body carrying the ' +
      'report above verbatim, what you were able to verify against the repository, and where you think ' +
      'it lives if you found it. Say which parts you confirmed and which are the operator’s word — ' +
      'they observed a symptom, and the diagnosis is yours and provisional.\n\n' +
      'When the bug exists, call the link_ticket tool with its ref ("issue:314") so it shows up against ' +
      'the story in the cockpit. That call is what finishes this task: without it the operator sees a ' +
      'filing that never completed. If you decided not to file because it already exists, call ' +
      'link_ticket with the existing item’s ref.',
    doc:
      'Sent to a desk agent when an operator clicks "raise issue" on a work item, to file a bug in ' +
      'GitHub/Azure DevOps linked back to that story and report the ref via link_ticket. The operator ' +
      'types the symptom; the agent writes it up. Override this to control how bugs are worded, ' +
      'labelled, or typed in your tracker — a project whose bug type is not called "Bug" (the Basic ' +
      'process calls it "Issue") overrides here. Placeholders: {number} {title} {summary} {tracker}.',
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
      'not to file because a suitable item already exists, call link_ticket with that item’s ref.',
    doc:
      'Sent to a desk agent when an operator injects a **code blueprint** and a tracker is configured ' +
      '(issue #198). Instead of coding the prompt directly, the agent files a watched ticket so the ' +
      'work enters the planning funnel like any picked-up issue. Override this to control how such ' +
      'tickets are worded, labelled, or typed in your tracker. Placeholders: {request} {tracker} ' +
      '{watchLabel} {labelling}.',
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
      'exists, call link_ticket with that item’s ref.',
    doc:
      'Sent to a desk agent when an operator clicks "File a work item" on unrecorded work in the Work ' +
      'panel — an operator job that produced commits with no issue behind it. Creates the item in ' +
      'GitHub/Azure DevOps and reports the ref back via link_ticket. Override this to control how such ' +
      'items are worded, labelled, or typed in your tracker. Placeholders: {ref} {workTitle} {produced} ' +
      '{tracker}.',
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
