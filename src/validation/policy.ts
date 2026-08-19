/**
 * The validation plan's operator policy — what a deployment turns on, and what it
 * turns off byte-for-byte.
 *
 * Its own module for {@link DEFAULT_PLANNING}'s reason: the policy's default
 * belongs beside the subsystem that means it, not in the middle of `config.ts`
 * where the four other funnels' defaults would have to be read to find it.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The desktop channel — a second MCP socket the operator's *own* Claude Code
 * connects to, so a check that needs a browser and a login the fleet does not
 * have can be run at their keyboard and reported back through the same rows — is
 * **unconditional**. It used to be behind a switch, on the argument
 * that its footprint sits outside the harness: a credential in the operator's
 * home directory, a skill installed into their Claude Code, and a socket at a
 * fixed path. What settled it the other way is that nothing else was ever behind
 * the flag — the cockpit draws **Copy desktop prompt** on every unrun check, so a
 * deployment that took the defaults was offered a prompt that connected to
 * nothing, with no error and no marker to say why. The paths below are what is
 * left to choose, and they are the whole of how two harnesses share a machine.
 */
export interface ValidationPolicy {
  /**
   * How long a desktop claim holds a check without being released.
   *
   * A claim is normally released when the session's socket closes or when the
   * check is reported. Neither survives a harness that was killed in between, and
   * a stale claim blocks the fleet from a check nobody is running — so it expires.
   * An hour is long enough that nobody loses a claim mid-run and short enough
   * that a forgotten one does not outlive the working day.
   */
  desktopClaimMinutes: number;
  /**
   * The socket the desktop bridge connects on. **Stable, not per-pid**, unlike
   * the fleet's — that is the whole difference, and what lets the MCP server be
   * registered in Claude Code once rather than per run.
   *
   * The cost is that two harnesses on one machine want the same path, so the
   * desktop channel refuses to steal a live one rather than unlinking it the way
   * the fleet socket does. See `SocketChannel`.
   */
  desktopSocketPath: string;
  /**
   * Where the desktop credential is written, 0600.
   *
   * Not a secret in the configuration — this is a *path*, and the token inside is
   * minted at boot, which is why the file exists at all: it keeps the token out
   * of the MCP registration the operator pastes, and out of `ps`.
   */
  desktopCredentialPath: string;
  /**
   * Where the `/lubbdubb` skill is installed. It is written and refreshed
   * every time the desktop channel starts, and the file says so in its own body.
   *
   * The skill is the interface — without it the operator types the same six
   * sentences at their Claude every time, which is the thing the channel exists
   * to stop. So it is not separately switchable: a channel running without it is
   * the channel failing at the job it was turned on for.
   */
  desktopSkillPath: string;
}

export const DEFAULT_VALIDATION: ValidationPolicy = {
  desktopClaimMinutes: 60,
  // Under the OS tmpdir for the fleet socket's reason: POSIX caps a socket path
  // at about 104 characters, which a repo-relative path clears easily.
  desktopSocketPath:
    process.platform === 'win32' ? '\\\\.\\pipe\\lubbdubb-desktop' : join(tmpdir(), 'lubbdubb', 'mcp-desktop.sock'),
  desktopCredentialPath: join(homedir(), '.lubbdubb', 'desktop.json'),
  desktopSkillPath: join(homedir(), '.claude', 'skills', 'lubbdubb', 'SKILL.md'),
};
