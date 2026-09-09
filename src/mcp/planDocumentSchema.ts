import { z } from 'zod';

// → docs/spec/11-mcp-tools.md

export const PLAN_DOCUMENT_SHAPE = {
  diagnosis: z
    .string()
    .describe(
      'What is actually wrong, in the code — the root cause you found, not a restatement of the ' +
        'issue. A quick overview, not the argument: markdown bullets, one plain-English point each, four ' +
        'or five at most, and no file paths or line numbers — name the code in words and put the citations ' +
        'in "evidence", which is drawn beside this. The full reasoning goes in "document". Omit only when ' +
        'the work is not a defect and there is nothing to diagnose.',
    )
    .optional(),
  approach: z
    .string()
    .describe(
      'What you are going to do about it, as two or three markdown bullets — one plain-English point ' +
        'per move you are making, and no file paths. This is the summary the operator approves on, so ' +
        'write the fix, not the shape of the pull requests.',
    )
    .optional(),
  reason: z.string().describe('Why this shape — one or two sentences. Not the fix; the split.'),
  risks: z
    .string()
    .describe(
      'What could go wrong with this split — one or two short sentences, or a couple of brief bullets. ' +
        'It is drawn as a tick box the operator must read before they may approve, so keep it to what ' +
        'would change a mind.',
    )
    .optional(),
  outOfScope: z.string().describe('What you deliberately left out, and why.').optional(),
  alternatives: z
    .string()
    .describe(
      'What you considered and rejected, and why each was rejected. Name real options you weighed, ' +
        'not strawmen — this is the field an operator reads to decide whether you looked around before ' +
        'you chose. An approach with no alternatives is one nobody can disagree with usefully.',
    )
    .optional(),
  openQuestions: z
    .string()
    .describe(
      'What you are least sure about: the assumption you would most like argued with, and what would ' +
        'change your mind. This is the agenda if the operator opens a discussion, so be specific about ' +
        'the decision rather than modest about the plan. One or two short sentences — it is drawn as a ' +
        'tick box on the approval card, and the write-up is where the long version belongs.',
    )
    .optional(),
  verification: z
    .string()
    .describe(
      'How anyone will know the whole thing worked, once every part has landed, as markdown bullets — ' +
        'one plain-English point per thing that has to be true, and no file paths. Not per part — that is ' +
        '"acceptance" — and not the test suite unless the test suite genuinely settles it.',
    )
    .optional(),
  evidence: z
    .array(
      z.object({
        path: z.string().describe('Repository-relative path.'),
        line: z.number().describe('Optional. Omit when the claim is about the file.').optional(),
        note: z.string().describe('What the reader is meant to see there.').optional(),
      }),
    )
    .describe(
      'Where in the code the diagnosis comes from. Cite the places you actually read; a root cause with ' +
        'no citation cannot be checked, and a reader who cannot check it has to take it on trust.',
    )
    .optional(),
  document: z
    .string()
    .describe(
      'The full write-up in markdown — the version a human reads before approving. The fields above are ' +
        'the summary; this is the argument. Do not repeat them: cover how you got to the diagnosis, what ' +
        'the code actually looked like, and what a reviewer of the finished work should check.',
    )
    .optional(),
  parts: z
    .array(
      z.object({
        slug: z.string().describe('Stable lowercase kebab-case id. Keep it identical across a replan.'),
        title: z.string(),
        scope: z.string().describe('The files or areas this part owns, in a sentence.'),
        touches: z
          .array(z.string())
          .describe(
            'The same ownership claim as repository paths — a directory or a file per entry. What this ' +
              'part is allowed to write. Declare it even when "scope" already says so in prose: this is ' +
              'the form that gets compared to what the part actually wrote.',
          )
          .optional(),
        size: z
          .enum(['s', 'm', 'l'])
          .describe(
            'How big this part is to *review*, not how long it takes. Three parts is not a cost; three ' +
              'large ones is, and that is the thing an operator is agreeing to.',
          )
          .optional(),
        dependsOn: z
          .array(z.string())
          .describe(
            'Sibling slugs this part needs first. One means it stacks on that part and starts once ' +
              'that part has pushed. Several means the lanes rejoin: it starts only once all of them ' +
              'have merged, and is cut from the integration branch.',
          )
          .optional(),
        rationale: z.string().describe('Why this is its own PR rather than folded into a sibling.').optional(),
        acceptance: z.string().describe('What makes this part done.').optional(),
        coverage: z
          .string()
          .describe(
            'Only on a part whose job is to add or amend the end-to-end browser suite: the area it ' +
              'covers, in words rather than as a file path. Declare it only where the planning prompt ' +
              'told you this deployment has a suite, and only where the bar it states is met.',
          )
          .optional(),
      }),
    )
    .describe('The parts, in order. At least one is required — one part is a plan, not a special case.'),
  validation: z
    .object({
      resources: z
        .array(
          z.object({
            name: z.string().describe('A file name, not a path.'),
            kind: z.enum(['fixture', 'access', 'reference', 'data']).optional(),
            note: z.string().describe('What it is, and what a check does with it.').optional(),
            provided: z.boolean().describe('False is "I need this and cannot produce it".').optional(),
          }),
        )
        .describe(
          'Things a check needs that are not in the repository: a seeded fixture, a reference screenshot, ' +
            'an account. Name them; never write paths. "provided": false says you need something you cannot ' +
            'produce, and files an ask for it.',
        )
        .optional(),
      checks: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key on a replan.'),
            title: z.string().describe('One line, the headline.'),
            do: z.string().describe('The procedure, in markdown, for somebody who has not read your plan.'),
            expect: z.string().describe('What a pass looks like. A check that cannot say this is not a check.'),
            uses: z
              .array(z.string())
              .describe('Names of resources declared above that this check needs. Names, never paths.')
              .optional(),
            covers: z
              .array(z.string())
              .describe(
                'Part slugs this check exercises, so the sheet can show which parts nothing checks. ' +
                  'Validation is per goal, so a check spanning several parts is normal.',
              )
              .optional(),
            fleetCandidate: z
              .boolean()
              .describe(
                'Your nomination that an agent could run this rather than a person. A suggestion for ' +
                  'whoever decides — it dispatches nothing.',
              )
              .optional(),
            why: z.string().describe('Why an agent could run it. Kept only with the nomination.').optional(),
          }),
        )
        .describe(
          'The checks themselves. Who runs each one is not yours to say — the fleet has no browser, no ' +
            'interactive login and no account on whatever environment this deployment tests against, and you ' +
            'cannot know that from the repository. A check carrying an "actor" is refused.',
        )
        .optional(),
    })
    .describe(
      'How anyone checks the goal was met, as steps rather than as a paragraph — "verification" is the ' +
        'sentence, this is the procedure. Declare it whenever there is something a person or an agent could ' +
        'actually run against the delivered goal, whatever its size: a one-part plan needs validating as much ' +
        'as a decomposed one.',
    )
    .optional(),
  watch: z
    .object({
      signals: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key on a replan.'),
            title: z.string().describe('One line, the headline.'),
            query: z
              .string()
              .describe(
                "The query itself, in whatever language this deployment's telemetry answers. It is handed to " +
                  "the operator's command as a value, never pasted into a shell. It returns **one row per " +
                  'occurrence** and the harness counts the rows: do not aggregate it. A query ending in a ' +
                  'count answers one row whatever the number is, which reads as one occurrence for ever, and ' +
                  'is refused.',
              ),
            presence: z
              .string()
              .describe(
                'A second query whose only job is to prove the code path is running at all. Required, and it ' +
                  'is the whole design: a query naming an operation that does not exist returns zero rows, and ' +
                  'zero rows is indistinguishable from a healthy release. Without this the harness would report ' +
                  'your fix verified on the strength of a typo. It returns rows too, and for that reason must ' +
                  'not aggregate: a count can never answer zero, so an aggregated presence query proves ' +
                  'nothing and is refused.',
              ),
            tolerate: z
              .number()
              .describe(
                'How many rows the query may answer before this reads as a regression. The harness does the ' +
                  'counting — your query returns the occurrences. Almost always 0: the thing should not be ' +
                  'happening at all.',
              )
              .optional(),
            why: z.string().describe('Why this is the right question to ask after it ships.').optional(),
          }),
        )
        .describe(
          'Things that should not be happening: exceptions, failures, retries, a log line only written when ' +
            'something has gone wrong. Each query returns the matching rows themselves and the harness counts ' +
            'them against "tolerate".',
        )
        .optional(),
    })
    .describe(
      'What a running system would have to show, once this is deployed, for the work to have done what it ' +
        'claimed. The layer above "validation": that asks whether the goal was met, this asks whether the thing ' +
        'is behaving now that it is there. Declare it when there is something running you could observe — and ' +
        'for a defect it is knowable now, because the bug report is the signal: "job X keeps timing out" is ' +
        'its own post-deploy check. Declaring nothing is a legitimate answer for a refactor, a docs change or a ' +
        'build fix, and is not the same as declaring everything is fine. Each query is run once against the ' +
        'environment the moment you submit, and you get told what it answered.',
    )
    .optional(),
  state: z
    .object({
      queries: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key on a replan.'),
            title: z.string().describe('One line: what being wrong here would look like.'),
            query: z
              .string()
              .describe(
                'The query itself, in whatever language the deployed store answers. It is handed to the ' +
                  "operator's command as a value, never pasted into a shell, and it must be read-only. It " +
                  'returns the matching **rows themselves** and the harness counts them: do not aggregate it. ' +
                  'A query ending in a count answers one row whatever the number is, which defeats every guard ' +
                  'the contract has, and is refused.',
              ),
            presence: z
              .string()
              .describe(
                'A second query whose only job is to prove this store holds the thing at all. Required, and ' +
                  'it is the whole design: a query naming a column that is not there answers zero rows, and ' +
                  'zero rows is indistinguishable from a healthy release. It returns rows too, and for that ' +
                  'reason must not aggregate: a count can never answer zero.',
              ),
            why: z
              .string()
              .describe('Why this is the question that matters, and what a wrong answer means.')
              .optional(),
          }),
        )
        .describe('One question each about the data this change writes.')
        .optional(),
    })
    .describe(
      "Questions about the *data* the change writes, asked of a real environment's own store once the work " +
        'is deployed there. Seed one only where the shape is obvious from the repository as it stands — the ' +
        'agent that does the work knows which table took the new column and which row the change writes, and ' +
        'you reading the code before it exists mostly cannot. Declaring nothing here is the normal answer. ' +
        'Nothing runs until an operator has read the query and accepted it against a named environment.',
    )
    .optional(),
};
