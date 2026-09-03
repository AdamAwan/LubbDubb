import type { ExtraMcpServer } from '../types.js';

/**
 * The local validation's operator policy: the facts about *this* deployment's
 * environment that an agent cannot read out of the repository, and what gives it a
 * browser.
 *
 * Its own module for {@link DEFAULT_LOCAL_RUN}'s reason — a policy's default belongs
 * beside the subsystem that means it rather than in the middle of `config.ts`.
 *
 * **The split with the prompt is the whole design.** The `local-validation` template
 * says how to build a test plan and how to run one, which is the same job on every
 * deployment; this says how to reach *your* environment, which is the same job
 * nowhere. Put the URLs and the sign-in quirk in the prompt and every deployment
 * overriding the template inherits somebody else's; put the method in config and an
 * operator is maintaining a prompt in a text box. → `docs/spec/32-local-validation.md`
 */
export interface LocalValidationPolicy {
  /**
   * What a validating agent is told about reaching this environment, verbatim —
   * appended to the rendered prompt, never interpolated into it.
   *
   * The facts nothing else in the deployment holds: which URL is which application,
   * which account to sign in as and how (a username-only local identity provider,
   * say), what a first page load does that looks like a failure, which parts of the
   * stack to leave alone. `localRun.instruction` is its sibling one step earlier —
   * that one says how the environment is *started*, this one how it is *used*.
   *
   * **Never a secret.** It is config, it is readable in the cockpit, and a project
   * layer commits it to the repository. A password here is a password in git; the
   * environments worth validating against are the ones with a throwaway local login.
   *
   * **Empty is a supported state**, not a missing one: a deployment whose
   * application answers on the configured URL with nothing to know has nothing to
   * say here, and the agent still gets the URL, the plan and the browser.
   */
  instruction: string;
  /**
   * The MCP server that gives a validating agent a browser, or null for none.
   *
   * A server rather than a flag because there is no browser inside a headless
   * `claude -p`: Claude in Chrome and computer use both require an interactive
   * session and refuse print mode outright, so the only way an unattended agent
   * drives a screen is a tool server on its own launch. It rides the harness's own
   * `--mcp-config` document under the key `browser`, granted as `mcp__browser`
   * ([11](../../docs/spec/11-mcp-tools.md#launch-flags)).
   *
   * Two tokens in `args` are substituted at dispatch by {@link substituteBrowserArgs}:
   * `{outputDir}`, this validation's own directory, and `{profileDir}`, the
   * deployment's one browser profile. They are tokens rather than fixed flags
   * because which flag carries them is the server's business — a deployment that
   * swaps Playwright for something else spells them differently — and they are
   * substituted rather than appended because a flag's value has to sit beside it.
   *
   * **Null means no browser**, and is a real configuration rather than a broken one:
   * an API-only project is validated perfectly well without one. The prompt says so
   * outright, so the agent reports `blocked` for a step that needs a screen instead
   * of inventing what the screen showed.
   */
  browser: ExtraMcpServer | null;
}

/**
 * Playwright, headed, on a persistent profile.
 *
 * **Headed on purpose.** The operator is at the machine — that is the whole premise
 * of a local run — and a validation they can watch is one they can believe. It is
 * also what makes the profile worth having: a login the operator completes once in a
 * visible window is a login every later validation inherits.
 *
 * Pinned to no version because `npx -y @playwright/mcp@latest` is what the operator
 * would type, and a version pinned here would be a second thing to keep current
 * with no test that could ever fail on it.
 */
export const DEFAULT_LOCAL_VALIDATION: LocalValidationPolicy = {
  instruction: '',
  browser: {
    key: 'browser',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--output-dir', '{outputDir}', '--user-data-dir', '{profileDir}'],
  },
};

/** The tokens {@link substituteBrowserArgs} knows. Anything else is left alone. */
const TOKENS = ['outputDir', 'profileDir'] as const;

/**
 * Fill this validation's directories into the browser server's arguments.
 *
 * Substitution rather than appending, because a value belongs beside the flag that
 * takes it and only the operator's `args` say which flag that is. An **unknown**
 * token is left standing rather than blanked, `renderTemplate`'s rule: a literal
 * `{whatever}` reaching the command line is visible in the error the server prints,
 * where an empty string would silently become the process's working directory.
 */
export function substituteBrowserArgs(
  server: ExtraMcpServer,
  paths: { outputDir: string; profileDir: string },
): ExtraMcpServer {
  return {
    ...server,
    args: server.args.map((arg) => TOKENS.reduce((acc, token) => acc.split(`{${token}}`).join(paths[token]), arg)),
  };
}
