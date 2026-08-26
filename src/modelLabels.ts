import { orderedProfiles, profileRank, type AgentModels } from './agents/modelPolicy.js';

/**
 * The tag that pins one goal to a model profile (issue #342), derived from the
 * same `labelPrefix` the watch pair comes from:
 *
 * - `${prefix}-model-<profile>` — "run this issue's work on `<profile>`"
 *
 * ## Why the tracker holds it
 *
 * `agentModels.byRule` assigns a profile per *kind of work*, which is right as
 * the default axis and has no answer for the issue that is harder than the rule
 * it arrived on. The lever that answers it has to be reachable in the time it
 * takes to read a ticket, which config is not.
 *
 * A label is that lever, and it is the watch toggle's own shape rather than a
 * second one: written through `connector.setIssueLabel`, so Azure DevOps needs
 * no separate answer; read off `Issue.labels`, so the dispatcher, the gate and
 * the cockpit resolve it through this one pure function and cannot drift; and
 * visible on the ticket, which is what makes "does a pin expire?" a question
 * with no mechanism behind it — a human can see it and take it off.
 *
 * The tag holds the **resolved answer**, not an operator override sitting beside
 * an inferred one. The appraiser proposes a profile, a human confirms or changes
 * it, and what lands here is the outcome — so dispatch does one lookup rather
 * than ranking two sources, and "who decided this" is still answerable by
 * comparing the tag against the proposal the appraisal row kept.
 */

/** The label that pins a goal to `profile`. Empty prefix yields an empty label — the feature off. */
function modelLabelFor(prefix: string, profile: string): string {
  return prefix ? `${prefix}-model-${profile}` : '';
}

/**
 * Every model label this deployment could write, cheapest profile first.
 *
 * The clearing set as much as the offering set: pinning a goal to one profile
 * has to remove the others, the way "watch" removes "ignore". Derived from the
 * configured profiles rather than from what is on the ticket, so a tag naming a
 * profile that was deleted from config is still cleared by name.
 */
export function modelLabelsFor(prefix: string, models: AgentModels | undefined): { profile: string; label: string }[] {
  if (!prefix) return [];
  return orderedProfiles(models).map((p) => ({ profile: p.name, label: modelLabelFor(prefix, p.name) }));
}

/** What an issue's labels say about which profile its work should run on. */
interface ModelTag {
  /** The pinned profile, or null when the issue carries no usable tag. */
  profile: string | null;
  /**
   * Model labels on the issue that name no configured profile, or that lost to a
   * deeper tag. Never empty-and-meaningless: the caller records these through
   * `errors.record` so a mistyped tag is visible, and **acts anyway** on
   * {@link ModelTag.profile}.
   */
  ignored: string[];
}

/**
 * Resolve an issue's pinned profile from its labels. Total — never throws, and
 * never parks anything.
 *
 * Two rules, both chosen for what their failure looks like:
 *
 * - **A tag naming no configured profile is ignored, not obeyed and not fatal.**
 *   `validateAgentModels` refuses a bad profile name at boot because config is
 *   the operator's own file; a label is typed on a ticket by a human the harness
 *   cannot stop, so the only choices here are to fall back to the rule's entry or
 *   to park a watched issue over a typo. Falling back is the one that cannot
 *   strand work, and the ignored tag is reported so it is not silent.
 * - **Two valid tags resolve to the deeper one.** Ranks are unique, so there is
 *   always an answer. Deeper rather than cheaper because a pin is bought
 *   capability: an operator who has left two tags on a ticket has not said which
 *   they meant, and quietly taking the cheaper one is the failure that looks like
 *   ordinary output.
 */
export function resolveModelTag(
  labels: string[] | undefined,
  prefix: string,
  models: AgentModels | undefined,
): ModelTag {
  const present = labels ?? [];
  if (!prefix || !models) return { profile: null, ignored: [] };
  const known = new Map(modelLabelsFor(prefix, models).map((m) => [m.label, m.profile]));
  const marker = `${prefix}-model-`;
  let profile: string | null = null;
  const ignored: string[] = [];
  for (const label of present) {
    if (!label.startsWith(marker)) continue;
    const named = known.get(label);
    if (named === undefined) {
      ignored.push(label);
      continue;
    }
    if (profile === null) {
      profile = named;
      continue;
    }
    // Ranks are unique and both names are configured, so both lookups resolve and
    // the comparison is total.
    const standing: string = profile;
    const [deeper, shallower]: [string, string] =
      (profileRank(models, named) ?? 0) > (profileRank(models, standing) ?? 0) ? [named, standing] : [standing, named];
    profile = deeper;
    ignored.push(modelLabelFor(prefix, shallower));
  }
  return { profile, ignored };
}
