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
 * `/lubbdubb` skill's own second argument form, exactly as {@link checkPrompt} is
 * its first.
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

/**
 * What the operator's Claude is asked when they hit *ask* on a goal — the skill's
 * fourth argument form, and the goal's number for the other three's reason.
 *
 * **No question in the prompt.** The other three controls start a job with one
 * meaning, so the whole command can be prefilled and sent; this one starts a
 * conversation whose subject the operator has not said yet. `q` fills the composer
 * without sending, so what lands is `/lubbdubb ask 284` with the cursor after it
 * and the goal already settled — which is exactly the half they should not have to
 * type. Guessing a question for them would be a control that asked something else
 * on the occasions it was wrong, and there is no reading of a click that says
 * which question it was.
 */
export function askPrompt(issueNumber: number): string {
  return `/lubbdubb ask ${issueNumber} `;
}

/**
 * What an operator's Claude is asked when they hit *Run it in Claude Code* on a
 * validation check — `/lubbdubb 249:A`, the skill's own first argument form.
 *
 * **The goal's number and the check's stored letter, never a row's position.**
 * That pair is what the skill resolves the check by, and a letter derived from
 * where a row currently sits would address a different check after the next
 * amendment — the failure the stored letter exists to prevent, one layer up.
 *
 * Here rather than in `ValidationSection.tsx`, where it was written: the four
 * prompt builders are one vocabulary — the argument forms of one skill — and a
 * builder living in the surface that happens to draw it is how a fifth comes to be
 * written somewhere else instead of found here.
 */
export function checkPrompt(issueNumber: number, letter: string): string {
  return `/lubbdubb ${issueNumber}:${letter}`;
}

/**
 * What the operator's Claude is asked when they hit *Got a question?* on the top
 * bar — the skill's name and nothing else, with the cursor after it.
 *
 * **No argument, because the bar knows of no goal.** The other four controls are
 * drawn beside the thing they are about and can address it; this one is drawn
 * beside the wordmark and is the answer to the question nobody was asking anybody:
 * *why is this not being done?* The skill routes on the words that follow — a
 * question with a goal number in it is the goal job, one without is the fleet job
 * — so the half worth prefilling is the skill, and the half only the operator has
 * is the question.
 *
 * Unsent for {@link askPrompt}'s reason, one step further along: there is not even
 * a subject here, so a click that sent anything would be a session opened on a
 * question the operator has not had yet.
 */
export function questionPrompt(): string {
  return '/lubbdubb ';
}
