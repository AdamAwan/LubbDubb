import type {
  FactExit,
  GraduationReading,
  KnowledgeCorroboration,
  KnowledgeFact,
  KnowledgeGraduation,
  WorkNode,
} from '../types.js';

/**
 * Graduation's pure layer: whether a claim may leave this store, what the agent
 * taking it there is told, and what the work graph says became of the attempt
 * (`docs/spec/27-knowledge.md#sending-a-claim-on`).
 *
 * No store and no transport, `src/knowledge/knowledge.ts`'s shape and for its
 * reason — every rule here is one an operator's click rests on, and the reading at
 * the bottom is the one thing in this subsystem that takes a claim out of every
 * prompt without anybody saying so.
 *
 * **Nothing here commits anything.** A documentation pull request is a dispatch a
 * person promotes: an agent that could queue this work could put agents on the
 * fleet, which is the capability escalation the tool channel refuses on every arm.
 * What this module produces is the words that dispatch carries and the verdict on
 * what came back.
 */

/** How long the job's title may be before it stops being a title. */
const MAX_TITLE = 80;

/**
 * The `docs` arm of {@link FactExit}, narrowed out of the union rather than
 * written again — this module composes the prompt for a documentation pull
 * request and nothing else, and a second spelling of the arm would be free to
 * drift from the one the route validates.
 */
type DocsExit = Extract<FactExit, { exit: 'docs' }>;

/**
 * How many of a claim's observations ride the prompt.
 *
 * The evidence is the argument for the claim and the agent is being asked to check
 * it against the code, so it goes — but a fact an operator sat on for a month can
 * carry dozens of near-identical corroborations, and a prompt that grows with the
 * count would be a dispatch priced by how popular the claim was. The oldest are
 * kept rather than the newest: the first observations are the ones that say what
 * the claim was originally about, where the later ones are agreement with words
 * already here.
 */
const MAX_OBSERVATIONS = 6;

/** How much of one observation rides it. The same bound the evidence was stored under. */
const MAX_OBSERVATION_CHARS = 1_000;

/**
 * Whether this claim is one an operator may send out by this exit, and why not
 * when it is not.
 *
 * **The refusals differ per exit, and that is the whole reason this takes one.**
 * The three exits ask different things of a claim, because what they do with it is
 * different: `docs` **asserts** it, in a document that outlives the afternoon;
 * `job` and `ticket` **act on** it, which is a decision about spending a slot
 * rather than a statement that the claim is true.
 *
 * So a `docs` exit refuses two shapes of claim:
 *
 * - **A proposal reaches nobody.** One agent said it and nothing has agreed, so
 *   writing it into the repository through an agent is the auto-promotion this
 *   whole design refuses, arriving through the one door that ends outside the
 *   harness. Rule on it first; `lookup` is one click away and costs nothing.
 * - **A notice is a report on today.** An expiring fact is true until its clock
 *   runs out, and the repository is where things that stay true go. Committing one
 *   would write "this check flaked this afternoon" into a document that outlives
 *   the afternoon by years, and the fact's own lapse would then take the claim out
 *   of prompts it is no longer in while the document went on saying it.
 *
 * A `job` or a `ticket` refuses **neither**, and refusing them would be the
 * regression this merge must not make: a `proposal` is exactly what every finding
 * was, and turning one agent's report into work is precisely what an operator
 * clicking "Queue job" has always been doing. Nothing is asserted by queueing it —
 * the prompt tells the agent to verify the claim first and to stop if it does not
 * hold. A notice is fair game for the same reason pointed at time rather than
 * truth: *doing something about today* is what a job is for.
 *
 * Every exit refuses the terminal reaches, because there is nothing left to send:
 * `graduated` has already gone, and `rejected`, `superseded` and `retired` reach
 * nobody. `retired` is refused for the weakest of the reasons and still refused:
 * it was not judged untrue, but an operator has just said the fleet does not need
 * carrying it, and acting on it in the same breath would spend a slot on the
 * strength of a decision to stop telling anyone.
 */
export function exitableFact(fact: KnowledgeFact, exit: FactExit['exit']): { ok: true } | { ok: false; error: string } {
  if (fact.reach === 'graduated') return { ok: false, error: 'this claim has already left for somewhere else' };
  if (fact.reach === 'rejected' || fact.reach === 'superseded' || fact.reach === 'retired') {
    return { ok: false, error: `this claim is ${fact.reach} — it reaches nobody, and there is nothing to send on` };
  }
  if (exit !== 'docs') return { ok: true };
  if (fact.reach === 'proposal') {
    return {
      ok: false,
      error:
        'one agent said this and nothing has agreed, so it reaches nobody — putting it in the repository ' +
        'would commit a claim no one has vouched for. Rule on it first: “Put on lookup” costs nothing, ' +
        'and queueing a job or filing a ticket for it needs no ruling at all.',
    };
  }
  if (fact.lifetime === 'expiring') {
    return {
      ok: false,
      error:
        'a notice is a report on today and ends by itself; the repository is for what stays true. If what ' +
        'it says has turned out to be permanent, the claim to commit is the standing one that says so — ' +
        'and if something needs doing about it now, that is a job or a ticket rather than a document.',
    };
  }
  return { ok: true };
}

/**
 * What the `docs-change` template is rendered with for a graduating fact.
 *
 * **The same template a promoted `docs` finding renders**, and deliberately not a
 * second one. Everything that template says — check it against the code before you
 * write a word of it, find the document that already owns this, write the fact and
 * not the story of finding it, change documentation and not code, and nothing
 * finishes this but an opened pull request — is exactly as true of a claim two
 * agents corroborated as of one agent's report, and an operator who has overridden
 * it to say where documentation lives in *their* repository has said that once. A
 * second id would be a second copy of that override to keep in step, silently
 * diverging on the deployments that customised most.
 *
 * What graduation adds — the observations, the target, and what happens when the
 * pull request lands — is **appended** by {@link graduationNote} rather than given
 * placeholders, for the reason CLAUDE.md states under "Prompts and templates": an
 * override that never learned about a new `{token}` drops it in silence.
 *
 * `title` is the job's, not the document's: it only has to be recognisable in the
 * Up next queue, while what the documentation ends up saying is the judgement being
 * delegated.
 */
export function factDocsFields(fact: KnowledgeFact): { title: string; vars: Record<string, string> } {
  return {
    title: `Document: ${headline(fact.claim)}`.slice(0, MAX_TITLE),
    vars: {
      // What the claim is *about*, in the terms the store holds it in. A check
      // scope is the provider's own identifier and is said as one, because that is
      // what the agent will find it under in the CI configuration.
      ref: scopePhrase(fact.scope),
      // The claim is the whole report: it is already the sentence the fleet has
      // been reading, written to be read. The observations behind it are appended
      // below rather than folded in here, because they are evidence *for* it and
      // the template's own instruction is to check it rather than transcribe it.
      summary: fact.claim,
      originRef: fact.originRef ?? 'an untracked task',
    },
  };
}

/**
 * What a claim becomes when an operator queues a **job** for it: the title and
 * prompt of that job. Pure, so the wording is testable without a server and the
 * route is left with nothing but `Store.exitFact`.
 *
 * Derived in code rather than rendered from the template book, and that split is
 * the same one it always was. A `docs` exit ends in a documentation change, where
 * *how a change is worded and which document owns it* is exactly the house style an
 * override exists to carry; a job is provenance plus "verify before you act", which
 * has no house style and no opinion to override. Nothing here would be improved by
 * being a `PromptId`, and one more id is one more copy of an override to keep in
 * step.
 *
 * The prompt carries the claim's **provenance** — where it was first seen, how many
 * independent observers say so, and what they saw — because the agent's first
 * question is always "says who, and were they looking at this or at something
 * else?", which is the one thing a PR comment could never be trusted to keep
 * attached. It ends by telling the agent to check the claim before acting on it and
 * to stop rather than invent work, which is what makes queueing a `proposal`
 * safe: nothing here asserts the claim is true.
 */
export function factJobRequest(
  fact: KnowledgeFact,
  observations: readonly KnowledgeCorroboration[],
): { title: string; prompt: string } {
  const about = fact.aboutRef !== null ? ` about ${fact.aboutRef}` : '';
  const title = `${fact.aboutRef !== null ? `${fact.aboutRef} ` : ''}${headline(fact.claim)}`.slice(0, MAX_TITLE);
  const prompt = [
    `An operator turned a claim${about} from the harness's knowledge base into work. It is scoped to ` +
      `${scopePhrase(fact.scope)} and was first seen on ${fact.originRef ?? 'an untracked task'}.`,
    '',
    'The claim, verbatim:',
    '',
    fact.claim,
    ...(fact.where !== null ? ['', `Where: ${fact.where}`] : []),
    '',
    observed(observations),
    '',
    'Verify it before acting on it — it is what the fleet believes, not an established fact. If it turns ' +
      'out not to hold, say so and stop rather than inventing work to justify the dispatch. Raising what ' +
      'you found instead is the useful ending.',
  ].join('\n');
  return { title, prompt };
}

/**
 * The values the `finding-ticket` prompt is rendered with for a claim an operator
 * is filing — pure, for {@link factJobRequest}'s reason.
 *
 * `title` is the **job's**, not the ticket's: the agent writes the ticket's title,
 * which is the judgement being delegated, while this one only has to be
 * recognisable in the Up next queue.
 *
 * **`kind` and `kindHelp` are still supplied, and are the interesting part.** They
 * were a finding's four-word taxonomy, which the unified intake removed and this
 * merge finishes removing — but a placeholder cannot be withdrawn the way a value
 * can. `renderTemplate` leaves an unfilled `{token}` in the prompt verbatim, so an
 * operator override written against the older book would ship a literal `{kind}` to
 * the agent. So the two names stay declared and stay filled, with what is true of
 * every claim now: it is a claim an agent raised. The default body no longer names
 * either. → CLAUDE.md, "Prompts and templates"
 */
export function factTicketFields(
  fact: KnowledgeFact,
  tracker: string,
  observations: readonly KnowledgeCorroboration[],
): { title: string; vars: Record<string, string> } {
  return {
    title: `File ticket: ${headline(fact.claim)}`.slice(0, MAX_TITLE),
    vars: {
      kind: 'claim',
      kindHelp: 'something an agent raised about working this repository',
      ref: fact.aboutRef ?? 'nothing the harness tracks',
      // The claim and what was seen, through the one placeholder every override
      // already renders — never a new `{token}`, which an override that never
      // learned about it would drop in silence.
      summary: [fact.claim, fact.where !== null ? `\nWhere: ${fact.where}` : '', `\n\n${observed(observations)}`]
        .join('')
        .trim(),
      originRef: fact.originRef ?? 'an untracked task',
      tracker,
    },
  };
}

/**
 * What the fleet actually saw, as one block both non-`docs` exits carry.
 *
 * Bounded exactly as {@link graduationNote}'s list is and for its reason: a claim
 * an operator sat on for a month carries dozens of near-identical observations, and
 * a prompt that grew with the count would be a dispatch priced by how popular the
 * claim was.
 */
function observed(observations: readonly KnowledgeCorroboration[]): string {
  if (observations.length === 0) return 'Nothing was recorded about how it was observed.';
  const seen = observations.slice(0, MAX_OBSERVATIONS).map((row) => {
    const where = row.goalRef !== null ? ` (seen on ${row.goalRef})` : '';
    return `- ${row.words.slice(0, MAX_OBSERVATION_CHARS)}${where}`;
  });
  const more = observations.length - seen.length;
  return [
    `${observations.length === 1 ? 'One observation was' : `${observations.length} observations were`} recorded against it. What they saw, in their own words:`,
    '',
    ...seen,
    ...(more > 0 ? ['', `(${more} further ${more === 1 ? 'observation' : 'observations'} said much the same.)`] : []),
  ].join('\n');
}

/**
 * What is appended to the rendered `docs-change` prompt: that this is a
 * graduation, what was actually seen, and where the operator says it belongs.
 *
 * **Where it goes is the half a mistake is silent in.** `docs/README.md` says
 * which document owns what, so the `spec` arm can leave the choice to the agent
 * and say only that CLAUDE.md is not it. The `claudeMd` arm carries the operator's
 * own statement of what breaks silently without the claim — and tells the agent to
 * check that statement like any other claim, because CLAUDE.md's length is
 * asserted rather than intended and a line that does not meet the bar is paid for
 * on every dispatch, forever, with nothing red.
 */
export function graduationNote(
  fact: KnowledgeFact,
  commitment: DocsExit,
  observations: readonly KnowledgeCorroboration[],
): string {
  const seen = observations.slice(0, MAX_OBSERVATIONS).map((row) => {
    const where = row.goalRef !== null ? ` (seen on ${row.goalRef})` : '';
    return `- ${row.words.slice(0, MAX_OBSERVATION_CHARS)}${where}`;
  });
  const more = observations.length - seen.length;
  return [
    '## This came from the fleet, not from one agent',
    '',
    'It is a claim in the harness’s knowledge base: agents wrote it down, it was corroborated, and an ' +
      'operator has decided it belongs in the repository instead. Committing it is not a formality — while ' +
      'it lives in the knowledge base it is injected into prompts, and when the pull request you open is ' +
      'merged the claim leaves every prompt for good, because from then on an agent reads it here. So what ' +
      'the document ends up saying has to carry the whole of it: a thinner sentence than the one below is a ' +
      'net loss, not a tidy-up.',
    '',
    `It is scoped to ${scopePhrase(fact.scope)}, and ${observations.length === 1 ? 'one agent has' : `${observations.length} observations have`} been recorded against it. What they saw, in their own words:`,
    '',
    ...seen,
    ...(more > 0 ? ['', `(${more} further ${more === 1 ? 'observation' : 'observations'} said much the same.)`] : []),
    '',
    '## Where it goes',
    '',
    ...(commitment.target === 'spec'
      ? [
          'The document that already owns this subject. If the repository states a rule about which document ' +
            'owns what, that rule decides — read it first and follow it.',
          '',
          '**Not CLAUDE.md, or whatever this repository loads into every agent on every dispatch.** That file ' +
            'is paid for on every single run, so it takes only what an operator has explicitly said meets its ' +
            'bar, and nobody has said that here. If you finish convinced it belongs there instead, say so in ' +
            'the pull request and put it in the owning document anyway — that is a decision for whoever ' +
            'merges this, not one to take on the way past.',
        ]
      : [
          'CLAUDE.md — the file this repository loads into every agent’s context on every dispatch. The ' +
            'operator has said it meets that file’s bar, and their reason is:',
          '',
          `> ${commitment.bar.replace(/\n+/g, ' ')}`,
          '',
          '**Check that reading the way you are checking the claim.** The bar is that not knowing the fact ' +
            'gets something broken *silently* — no error, nothing the repository’s own checks catch, ' +
            'nothing obvious at the call site. If the failure is loud, or a check catches it, the claim ' +
            'belongs in the document that owns the subject instead: put it there, and say in the pull ' +
            'request why you moved it. That file’s length is asserted rather than intended, so a line ' +
            'that does not meet the bar costs every dispatch from now on and nothing ever goes red about it.',
        ]),
  ].join('\n');
}

/**
 * What became of a graduation, read from the work graph.
 *
 * **Swept, never hooked**, which is spec 24's argument
 * (`docs/spec/24-environments.md#recording-a-landing`) and holds here for a
 * stronger version of its reason: a hook on the merge loses the landing to any
 * restart that straddles it, and what is lost is not a number in a report — it is
 * a claim that goes on being injected into every prompt forever, which is the exact
 * cost this whole subsystem exists to cap.
 *
 * It takes its **own** reading rather than reusing `EnvironmentArrivalDesk`'s.
 * That desk answers "has this commit reached this environment", which needs the
 * merge SHA — a provider fact with a `closedPrWindowMs` shelf life that a squash
 * leaves no ancestry link to. A graduation needs no commit at all: it needs only
 * what became of one pull request, and the work graph holds that durably, because
 * it is upsert-only and keeps a merged PR long after `closedPullRequests` has
 * forgotten it. Reading the graph rather than the world is what makes this sweep
 * survive a restart that straddles the merge.
 *
 * **`unknown` is a verdict and is never folded into either of the others.** A PR
 * node the graph marks merged with `provenance: 'inferred'` is one that vanished
 * from the world without ever being seen closed — absence-means-merged, which is a
 * sane default for a lens and is not one here: acting on it takes a claim out of
 * every prompt for a pull request that may have been closed unmerged while nothing
 * was watching. The three-verdict discipline is
 * `docs/spec/24-environments.md#the-three-verdicts`', and the answer to `unknown`
 * is the operator, who is shown it.
 */
export function graduationReading(graduation: KnowledgeGraduation, nodes: readonly WorkNode[]): GraduationReading {
  if (graduation.outcome !== null) return graduation.outcome;
  const jobRef = `job:${graduation.jobId}`;
  // The job's **direct** pull-request children, which is what the fold's branch
  // match produces. Not the whole subtree: a pull request adopted further down
  // belongs to some other piece of work, and a graduation is about the one this job
  // opened.
  const prs = nodes.filter((n) => n.kind === 'pr' && n.parentRef === jobRef);
  if (prs.length === 0) {
    // No pull request, and the job will never produce one. Anything else — queued,
    // dispatched, an agent still working — is simply not finished yet, and a
    // documentation job that ends without opening a pull request stays `waiting`
    // rather than being called abandoned on a guess: the template says an unopened
    // pull request means nothing happened, and the operator is the one who decides
    // whether to try again.
    return nodes.some((n) => n.ref === jobRef && n.status === 'cancelled') ? 'abandoned' : 'waiting';
  }
  const verdicts = prs.map(prVerdict);
  if (verdicts.includes('landed')) return 'landed';
  if (verdicts.includes('waiting')) return 'waiting';
  if (verdicts.includes('unknown')) return 'unknown';
  return 'abandoned';
}

function prVerdict(node: WorkNode): GraduationReading {
  if (node.status === 'merged') return node.provenance === 'observed' ? 'landed' : 'unknown';
  return node.terminal ? 'abandoned' : 'waiting';
}

/** The scope said as a phrase a sentence can contain — never parsed back. */
function scopePhrase(scope: KnowledgeFact['scope']): string {
  if (scope === 'fleet') return 'working this repository at all';
  if (scope.startsWith('goal:')) return scope.slice('goal:'.length);
  return `the check \`${scope.slice('check:'.length)}\``;
}

/** The one line a job is titled by — the claim's first line, however long the claim runs. */
function headline(claim: string): string {
  return claim.split('\n')[0]?.trim() ?? claim;
}
