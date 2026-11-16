# CLAUDE.md — `src/sequence/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Story sequencing

- **A sequence hold must fail open, on every arm.** `sequenceReadiness` is the one mechanism in the
  book that _withholds_ work, and its failure is the quietest there is: a story held behind one that
  never lands simply never starts, with nothing red. No order, an unaccepted one, a declined one, an
  edge naming an issue the world does not hold, a cycle, `issueSequencing` off — every one leaves
  every story eligible in exactly the order it has today. → [33](../../docs/spec/33-story-sequencing.md#fail-open)
- **The sequence key digests membership, never movement.** Filtering the settled children out of it
  re-proposes an order on every merge and asks an operator to re-accept the same sequence eight
  times. → [33](../../docs/spec/33-story-sequencing.md#the-record)
