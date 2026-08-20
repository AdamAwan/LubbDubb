/**
 * The plan document, as JSON Schema — the one copy, shared by both channels.
 *
 * `plan_submit` (the fleet's, `tools/planSubmit.ts`) and `plan_amend` (the
 * operator's, `desktopTools.ts`) accept the *same document*: they differ in who
 * may write one and what settles afterwards, never in what a plan is. A second
 * copy of this literal is the drift the repo's conventions exist to prevent —
 * a field described one way to a planner and another way to a desktop session,
 * with `validatePlanDocument` behind both and nothing red.
 *
 * Kept out of `tools/` because it belongs to neither channel; `desktopTools.ts`
 * deliberately never reaches `tools.ts`, and this is what lets the two share a
 * schema without sharing a tool set.
 */
export const PLAN_DOCUMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    diagnosis: {
      type: 'string',
      description:
        'What is actually wrong, in the code — the root cause you found, not a restatement of the ' +
        'issue. Omit only when the work is not a defect and there is nothing to diagnose.',
    },
    approach: {
      type: 'string',
      description:
        'What you are going to do about it, in two or three sentences. This is the summary the ' +
        'operator approves on, so write the fix, not the shape of the pull requests.',
    },
    reason: { type: 'string', description: 'Why this shape — one or two sentences. Not the fix; the split.' },
    risks: { type: 'string', description: 'What could go wrong with this split.' },
    outOfScope: { type: 'string', description: 'What you deliberately left out, and why.' },
    alternatives: {
      type: 'string',
      description:
        'What you considered and rejected, and why each was rejected. Name real options you weighed, ' +
        'not strawmen — this is the field an operator reads to decide whether you looked around before ' +
        'you chose. An approach with no alternatives is one nobody can disagree with usefully.',
    },
    openQuestions: {
      type: 'string',
      description:
        'What you are least sure about: the assumption you would most like argued with, and what would ' +
        'change your mind. This is the agenda if the operator opens a discussion, so be specific about ' +
        'the decision rather than modest about the plan.',
    },
    verification: {
      type: 'string',
      description:
        'How anyone will know the whole thing worked, once every part has landed. Not per part — that is ' +
        '"acceptance" — and not the test suite unless the test suite genuinely settles it.',
    },
    evidence: {
      type: 'array',
      description:
        'Where in the code the diagnosis comes from. Cite the places you actually read; a root cause with ' +
        'no citation cannot be checked, and a reader who cannot check it has to take it on trust.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path.' },
          line: { type: 'number', description: 'Optional. Omit when the claim is about the file.' },
          note: { type: 'string', description: 'What the reader is meant to see there.' },
        },
        required: ['path'],
      },
    },
    document: {
      type: 'string',
      description:
        'The full write-up in markdown — the version a human reads before approving. The fields above are ' +
        'the summary; this is the argument. Do not repeat them: cover how you got to the diagnosis, what ' +
        'the code actually looked like, and what a reviewer of the finished work should check.',
    },
    parts: {
      type: 'array',
      description: 'The parts, in order. At least one is required — one part is a plan, not a special case.',
      items: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Stable lowercase kebab-case id. Keep it identical across a replan.',
          },
          title: { type: 'string' },
          scope: { type: 'string', description: 'The files or areas this part owns, in a sentence.' },
          touches: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The same ownership claim as repository paths — a directory or a file per entry. What this ' +
              'part is allowed to write. Declare it even when "scope" already says so in prose: this is ' +
              'the form that gets compared to what the part actually wrote.',
          },
          size: {
            type: 'string',
            enum: ['s', 'm', 'l'],
            description:
              'How big this part is to *review*, not how long it takes. Three parts is not a cost; three ' +
              'large ones is, and that is the thing an operator is agreeing to.',
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Sibling slugs this part needs first. One means it stacks on that part and starts once ' +
              'that part has pushed. Several means the lanes rejoin: it starts only once all of them ' +
              'have merged, and is cut from the integration branch.',
          },
          rationale: { type: 'string', description: 'Why this is its own PR rather than folded into a sibling.' },
          acceptance: { type: 'string', description: 'What makes this part done.' },
        },
        required: ['slug', 'title', 'scope'],
      },
    },
    validation: {
      type: 'object',
      description:
        'How anyone checks the goal was met, as steps rather than as a paragraph — "verification" is the ' +
        'sentence, this is the procedure. Declare it whenever there is something a person or an agent could ' +
        'actually run against the delivered goal, whatever its size: a one-part plan needs validating as much ' +
        'as a decomposed one.',
      properties: {
        resources: {
          type: 'array',
          description:
            'Things a check needs that are not in the repository: a seeded fixture, a reference screenshot, ' +
            'an account. Name them; never write paths. "provided": false says you need something you cannot ' +
            'produce, and files an ask for it.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'A file name, not a path.' },
              kind: { type: 'string', enum: ['fixture', 'access', 'reference', 'data'] },
              note: { type: 'string', description: 'What it is, and what a check does with it.' },
              provided: { type: 'boolean', description: 'False is "I need this and cannot produce it".' },
            },
            required: ['name'],
          },
        },
        checks: {
          type: 'array',
          description:
            'The checks themselves. Who runs each one is not yours to say — the fleet has no browser, no ' +
            'interactive login and no account on whatever environment this deployment tests against, and you ' +
            'cannot know that from the repository. A check carrying an "actor" is refused.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable lowercase kebab-case id, and the merge key on a replan.' },
              title: { type: 'string', description: 'One line, the headline.' },
              do: {
                type: 'string',
                description: 'The procedure, in markdown, for somebody who has not read your plan.',
              },
              expect: {
                type: 'string',
                description: 'What a pass looks like. A check that cannot say this is not a check.',
              },
              uses: {
                type: 'array',
                items: { type: 'string' },
                description: 'Names of resources declared above that this check needs. Names, never paths.',
              },
              covers: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Part slugs this check exercises, so the sheet can show which parts nothing checks. ' +
                  'Validation is per goal, so a check spanning several parts is normal.',
              },
              fleetCandidate: {
                type: 'boolean',
                description:
                  'Your nomination that an agent could run this rather than a person. A suggestion for ' +
                  'whoever decides — it dispatches nothing.',
              },
              why: { type: 'string', description: 'Why an agent could run it. Kept only with the nomination.' },
            },
            required: ['id', 'title', 'do', 'expect'],
          },
        },
      },
    },
  },
  required: ['parts', 'reason'],
};
