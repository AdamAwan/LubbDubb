import { loadDeploymentConfig } from '../config.js';
import { watchConfigFile } from '../configWatch.js';
import { UPGRADE_EXIT_CODE } from '../selfUpdate/handoff.js';
import { buildSystem } from '../system.js';
import { installDesktopSkill } from '../validation/desktopSkill.js';
import { buildApp } from './app.js';

/** How long the upgrade handoff waits for the reply that asked for it to reach the wire. */
const HANDOFF_GRACE_MS = 250;

/**
 * Entry point. Wires the system, parks any agents orphaned by a previous run for
 * an operator's decision *before* anything else reacts to the world, starts the
 * HTTP/WebSocket server, then starts the heartbeat and runs one boot cycle so
 * the harness reacts to whatever the world looks like on startup.
 *
 * **The shutdown handlers are registered before anything can start an agent**, and
 * that ordering is the whole of why this function is shaped the way it is. They
 * used to be installed at the very end, after the boot cycle had already run —
 * which left a window covering exactly the two things that launch processes, an
 * upgrade's auto-restore and the boot cycle's dispatches, in which a Ctrl-C took
 * Node's default path. That path runs no handler, so the agents were not
 * interrupted, not reaped, and not recorded: real orphans, holding their worktrees
 * open, with rows still claiming to be live.
 */
async function main(): Promise<void> {
  const config = loadDeploymentConfig();
  const system = buildSystem(config);

  // The vivarium's one-time clearance, before anything can hatch into it. Runs at
  // most once per deployment — the stamp it writes is what makes every later boot
  // a no-op — and it is here rather than in `buildSystem` for the reason
  // `loadDeploymentConfig` is: a suite that grew it would wipe the fixture out
  // from under whichever test built its system first.
  try {
    const reset = system.pets.resetOnce();
    if (reset)
      console.log(`[lubbdubb] vivarium cleared: ${reset.cleared} pet(s) released and the beats start again from zero`);
  } catch (err) {
    system.errors.record({ source: 'server', message: `Vivarium clearance failed: ${(err as Error).message}` });
  }

  // Before crash detection, so an agent the operator restores relaunches already
  // carrying the tool channel. Best-effort by contract: a false return means agents
  // run on the sentinels alone, which is a supported configuration, not a failed start.
  const mcpReady = await system.mcp.listen();

  // The desktop channel is the one thing here still behind a flag, because it is
  // the one thing with a footprint outside the harness: `listen()` binds the
  // stable socket and writes into the operator's home directory. The skill rides
  // with it rather than switching separately — the channel without its skill is
  // the channel failing at the job it was turned on for.
  const desktopReady = config.validation.desktop ? await system.desktop.listen() : false;
  if (desktopReady) installDesktopSkill(config.validation.desktopSkillPath, system.errors);

  // Runs before the boot cycle, though the hold does not depend on that: the
  // harness re-asks every pulse, so what this ordering buys is only that the very
  // first cycle already knows. Nothing is resumed or buried here — each orphan
  // waits for the operator's restore / requeue / remove, and until they have all
  // been answered the harness dispatches nothing.
  const crashed = system.recovery.detect();

  const { app, hub, cockpitUrl, tokenPath } = await buildApp(system);
  await app.listen({ port: config.port, host: config.host });
  console.log(`[lubbdubb] cockpit listening on ${config.host}:${config.port}`);
  if (cockpitUrl) {
    // The token rides in the URL *fragment*, which browsers never send to a
    // server — so this line is safe to be the thing you click, and the cockpit
    // lifts the token out of it client-side.
    console.log(`[lubbdubb] open the cockpit: ${cockpitUrl}`);
    if (tokenPath) console.log(`[lubbdubb] token minted at ${tokenPath} (0600) — reused on the next start`);
  } else {
    console.log('[lubbdubb] cockpit auth is DISABLED — anyone who can reach this port can queue jobs');
  }
  console.log(`[lubbdubb] heartbeat=${config.heartbeatIntervalMs}ms cap=${config.maxConcurrentAgents}`);
  console.log(`[lubbdubb] agent tools: ${mcpReady ? 'on' : 'unavailable — sentinels only'}`);
  if (desktopReady) {
    // Printed with the command rather than a reference to it: this is the one
    // thing an operator has to do by hand, exactly once, and looking it up in the
    // spec is the step where they stop.
    const { command, args } = system.desktop.registration();
    console.log(`[lubbdubb] desktop validation channel on — register it in Claude Code once with:`);
    console.log(`[lubbdubb]   claude mcp add --scope user lubbdubb -- ${command} ${args.join(' ')}`);
    console.log(`[lubbdubb] credential at ${system.desktop.credentialPath()} (0600), reminted every start`);
    console.log(`[lubbdubb] /lubbdubb skill installed at ${config.validation.desktopSkillPath}`);
  }

  // The file, watched — so an edit made in an editor or by Claude lands on the
  // same apply path a cockpit save does. Wired here rather than in `buildSystem`
  // for `loadDeploymentConfig`'s reason: only a deployment has an ambient file to
  // watch, and a test that grew one would pick up whatever config the developer
  // runs the app with.
  const stopConfigWatch = watchConfigFile({
    filePath: system.configFile,
    liveConfig: system.liveConfig,
    errors: system.errors,
    reload: () => loadDeploymentConfig(),
    onChanged: () => hub.broadcast({ type: 'config:changed' }),
  });

  // Everything that can start an agent is below this line. See the note above.
  const shutdown = (exitCode: number) => async (): Promise<void> => {
    console.log(
      exitCode === UPGRADE_EXIT_CODE ? '\n[lubbdubb] going down for an upgrade...' : '\n[lubbdubb] shutting down...',
    );
    system.harness.stop();
    stopConfigWatch();
    // Interrupt (not kill) so the next boot offers this in-flight work for restore.
    system.agents.interruptAll();
    await system.mcp.close();
    await system.desktop.close();
    await app.close();
    system.store.close();
    process.exit(exitCode);
  };
  process.on('SIGINT', shutdown(0));
  process.on('SIGTERM', shutdown(0));
  // How the cockpit's Apply gets this process to exit *distinguishably*: the
  // supervisor relaunches on this code alone, and treats every other ending as the
  // server's own. Wired here rather than in `buildSystem` because shutdown is this
  // file's — a harness embedded in a test has no port, no supervisor and nothing to
  // hand off to, and its `apply` correctly stops at recording the intent.
  //
  // **Deferred, and that is not a cosmetic delay.** The desk calls this from inside
  // the route handler, before the reply has been written; going down synchronously
  // would close the server out from under the response, and the cockpit that asked
  // for the upgrade would see a dropped socket rather than the confirmation and the
  // broadcast. A tick is not enough — the reply has to reach the wire — so this
  // waits, and the shutdown itself is what the operator is told is happening.
  system.updates.onHandoff = () => {
    setTimeout(() => void shutdown(UPGRADE_EXIT_CODE)(), HANDOFF_GRACE_MS);
  };

  // The other half of a deliberate upgrade: the agents this harness interrupted on
  // its way down come back without anyone being asked, because they were already
  // asked. Anything it will not restore itself — a real crash inside the upgrade
  // window, a worktree that has gone — still holds the pulse and still needs a
  // verdict, so both halves are announced.
  const upgrade = system.recovery.settleUpgrade();
  system.updates.clearIntent();
  for (const item of upgrade.restored)
    console.log(`[lubbdubb] restored ${item.taskId} (${item.agentId}) after the upgrade — ${item.title}`);
  const held = upgrade.restored.length > 0 ? upgrade.left : crashed;

  if (held.length > 0) {
    // Loud, and printed after the cockpit URL so it is the last thing on screen:
    // the harness will now do nothing at all until these are answered, and an
    // operator who reads this as a warning rather than a stop sign will conclude
    // the heartbeat is broken.
    console.log(
      `[lubbdubb] ${held.length} piece(s) of work did not survive the last run — the pulse is HELD until ` +
        'you restore, requeue or remove each of them in the cockpit',
    );
    for (const c of held)
      console.log(
        `[lubbdubb]   ${c.taskId}${c.agentId ? ` (${c.agentId})` : ' — no agent ever started'} — ${c.title}` +
          `${c.originRef ? ` (${c.originRef})` : ''}`,
      );
  }

  system.harness.start();
  await system.harness.runCycle('boot');
}

main().catch((err) => {
  console.error('[lubbdubb] fatal:', err);
  process.exit(1);
});
