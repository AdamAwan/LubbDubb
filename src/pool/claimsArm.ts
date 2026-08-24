import { claimKey, claimsMatch } from '../claims.js';
import type { Store } from '../store/store.js';
import type { KnowledgeFact, PoolClaim, PoolClaimsDocument, PoolMirroredClaim } from '../types.js';
import { POOL_SCHEMA_VERSION } from './document.js';
import { secretRefusal } from './secrets.js';

/**
 * The claims arm: what leaves this fleet, and what arriving means.
 *
 * Pure over a {@link Store}, with no clock of its own and no transport — the desk
 * owns both. Split from the desk because the two halves are separately testable and
 * separately interesting: what leaves is a set of refusals, and what arrives is one
 * rule about the project name.
 *
 * → `docs/spec/28-cross-fleet-pool.md#the-claims-arm`
 */

/** How many corroborators' words ride with one claim. Evidence, not a transcript. */
const EVIDENCE_ENTRIES = 3;

/**
 * How much of one corroborator's words crosses.
 *
 * Capped because the document is republished whole and cloned by every fleet: an
 * agent's unbounded prose is the one field here with no natural ceiling, and the
 * bound on the digest is only half the argument for keeping the pool small.
 */
const EVIDENCE_CHARS = 400;

/** One claim this fleet declined to publish, and why — drawn on the Knowledge page. */
export interface PoolRefusal {
  factId: string;
  claim: string;
  reason: string;
}

/** What {@link buildClaimsDocument} produced, and what it would not. */
interface ClaimsDerivation {
  document: PoolClaimsDocument;
  /**
   * The claims the secret backstop refused.
   *
   * Carried out rather than merely dropped, because a refusal that is invisible is
   * a claim an operator vouched for that never appears in the pool with nothing
   * saying why — which reads exactly like a pool that is broken.
   */
  refusals: PoolRefusal[];
}

/**
 * This fleet's claims document, derived whole from the store.
 *
 * Whole every time, and that is the property everything else in this design rests
 * on: re-deriving the document is always correct, which is why a failed publish
 * needs no queue, why a lost dirty flag self-heals, why a withdrawal needs no
 * tombstone, and why an hourly cadence costs a hash rather than a commit.
 */
export function buildClaimsDocument(
  store: Store,
  context: { fleetId: string; project: string; harnessVersion: string; now: string },
): ClaimsDerivation {
  const refusals: PoolRefusal[] = [];
  const claims: PoolClaim[] = [];
  for (const fact of store.listPublishableFacts()) {
    const evidence = store
      .listCorroborations(fact.id)
      // The **local** voices only. A pooled corroboration is another fleet's words
      // about their own claim, and republishing it would have this fleet vouching
      // for evidence it never saw — and, two hops on, would carry one fleet's
      // sentence back to itself as independent agreement.
      .filter((c) => c.fleetId === null)
      .map((c) => c.words.slice(0, EVIDENCE_CHARS))
      .slice(-EVIDENCE_ENTRIES);
    const counts = store.factCounts().get(fact.id);
    const refusal = secretRefusal([fact.claim, fact.where ?? '', ...evidence].join('\n'));
    if (refusal !== null) {
      refusals.push({ factId: fact.id, claim: fact.claim, reason: refusal });
      continue;
    }
    claims.push({
      id: fact.id,
      claim: fact.claim,
      where: fact.where,
      // `ruledAt` is not null on anything `listPublishableFacts` returns — that is
      // the vouch, and the whole gate. The fallback is the type's, not a case.
      vouchedAt: fact.ruledAt ?? fact.updatedAt,
      corroborations: counts?.corroborations ?? 0,
      disputes: counts?.contradictions ?? 0,
      evidence,
    });
  }
  return {
    document: {
      pool: POOL_SCHEMA_VERSION,
      kind: 'claims',
      fleetId: context.fleetId,
      project: context.project,
      publishedAt: context.now,
      harnessVersion: context.harnessVersion,
      claims,
    },
    refusals,
  };
}

/** What importing one fleet's document did, per claim. */
export interface ClaimArrival extends PoolMirroredClaim {
  /** `corroborated` joined a standing local claim; `proposed` filed one; `held` reached the mirror only. */
  outcome: 'corroborated' | 'proposed' | 'held' | 'barred';
}

/**
 * Land one fleet's claims locally.
 *
 * An arriving claim is proposed through **the same path an agent's claim takes**,
 * so `claimsMatch` decides whether it is a new proposal or agreement with something
 * this fleet already believes, and nothing has to know which in advance.
 *
 * **It lands with exactly one corroboration, attributed to the origin fleet — never
 * the origin's count.** A fleet arriving with five corroborations would arrive
 * already past `lookup`, which is auto-promotion crossing a machine boundary: the
 * one transition reserved for a clock or an operator. The origin's counts ride as
 * provenance drawn on the row, in the class that is a reading and never a trigger.
 *
 * The project name decides exactly one thing, and it is **not** whether a matching
 * arrival corroborates:
 *
 * | Arrival           | Matches a standing local claim | Matches nothing local                  |
 * | ----------------- | ------------------------------ | -------------------------------------- |
 * | Same project      | corroborates                   | proposed locally, awaiting a ruling    |
 * | Different project | **corroborates**               | held in the mirror; proposed to nobody |
 *
 * Different project is self-selecting, and that asymmetry is the design: a claim
 * about your project's lint configuration never reaches a fleet on another project,
 * because no agent there will ever say that sentence — while a claim about the
 * toolchain crosses the moment the receiving fleet's own agent hits it, arriving as
 * the corroboration that carries their own proposal to `lookup`.
 * → `docs/spec/28-cross-fleet-pool.md#the-rule-the-name-decides`
 */
export function importClaims(
  store: Store,
  document: PoolClaimsDocument,
  context: { project: string | null; now: string },
): ClaimArrival[] {
  // One read of the local claims for the whole document, rather than one per
  // arrival: `listFacts` is capped and this is on the pulse.
  const local = store.listFacts(POOL_MATCH_SCAN);
  const arrivals: ClaimArrival[] = [];
  for (const claim of document.claims) {
    const matched = matchingLocalFact(local, claim.claim);
    const sameProject = context.project !== null && context.project === document.project;
    const mirrored: PoolMirroredClaim = {
      ...claim,
      fleetId: document.fleetId,
      project: document.project,
      localFactId: null,
      publishedAt: document.publishedAt,
      seenAt: context.now,
    };
    if (matched === null && !sameProject) {
      // Held in the mirror and proposed to nobody. Proposing everything to everybody
      // is the alternative, and it is a triage page nobody opens — which is worth
      // less than nothing.
      arrivals.push({ ...mirrored, outcome: 'held' });
      continue;
    }
    const outcome = store.proposeFact(
      {
        claim: claim.claim,
        // Everything published stands and everything published is fleet-scoped —
        // the three refusals on the way out are what make that true, so nothing
        // here has to reconstruct a scope or a clock the document does not carry.
        scope: 'fleet',
        lifetime: 'standing',
        expiresInHours: null,
        // The origin's own words, which is what survives the crossing. Recorded as
        // the first corroboration, exactly as an agent's evidence is.
        evidence: claim.evidence[0] ?? claim.claim,
        supersedes: null,
        resolvesWhen: null,
        // Neither ref crosses: a ref points into a world the reader cannot see, and
        // `<Ref to={ref}/>` would draw it as a live link to somebody else's tracker.
        aboutRef: null,
        where: claim.where,
      },
      {
        agentId: null,
        taskId: null,
        goalRef: null,
        sessionId: null,
        // The origin's own words, which is what survives the crossing.
        words: claim.evidence[0] ?? claim.claim,
        // The voice. One fleet is one voice, however many entries it publishes and
        // however many times it is polled.
        fleetId: document.fleetId,
      },
    );
    if (outcome.outcome === 'barred') {
      // A claim this fleet's operator rejected stays rejected, whoever else vouches
      // for it. The mirror still records that somebody believes it — a reading the
      // operator can act on, and never a way around their own ruling.
      arrivals.push({ ...mirrored, outcome: 'barred' });
      continue;
    }
    arrivals.push({
      ...mirrored,
      localFactId: outcome.fact.id,
      outcome: outcome.outcome === 'filed' ? 'proposed' : 'corroborated',
    });
  }
  return arrivals;
}

/**
 * How many local claims an arrival is matched against.
 *
 * The same cap `listFacts` defaults to, stated here because this read is on the
 * pulse: matching is normalisation rather than a predicate SQL can index, so the
 * work is linear in this number times the size of the arriving document.
 */
const POOL_MATCH_SCAN = 500;

/**
 * The standing local claim this arrival agrees with, or null.
 *
 * Live reaches only, and `claimsMatch` rather than equality — the same matcher
 * `proposeFact` uses, because a second one here would be free to disagree about
 * what one claim is on exactly the arrivals that matter.
 */
function matchingLocalFact(local: readonly KnowledgeFact[], claim: string): KnowledgeFact | null {
  const key = claimKey(claim);
  return (
    local.find(
      (fact) =>
        fact.scope === 'fleet' &&
        (fact.reach === 'proposal' || fact.reach === 'lookup' || fact.reach === 'injected') &&
        claimsMatch(key, claimKey(fact.claim)),
    ) ?? null
  );
}
