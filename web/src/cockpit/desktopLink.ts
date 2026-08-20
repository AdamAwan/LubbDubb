/**
 * The deep link that opens the operator's own Claude Code with a prompt already
 * in the box.
 *
 * ```
 * claude://code/new?q=<prompt>&folder=<checkout>
 * ```
 *
 * **`code`, not `claude.ai`.** The client routes the two differently: this host
 * lands on its Claude Code surface, which has the repository, the `/lubbdubb`
 * skill and the harness's MCP registration — a plain chat has none of the three,
 * and would be a session that could not answer the question it was opened to
 * answer. `claude-cli://open` reaches the same engine and spawns a *terminal*,
 * which is not what a cockpit button should do to somebody.
 *
 * **Prefilled, not sent.** `q` fills the composer and stops; the operator reads
 * the command before it goes. That is the behaviour worth having on a control
 * that starts a conversation on their behalf, so nothing here tries to defeat it.
 *
 * **It fires on the machine the browser is on**, which is the same limit the
 * clipboard copy this replaced always had: a cockpit opened from another desk
 * gets a link its own client answers. There is no reading of that we could act
 * on, so it is stated rather than guarded.
 *
 * One module because the shape above is a fact about Claude Code rather than
 * about a family of refs — this is not a `<Ref to={…}/>` case.
 */
export function desktopDeepLink(folder: string, prompt: string): string {
  const query = new URLSearchParams({ q: prompt, folder });
  return `claude://code/new?${query.toString()}`;
}

/**
 * What the operator's Claude is asked when they hit Discuss on a plan — the
 * `/lubbdubb` skill's own second argument form, exactly as `desktopPrompt` is its
 * first.
 *
 * **The goal's number, never the plan's id.** The id is a harness row that means
 * nothing to a session on the other side of a socket; the number is what
 * `plan_read` and `plan_amend` resolve a plan by, and what the operator is
 * looking at.
 */
export function discussPrompt(issueNumber: number): string {
  return `/lubbdubb discuss ${issueNumber}`;
}

/**
 * What the operator's Claude is asked when they hit *run it locally* on a goal —
 * the skill's third argument form, and the same rule as the other two: the goal's
 * number, because that is what `local_run` resolves parts and branches by.
 *
 * Unconditional, unlike the other two controls. There is no configuration to
 * check first: the `local-run` prompt has a built-in default that says "work it
 * out from the repository", so a deployment that has written nothing down still
 * gets a session that tries — and a button drawn only where somebody had already
 * configured it would be a dead end found by walking into it, which is the
 * argument that made this whole channel unconditional.
 */
export function localRunPrompt(issueNumber: number): string {
  return `/lubbdubb run ${issueNumber}`;
}
