# An escalation an operator can read

## The problem

A `resolve_ambiguity` card on the stamp desk arrives as one 300-word paragraph. The operator's own
report: "this is still impossible to really read."

It is three faults stacked, and only the middle one is typography.

**The harness wrote a blob.** Rule `issue-shortfall` builds one `prompt` string — a lede sentence,
then the assessor's entire verbatim summary quoted inside it. The card has a home for long quoted
text, `context.detail`, rendered as markdown; the rule does not use it. This is the failure the
[findings design](2026-08-10-agent-message-readability-design.md) named — "one lump, because nothing
ever asked for parts" — reappearing with the harness as the author rather than an agent. That design
fixed the two surfaces where an *agent* writes; nothing was said about the ones where a dispatcher
rule does.

**The renderer flattens what structure there is.** `.escalation-prompt` is `white-space: normal`, so
the paragraph breaks a prompt does contain collapse into single spaces. `plan-approval` and
`wedgedPlanPrompt` both write well-shaped multi-paragraph prose and both arrive as one run-on. There
is no measure cap either: the card is 1130px wide, about 150 characters a line.

**The assessor wrote a paragraph.** `assess_issue`'s `summary` asks for "what you found, and on what
evidence" with no shape and a 2000-character cap. The real one under review reached for structure
anyway — `PRESENT: … MISSING: … REMAINING (human, live ADO): … WHY 'goal': …` — and had nowhere to
put it, so the sections became inline capitals in a single run.

Fixing only the renderer makes a well-written escalation prettier and does nothing for the one that
hurts. Fixing only the authoring leaves the paragraph breaks still being eaten. Both ends move.

## The rule underneath

**`prompt` is the harness speaking to the operator. `context.detail` is text the harness is quoting
from an agent.**

The distinction already exists in the data and nothing uses it, which is why an assessor's write-up
ends up inside a sentence the dispatcher wrote. Stating it decides every case below, and it decides
the card's labelling for free: a block the harness quotes can name who it is quoting.

Two mechanisms follow, doing two different jobs. The **field split** moves someone else's text out
of `prompt`. The **paragraph split** gives our own text back the structure the renderer was eating.
Neither subsumes the other.

## The tool contract

`assess_issue` takes the findings shape.

| arg       | required | shape                                                                       |
| --------- | -------- | --------------------------------------------------------------------------- |
| `status`  | yes      | unchanged — `delivered` / `more_work`                                        |
| `summary` | yes      | one line, no newlines, ≤160 characters. The verdict and nothing else.        |
| `detail`  | no       | ≤2000 characters, markdown. What is present, what is missing, on what evidence. |
| `cause`   | no       | unchanged                                                                    |
| `part`    | no       | unchanged                                                                    |

`validateAssessment` grows two refusals, each naming the field the text belongs in:

- a newline in `summary` — "one line; put the evidence in `detail`";
- `summary` over 160 characters — same redirect.

The 2000-character cap moves off `summary` and onto `detail`. **Refusing the newline is the
load-bearing part**, for the reason it was in the findings design: it turns a blob into a tool error
the assessor fixes inside its own turn, rather than something an operator reads hours later.

`detail` is optional. An assessment with nothing to add writes nothing, and a required field would
be padded with "N/A".

## Storage and wire

An assessment lands in `issue_deliveries` (delivered) or `issue_shortfalls` (more_work), so `detail`
is a nullable `TEXT` column on **both**. A `detail` that survived only the negative verdict would be
silently dropped on every `delivered` assessment — invisible, which is the whole failure mode.

Both are existing tables, so both columns are declared in the `ColumnMigrations` of
`src/store/verdicts.ts`. Without those entries the columns are invisible on every database created
before this change and nothing errors.

`IssueDelivery` and `IssueShortfall` gain `detail: string | null`; `src/wire.ts` inherits both
unchanged.

`ShortfallBody` — the operator's HTTP arm of the same verdict — does **not** gain `detail`. An
operator recording a shortfall by hand writes one summary; a field neither the form nor the caller
fills is a column that is always null by a longer route.

**Legacy rows are not migrated.** Assessments recorded before this change hold a blob in `summary`
and null in `detail`. No content migration guesses where the seams were; the card's measure cap and
unfolded body make an old row a tall card rather than a lie about its own structure.

## The authoring sites

Every escalation prompt the operator sees, and what happens to it.

**Quotes an agent — the field split applies:**

- **`issue-shortfall` arm C** (`src/dispatcher/rules/issueShortfall.ts`). The prompt keeps its lede
  and loses the `What the assessor found:\n\n"${shortfall.summary}"` tail; `context.detail` takes
  `shortfall.detail`.
- **The `issue-shortfall` prompt template** (arms A and B, the proposal path). Loses the `{summary}`
  placeholder and the scaffolding that introduced it — the card supplies that label now. The
  `propose_shortfall` action carries `detail` alongside the `summary` it already carries, and
  `actionExecutor` puts it on the escalation's context.
- **`pr-ci-blocked`** (`src/dispatcher/rules/prCiFailing.ts`). One sentence stays in the prompt; the
  list of check names moves to `detail`. Not an agent's words, but the same shape — a lede with a
  variable-length list stapled to it.

**The harness's own prose — the paragraph split applies, and nothing else changes:**

- `plan-approval` and `issue-shortfall`'s remaining body, `wedgedPlanPrompt` (`src/plans/planWedge.ts`).
  Every paragraph is the harness saying what the buttons do. It is not quoted text, it does not move,
  and the operator override contract is untouched.

**Already one-line ledes, unchanged:** `issue-pickup-escalation`, `plan-part-escalation`,
`pr-concern-escalation`.

**Already split:** agent-authored escalations through the `escalate` tool, which has carried
`question` + `detail` since the findings design.

## The cockpit

`EscalationCard`:

- **Headline** — the prompt's first paragraph, at `--text`, measure-capped to ~72ch. Stated as a
  rule rather than left to inherit: the reported card renders its whole body in `--accent`, which at
  300 words is unreadable on its own. The accent's job here is the badge and the border, and the
  card should say so where a later change would otherwise not notice.
- **Body** — the prompt's remaining paragraphs, then `context.detail`. Both open, unfolded, no
  `max-height`, same measure cap. The `<details>` wrapper and the 180px cap come off `detail`
  specifically: a 180px window onto 600px of text is the wall again with a scrollbar. `Bench.tsx`
  already argues this for its stations — "a `<details>` you have to open first is a step between you
  and the job" — and an escalation on the stamp desk is the same situation.
- **Label** — `detail` gets a heading naming its author: *What the assessor found* when the harness
  raised the item, *Detail from the agent* when `escalation.agentId` is set. "Detail from the agent"
  on a card the dispatcher wrote is simply false.
- **`recentOutput` and `draft` are untouched** — `<pre>`, folded, 180px. They are evidence you glance
  at, not the thing you are deciding.

`renderMarkdown` gains an optional `refUrls` argument and linkifies plain-text runs, never inside a
code span or a fence. **Without this the fix causes a regression it was meant to prevent**: the
`#35317` references in the reported card are links today only because they sit in `prompt`, which
goes through `linkify`; moving that text into `detail` would silently turn them into plain text.
`FindingsPanel`'s detail block gets working links from the same change.

## Enforcement, and one refusal deliberately not added

The refusals live at the `assess_issue` tool boundary, where a rejection is a retry inside the
agent's own turn.

**They are not added to the `escalate_to_human` action schema.** `parseActions` *drops* a rejected
action into the audit log, so a rule that wrote a blob would stop escalating altogether — trading an
ugly card for a question that never reaches a person. That is the silent failure the harness is built
to avoid, and it is strictly worse than the bug being fixed.

The harness side is held by tests instead: the prompt builders are pure functions, and a unit test
asserts each produces a single-line lede.

## Tests

- `validateAssessment`: the newline refusal, the length refusal, and a call carrying all five
  arguments.
- A `buildSystem` test filing an assessment with `detail` through the MCP channel and reading it back
  off the snapshot — the round trip through the new columns, for both verdicts.
- Unit tests on the escalation prompt builders: single line, no embedded summary.
- A template test: the three escalation templates render to one line.
- `renderMarkdown`: a ref in prose links; a ref inside a fence does not.
- `test/fixtures/classic-markup.html` regenerates.

## Documentation

[11](../../spec/11-mcp-tools.md) carries the tool signature and its refusals.
[06](../../spec/06-issue-pickup.md) owns the shortfall and delivery rows, so the two-field verdict is
stated there — not [13](../../spec/13-jobs-and-findings.md), which owns findings and never covered
assessments.
[14](../../spec/14-persistence.md) records the two-column migration.
[17](../../spec/17-cockpit.md) describes the card.
[05](../../spec/05-dispatcher.md) states the lede rule for escalation prompts.
