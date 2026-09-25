import type { ReviewAreaRule } from '../config/config.js';

// → docs/spec/18-observability.md#which-part-of-the-code-a-review-thread-was-about

/**
 * The areas a path belongs to, or null where the thread names no path at all.
 *
 * Null is not "no area": a pull-request-level comment is anchored to nothing, and folding it
 * into the residual area inflates whichever one that is.
 */
export function areasForPath(path: string | null, rules: readonly ReviewAreaRule[]): string[] | null {
  if (path === null) return null;
  const areas: string[] = [];
  for (const rule of rules) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.path);
    } catch {
      continue;
    }
    if (pattern.test(path) && !areas.includes(rule.area)) areas.push(rule.area);
  }
  return areas;
}

/** Every area name the rules can produce, in the order they are declared. */
export function areaNames(rules: readonly ReviewAreaRule[]): string[] {
  const names: string[] = [];
  for (const rule of rules) if (!names.includes(rule.area)) names.push(rule.area);
  return names;
}
