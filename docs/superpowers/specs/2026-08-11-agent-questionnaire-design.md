# Let an agent ask several questions at once

## The problem

An escalation carries one `question`, one flat `options[]` and one markdown `detail` blob. An agent
with three things to settle has nowhere to put them: it writes all three into `detail` and spends
`options[]` on a "which one do you want to talk about first?" router. The operator gets three
questions and one answer box, and the panel row grows to the height of an essay.

## The shape

An ask gains an optional list of questions. The top-level `question` stays what it always was — the
headline, the thing the panel row shows — and `questions[]` is the questionnaire behind it.

"Needs you" does not unpack the list. The card gains a count chip and one button, **Answer N
questions →**, which opens a modal holding one card per question. Each question card carries its own
detail, its own option chips and its own text box; chips _fill_ the box rather than being the answer,
so "that one, but…" still works. One **Send answers** returns everything at once, as a single reply
typed into the parked session — the same route an answer takes today.

A question left blank is sent as an explicit non-answer rather than omitted, so the agent knows not
to wait on it.

## Data

```ts
interface AgentAskQuestion {
  question: string;
  detail?: string;
  options?: string[];
}
```

`AgentAsk.questions?: AgentAskQuestion[]` and `EscalationContext.questions?: AgentAskQuestion[]`.
`context` is a JSON column, so this needs no `ALTER TABLE` and no `ColumnMigrations` entry.

`Escalation.response` stays a string: the formatted reply the agent received. Structured answers are
not persisted — the reply is the record of what was said, and nothing branches on the parts.

## Components

- **`escalate` MCP tool** — gains `questions`, capped at 10 entries. Each entry is filtered as
  defensively as `options` is today: a non-string `question` drops the entry, non-string `options`
  members are dropped. An ask with no `questions` behaves exactly as it does now.
- **`src/system.ts`** — one more spread beside `options` and `detail` where the `waiting` listener
  builds the escalation context.
- **`src/escalation/questionnaire.ts`** — a pure `formatAnswers(questions, answers)` producing the
  numbered reply. Lives beside the domain rule it encodes (how an agent reads the answer), not in the
  route and not in the cockpit, so a second client formats identically.
- **`POST /api/escalations/:id/answer`** — the body becomes a union: `{ response }` as today, or
  `{ answers: (string | null)[] }` positional against `context.questions`. The `answers` arm is
  refused with a 400 when the escalation carries no questions or the lengths disagree, and when every
  answer is blank. Everything downstream — the proposal/permission/orphan guards, `escalations.answer`,
  dismissal, recovery — is untouched, because it still receives one string.
- **`web/src/components/QuestionnaireModal.tsx`** — follows `PlanModal`. Shared component, so it
  styles itself through the tokens in `styles.css` only; neither skin gains markup.
- **`EscalationCard`** — when `context.questions` is present: count chip, the open button, and the
  inline answer box suppressed. Otherwise unchanged.

## Flow

```
escalate({question, questions:[…]})
  → agents.ask → handleWaiting → 'waiting' event carrying `ask`
  → system.ts listener → escalations.create({context:{…, questions}})
  → cockpit: card shows "Answer 3 questions →" → modal
  → POST /answer {answers:[…]} → formatAnswers → escalations.answer(id, text)
  → agents.respond types the one reply into the session
```

## Errors

`formatAnswers` is total: it never throws, and an all-blank answer set is caught at the route as a
400 rather than typing a reply that says nothing into a live session. A malformed `questions` entry
from an agent is dropped at the tool rather than rejected — an agent that mis-shapes one question
should still get the other two asked, and the tool's return value already reports what happened.

## Testing

- Unit: `formatAnswers` over blank entries, an option-shaped answer, and a multi-line answer.
- Unit: the route's `answers` arm — length mismatch, no questions on the escalation, all blank.
- `buildSystem`: an agent calls `escalate` with `questions`, the created escalation's context carries
  them, `POST /answer` with `answers` puts the formatted reply into the fake session and settles the
  item.

## Not doing

- **Per-question answer types** (single-choice, yes/no, multi-select). One enum to keep in sync
  across the tool, wire type and two clients, buying what an editable box already does.
- **Per-question send.** The agent resumes once, with everything.
- **Blocking Send until all are answered.** A question the operator wants to think about should not
  hold the other two hostage.
