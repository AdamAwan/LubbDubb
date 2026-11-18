import type { ErrorRecorder } from '../errorLog.js';
import type { LoadedExtension } from '../extensions/contract.js';
import type { ExtensionHost } from '../extensions/host.js';
import type { ExtensionSlots } from '../extensions/slots.js';
import type { Store } from '../store/store.js';
import type { PrReview, PrReviewRoute, PrReviewRouteInput, PullRequest, WorldSnapshot } from '../types.js';
import { failure } from '../primitives.js';
import type { PrReviewPolicy } from './policy.js';
import { CommandReviewProber, type ReviewProber } from './reviewedElsewhere.js';
import {
  defaultReviewMode,
  needsFleetReview,
  publishNote,
  resolvedReviewMode,
  reviewModeNames,
  reviewReading,
  triageRuns,
} from './prReview.js';

// → docs/spec/07-pull-requests.md#the-review-from-the-projects-extension

type ReviewHost = Pick<ExtensionHost<ExtensionSlots>, 'call'>;

interface SeamDeps {
  host: ReviewHost;
  store: Store;
  errors: ErrorRecorder;
}

/** Who chooses a pull request's review mode: the triage agent, or the project's extension. */
export interface ReviewRouter {
  dispatchesTriage(): boolean;
  route(pr: PullRequest, defaultBranch: string): Promise<PrReviewRouteInput | null>;
}

/** Where the findings go once `review_report` has recorded them, and what the reviewer is told about it. */
export interface ReviewPublisher {
  note(): string;
  publish(review: PrReview): Promise<void>;
}

class TriageReviewRouter implements ReviewRouter {
  dispatchesTriage(): boolean {
    return true;
  }

  route(): Promise<PrReviewRouteInput | null> {
    return Promise.resolve(null);
  }
}

class ExtensionReviewRouter implements ReviewRouter {
  constructor(
    private readonly host: ReviewHost,
    private readonly policy: PrReviewPolicy,
    private readonly errors: ErrorRecorder,
  ) {}

  dispatchesTriage(): boolean {
    return false;
  }

  async route(pr: PullRequest, defaultBranch: string): Promise<PrReviewRouteInput> {
    const modes = reviewModeNames(this.policy);
    const answer = await this.host.call('routeReview', {
      pr: {
        number: pr.number,
        title: pr.title,
        branch: pr.branch,
        base: pr.baseBranch ?? defaultBranch,
        author: pr.author ?? null,
        body: pr.body ?? null,
      },
      modes,
      allowSkip: this.policy.allowSkip,
    });
    const base = { prNumber: pr.number, agentId: null, skipped: false };
    if (!answer.ok) return this.fallback(pr.number, answer.detail);
    const reason = answer.value.reason.trim();
    if ('skip' in answer.value && answer.value.skip === true) {
      if (this.policy.allowSkip) return { ...base, mode: '', skipped: true, reason };
      return this.refused(pr.number, 'it answered skip, and this project does not allow skipping a review');
    }
    const mode = 'mode' in answer.value ? answer.value.mode.trim() : '';
    if (!modes.includes(mode))
      return this.refused(pr.number, `it answered "${mode}", which is not one of review.modes (${modes.join(', ')})`);
    return { ...base, mode, reason };
  }

  private refused(prNumber: number, why: string): PrReviewRouteInput {
    this.errors.record({
      source: 'runtime',
      message: `the "routeReview" slot's answer for PR ${prNumber} was refused: ${why}`,
    });
    return this.fallback(prNumber, why);
  }

  private fallback(prNumber: number, why: string): PrReviewRouteInput {
    return {
      prNumber,
      agentId: null,
      skipped: false,
      mode: defaultReviewMode(this.policy) ?? '',
      reason: `The project's extension did not choose (${why}), so the review runs the default mode.`,
    };
  }
}

class ConfigReviewPublisher implements ReviewPublisher {
  constructor(private readonly policy: PrReviewPolicy) {}

  note(): string {
    return publishNote(this.policy.publish);
  }

  publish(): Promise<void> {
    return Promise.resolve();
  }
}

class ExtensionReviewPublisher implements ReviewPublisher {
  constructor(
    private readonly host: ReviewHost,
    private readonly store: Store,
    private readonly policy: PrReviewPolicy,
    private readonly errors: ErrorRecorder,
  ) {}

  note(): string {
    return (
      '\n\nDo not comment on the pull request. Your report through `review_report` is handed to this ' +
      "project's own code, which publishes it; anything you post beside it is a second copy of it under " +
      "somebody's name.\n"
    );
  }

  async publish(review: PrReview): Promise<void> {
    try {
      await this.ask(review);
    } catch (error) {
      this.errors.record({
        source: 'runtime',
        message: `the publication of the review of PR ${review.prNumber} could not be recorded`,
        detail: failure(error),
      });
    }
  }

  private async ask(review: PrReview): Promise<void> {
    const route = this.store.prReviewRoutes.getPrReviewRoute(review.prNumber);
    const answer = await this.host.call('publishReview', {
      pr: review.prNumber,
      headSha: review.headSha,
      mode: resolvedReviewMode(route, this.policy),
      verdict: review.verdict,
      summary: review.summary,
      findings: [...review.findings],
    });
    if (!answer.ok || answer.value.thread === null) return;
    const current = this.store.prReviews.listPrReviews().find((r) => r.prNumber === review.prNumber);
    if (current?.reviewedAt !== review.reviewedAt) return;
    this.store.prReviews.recordPrReviewPublished(review.prNumber, answer.value.thread.trim());
  }
}

/** The router for this deployment: the extension's where `review.routeExtension` is on, else the triage agent. */
class RoutedReviewRouter implements ReviewRouter {
  private readonly chosen: ReviewRouter;

  constructor(policy: PrReviewPolicy, deps: SeamDeps) {
    this.chosen = policy.routeExtension
      ? new ExtensionReviewRouter(deps.host, policy, deps.errors)
      : new TriageReviewRouter();
  }

  dispatchesTriage(): boolean {
    return this.chosen.dispatchesTriage();
  }

  route(pr: PullRequest, defaultBranch: string): Promise<PrReviewRouteInput | null> {
    return this.chosen.route(pr, defaultBranch);
  }
}

/** The publisher for this deployment: the extension's where `review.publishExtension` is on, else `review.publish`. */
class RoutedReviewPublisher implements ReviewPublisher {
  private readonly chosen: ReviewPublisher;

  constructor(policy: PrReviewPolicy, deps: SeamDeps) {
    this.chosen = policy.publishExtension
      ? new ExtensionReviewPublisher(deps.host, deps.store, policy, deps.errors)
      : new ConfigReviewPublisher(policy);
  }

  note(): string {
    return this.chosen.note();
  }

  publish(review: PrReview): Promise<void> {
    return this.chosen.publish(review);
  }
}

export function defaultReviewRouter(): ReviewRouter {
  return new TriageReviewRouter();
}

export function defaultReviewPublisher(policy: PrReviewPolicy): ReviewPublisher {
  return new ConfigReviewPublisher(policy);
}

/** Asks the router for every pull request waiting on a route; a call still answering is not asked again. */
export class ReviewRouteDesk {
  private readonly asking = new Set<number>();

  constructor(
    private readonly deps: {
      store: Store;
      errors: ErrorRecorder;
      review: PrReviewPolicy;
      router: ReviewRouter;
      defaultBranch: string;
    },
  ) {}

  run(at: { dispatchWorld: WorldSnapshot; prReviews: PrReview[]; prReviewRoutes: PrReviewRoute[] }): Promise<void> {
    const { review, router, store } = this.deps;
    if (!review.enabled || !triageRuns(review) || router.dispatchesTriage()) return Promise.resolve();
    const rows = {
      prReviews: new Map(at.prReviews.map((r) => [r.prNumber, r])),
      prReviewRoutes: new Map(at.prReviewRoutes.map((r) => [r.prNumber, r])),
      prReviewedElsewhere: store.prReviewExternals.prsReviewedElsewhere(),
    };
    const waiting = at.dispatchWorld.pullRequests.filter(
      (pr) =>
        !this.asking.has(pr.number) &&
        !rows.prReviewRoutes.has(pr.number) &&
        needsFleetReview(pr, reviewReading(rows, pr.number), review),
    );
    return Promise.all(waiting.map((pr) => this.ask(pr))).then(() => undefined);
  }

  private async ask(pr: PullRequest): Promise<void> {
    if (this.deps.store.prReviewRoutes.getPrReviewRoute(pr.number) !== null) return;
    this.asking.add(pr.number);
    try {
      const route = await this.deps.router.route(pr, this.deps.defaultBranch);
      if (route !== null) this.deps.store.prReviewRoutes.recordPrReviewRoute(route);
    } catch (error) {
      this.deps.errors.record({
        source: 'cycle',
        message: `the review route for PR ${pr.number} could not be recorded`,
        detail: failure(error),
      });
    } finally {
      this.asking.delete(pr.number);
    }
  }
}

/** The review's seams for this deployment: the reviewed-elsewhere prober, the router and its desk, the publisher. */
export function buildReviewSeams(
  config: { review: PrReviewPolicy; defaultBranch: string; repoRoot: string },
  deps: { host: ReviewHost; store: Store; errors: ErrorRecorder; prober?: ReviewProber },
) {
  const reviewRouter = new RoutedReviewRouter(config.review, deps);
  return {
    reviewProber:
      config.review.reviewedElsewhere === null ? undefined : (deps.prober ?? new CommandReviewProber(config.repoRoot)),
    reviewRouter,
    reviewPublisher: new RoutedReviewPublisher(config.review, deps),
    reviewRoutes: new ReviewRouteDesk({
      store: deps.store,
      errors: deps.errors,
      review: config.review,
      router: reviewRouter,
      defaultBranch: config.defaultBranch,
    }),
  };
}

/** Opting into a review slot needs an extension that fills it. */
export function checkReviewExtension(policy: PrReviewPolicy, loaded: readonly LoadedExtension[] = []): void {
  for (const [key, slot] of [
    ['routeExtension', 'routeReview'],
    ['publishExtension', 'publishReview'],
  ] as const) {
    if (!policy[key] || loaded.some((extension) => extension.slots.has(slot))) continue;
    throw new Error(
      `Refusing to start: "review.${key}" is set and no extension fills the "${slot}" slot. Add the extension ` +
        `to "extensions", or drop "review.${key}".`,
    );
  }
}
