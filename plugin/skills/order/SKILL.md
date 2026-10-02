---
name: order
description: Discuss and change the order the stories under a LubbDubb feature are worked in — what waits on what. Use for "/lubbdubb:order 500", "which story should go first?".
argument-hint: '<feature>'
---

## Discuss the order the stories go in

A Feature's stories can carry an **order**: which of them cannot start until
another has produced something. It is not priority — priority is which of two
things somebody wants first, and this is whether starting one early would mean
throwing the work away. An accepted order **holds work**: a story behind another
does not start until that one has pushed a branch.

There is no drag-to-reorder in the cockpit, and this is the door instead. The
reason behind a reordering is the half worth keeping, and a drag loses it.

1. **Read it first.** `sequence_read` takes the Feature number _or_ any story
   under it — a story resolves to its parent, because an order is a statement
   about a Feature. It comes back with every story, the edges, the sequencer's
   reason, and whether anybody has accepted it.
2. **Talk it through.** Which edge do they disagree with, and why? An order is a
   claim about what one story produces that another would otherwise invent — a
   schema, an interface, a migration. Two stories that merely relate are not
   ordered.
3. **Write the whole order back.** `sequence_amend` replaces what stands rather
   than patching it, so **keep every edge you are not deliberately changing**.
   `reason` is what the next person to read the Feature gets.

**An order the sequencer proposed waits for an answer**, and `sequence_read` says
so in `status: "proposed"`. If the operator agrees with it as it stands,
`sequence_answer` with `answer: "accept"` makes it hold work from the next pulse,
exactly as written. If they say the stories are independent, `answer: "decline"`
is a real answer, stored: it releases every story, and the fleet does not propose
again until the Feature gains or loses a story. Answer only what they actually
said — to change an edge, amend instead.

Three things to say out loud when you have written one:

- It lands **accepted**, so it holds work from the next pulse. There is no
  approval step after this — the operator you are talking to _is_ the approval.
- An **empty** order is a real answer, and the way to release one: it says the
  stories are independent after all and frees everything the previous order held.
- A story the operator has flagged as a priority, or dragged to the top of Up
  next, is dispatched **through** the hold. If they want one story to go early,
  that is the control — amending the order is for when the order itself is wrong.

**Do not invent an order to be helpful.** A wrong edge is the quietest failure
this harness has: a story held behind one that never lands simply never starts,
and nothing goes red. If you cannot support an edge from what the items actually
say, leave it out.
