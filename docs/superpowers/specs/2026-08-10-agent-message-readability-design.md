# Findings an operator can read at a glance

## The problem

A finding arrives as one undifferentiated block of prose. `report_finding` takes a single
`summary` field whose description asks for "what it is, where, and why it matters" plus the
evidence — four things, one string, up to 2000 characters — and `FindingsPanel` draws whatever
comes back as a single `<div>`. The claim, the identifier, the file path and the stack trace all
land in the same paragraph at the same weight, so picking out the part that decides what to do
means reading the whole thing.

The text is not structured text being squashed by the renderer. It is genuinely one lump, because
nothing ever asked the agent for parts. That places the fix at the authoring end: a field an agent
must name is what separates the claim from the location from the evidence. Rendering alone would
make a well-written finding prettier and do nothing at all for the ones that hurt.

Scope is findings and escalations only. Conclusions, assessments, progress notes, plans and retros
have the same shape of problem, but the field split is a guess until a few real findings have been
read against it; proving it on two surfaces first is cheaper than redoing six.

## The tool contract

`report_finding` takes five arguments.

| arg       | required | shape                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------- |
| `kind`    | yes      | unchanged — `duplicate` / `blocked` / `out_of_scope`                          |
| `summary` | yes      | one line, no newlines, ≤160 characters. The claim and nothing else.           |
| `where`   | no       | ≤200 characters. File and line, package, service, endpoint — what locates it. |
| `detail`  | no       | ≤2000 characters, markdown. The evidence: error, repro, reasoning.            |
| `ref`     | no       | unchanged — the closed `pr:` / `issue:` vocabulary                            |

Everything past `summary` is optional, so an agent with nothing to add writes nothing. A required
`where` or `evidence` would be padded with "N/A" and the noise would be worse than the blob.

`validateFinding` grows three refusals, each naming the field the text belongs in:

- a newline in `summary` — "one line; put the evidence in `detail`";
- `summary` over 160 characters — same redirect;
- `detail` over 2000 characters.

The 2000-character cap moves off `summary` and onto `detail`. **Refusing the newline is the
load-bearing part.** It is what turns a blob into a tool error the agent fixes inside its own turn,
rather than something an operator reads hours later. Validation stays pure and at the boundary, for
the reason it already was: a malformed report should be correctable, not filed.

## Storage and wire

`where` and `detail` are nullable `TEXT` columns on the **existing** `findings` table, so both are
declared in `FINDING_COLUMNS` beside `ticket_ref`. Without that entry they are invisible on every
database created before today, and nothing errors — which is the whole failure mode.

`Finding` gains `where: string | null` and `detail: string | null`. `src/wire.ts` inherits the
domain type unchanged.

**The dedup rule changes.** The key stays `(agentId, kind, ref, summary)`, but a repeat now
overwrites `where` and `detail` with the newer values rather than only refreshing `updatedAt`. The
headline identifies the claim; the same claim filed again with better evidence should keep the
better evidence. Status is still not reset — a dismissed finding repeated stays dismissed, which is
what dismissing it meant.

**Legacy rows are not migrated.** Findings filed before this change hold a blob in `summary` and
null in the new columns. No content migration guesses at where the seams were; the card clamps the
headline instead (below), so an old row reads as a slightly tall card rather than a lie about its
own structure.

`findingJobRequest` and `blueprintTicketFields` keep their `summary.split('\n')[0]` title
derivation — legacy rows still need it — and both append `where` and `detail` to the prompt and
ticket body under their own labels. That is provenance the promoted agent needs and the operator
already decided was worth keeping attached.

## The cockpit

`FindingsPanel`:

- **Headline** on its own line, line-clamped to two lines so a legacy blob cannot become a wall,
  and run through `linkify` so an id written into it becomes a link.
- **`where`** as a mono chip on the head line, next to the existing ref chip.
- **`detail`** inside a `<details>`, collapsed, rendered with `renderMarkdown`. That gives fenced
  code blocks for stack traces for free and never interprets HTML — the renderer produces React
  children, so there is no sanitiser in the path to get wrong.

`EscalationCard`: `context.detail` moves from `<pre>` to `renderMarkdown`. `context.recentOutput`
stays `<pre>` — it is terminal output, and preformatted is what it is. `escalate`'s `detail`
argument description gains a line asking for markdown with errors in a fenced block.

## Tests

- `validateFinding` unit tests: each of the three new refusals, and a call carrying all five
  arguments.
- A `buildSystem` test that files a finding through the MCP channel with `where` and `detail` and
  reads both back off the snapshot — the round trip through the new columns.

## Documentation

[13](../../spec/13-jobs-and-findings.md) owns the `Finding` shape, the validation rules and the
dedup rule. [14](../../spec/14-persistence.md) records the two-column migration.
[11](../../spec/11-mcp-tools.md) carries the tool signature. [17](../../spec/17-cockpit.md)
describes the card.
