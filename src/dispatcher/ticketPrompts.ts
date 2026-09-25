import type { TemplateDef } from './promptTemplates.js';

export const TICKET_PROMPTS = {
  'finding-ticket': {
    placeholders: ['kind', 'kindHelp', 'ref', 'summary', 'originRef', 'tracker'],
    template:
      'An operator wants a claim filed as a ticket so it can be dealt with later. **Write it up — ' +
      'do not fix it, and do not create it yourself.**\n\n' +
      'It was raised by an agent working {originRef}, about {ref}.\n\n' +
      'The report, verbatim:\n\n{summary}\n\n' +
      'It will be filed in {tracker}. The harness creates the item itself, so the type it is created ' +
      'as, the labels it carries and who it is assigned to are already settled and there is no ' +
      'command for you to run — your job is the words.\n\n' +
      'Write the ticket for someone who was not there: a title that says what is wrong, and a body ' +
      'carrying the report above, where it was found, and what you were able to verify. Verify what ' +
      'you reasonably can from the repository first, and say in the body which parts you confirmed ' +
      "and which are the raising agent's word — it is what the fleet believes, not established fact.\n\n" +
      'When you have both, call the link_ticket tool with `title` and `body`. That call is what files ' +
      'the ticket and finishes this task: without it the operator sees a filing that never completed. ' +
      'If an existing item already covers this, do not write a second — call link_ticket with that ' +
      'item\u2019s ref ("issue:314") instead, and it is linked rather than filed.',
    retired: true,
    doc:
      '**Retired — no longer rendered.** It was sent to a desk agent when an operator clicked "File ' +
      'ticket" on a claim, and the claim store it filed from is gone (`docs/spec/27-obstacles.md`). ' +
      'What files a ticket now is the obstacle ownership desk, which composes the body mechanically ' +
      'through `obstacle-ticket-body` rather than dispatching an agent to write one — a row on the ' +
      'board already carries every sighting in its author\u2019s own words, which is what this prompt ' +
      'was asking an agent to assemble. An override left here still loads; it is simply not sent.',
  },
  'docs-change': {
    placeholders: ['ref', 'summary', 'originRef'],
    template:
      'An agent working {originRef} learned something about **this repository** that the repository ' +
      'itself does not say, and an operator has committed it. Write the documentation change and open ' +
      'a pull request for it.\n\n' +
      'It came up on {ref}. The report, verbatim:\n\n{summary}\n\n' +
      '**Check it against the code before you write a word of it.** It is one agent’s reading of what ' +
      'it happened to touch, not an established fact, and a document is exactly the wrong place to ' +
      'record a plausible mistake — everyone after you reads it as settled. Go to the code the report ' +
      'names, confirm the claim holds in general and not only in the case that agent hit, and if it ' +
      'does not, say so and stop. Stopping is a good outcome here: it costs one dispatch and saves a ' +
      'false line that nothing would ever have gone red about.\n\n' +
      '**Then find the document that already owns this.** A repository that documents itself has a ' +
      'place for this fact, and the change is almost always a paragraph or a row added where the ' +
      'subject is already covered — beside the invariants it belongs with, in the voice the rest of ' +
      'that document uses. A new file is the answer only when nothing there covers the area at all, ' +
      'and a note bolted onto the end of a README is not one. If the repository keeps a rule about ' +
      'which document owns what, follow it rather than this paragraph.\n\n' +
      'Write the *fact*, not the story of finding it: what is true, where it bites, and what breaks ' +
      'if someone does not know it. No mention of the harness, the agent, this job or the goal it was ' +
      'learned on — that provenance is the operator’s, and in the repository’s own docs it is noise ' +
      'about a tool the repository does not use.\n\n' +
      '**Change documentation, not code.** If checking the claim turned up an actual defect, `raise` it ' +
      'as its own claim, not a fix smuggled into a docs pull request.\n\n' +
      'Finish by **opening a pull request**, and nothing else finishes this: not a commit on the ' +
      'integration branch, not a direct push, not a summary of what you would have written. This is ' +
      'the repository’s own knowledge going into the repository’s own tree, and a human merging it is ' +
      'the whole gate. If the pull request is not opened, nothing has happened — which is correct.',
    doc:
      'Sent to a **code** agent when an operator promotes a `docs` finding (`POST /api/findings/:id/promote`) — ' +
      'a fact about the repository that its own documentation does not state. A code job rather than a desk one ' +
      'because it writes files in a tree, so it needs a worktree and a branch to open the pull request from. ' +
      "Overridable for `finding-ticket`'s reason: which document owns what, how a change should be worded, and " +
      'what your project wants in a docs PR are house style, not harness logic — a repository with a stated rule ' +
      "about where documentation lives wants that rule here. The report's `where` and `detail` ride in on " +
      '{summary} rather than placeholders of their own, so an override that predates them still renders them. ' +
      'Placeholders: {ref} {summary} {originRef}.',
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
      '**Retired in #394 — no longer rendered.** A brief\u2019s ticket is now filed by the harness ' +
      'directly, because its body is the operator\u2019s own request verbatim and its correctness rested ' +
      'entirely on the agent remembering to add the watch label: without it the item is created, the ' +
      'filing shows as complete, and nothing is ever dispatched for it. Word the item through ' +
      '`brief-ticket-body` instead. An override left here still loads — it is simply not sent.',
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
      'An operator asked for this work from the cockpit, as a brief. It is filed as a ticket ' +
      'rather than coded straight off, so it flows through the same planning funnel as any other ' +
      'issue.\n\nThe request, verbatim:\n\n{request}',
    retired: true,
    doc:
      '**Retired \u2014 renamed to `brief-ticket-body`.** What the cockpit calls a *brief* was called a ' +
      '*blueprint* until the rename; the id followed the word. The old id stays loadable so a ' +
      'deployment carrying a `blueprint-ticket-body.md` override still boots, but it is no longer ' +
      'rendered \u2014 move the wording to `brief-ticket-body`. Placeholders: {request}.',
  },
  'brief-ticket-body': {
    placeholders: ['request'],
    template:
      'An operator asked for this work from the cockpit, as a brief. It is filed as a ticket ' +
      'rather than coded straight off, so it flows through the same planning funnel as any other ' +
      'issue.\n\nThe request, verbatim:\n\n{request}',
    doc:
      'The **body** of the ticket the harness files when an operator injects a code brief and a ' +
      'tracker is configured (issue #198). Not a prompt: it is written straight into the tracker, so ' +
      'an override is house style for how such a ticket reads. The harness adds the watch label ' +
      'itself, which is what makes the funnel pick the ticket up. Replaces the retired ' +
      '`blueprint-ticket` (#394), and the `blueprint-ticket-body` this was called before the rename. ' +
      'Placeholders: {request}.',
  },
} satisfies Record<string, TemplateDef>;
