import { loadDeploymentConfig } from '../config.js';
import { buildSystem } from '../system.js';
import { installDesktopSkill } from '../validation/desktopSkill.js';
import { buildApp } from './app.js';

/**
 * Entry point. Wires the system, parks any agents orphaned by a previous run for
 * an operator's decision *before* anything else reacts to the world, starts the
 * HTTP/WebSocket server, then starts the heartbeat and runs one boot cycle so
 * the harness reacts to whatever the world looks like on startup.
 */
async function main(): Promise<void> {
  const config = loadDeploymentConfig();
  const system = buildSystem(config);

  // Before crash detection, so an agent the operator restores relaunches already
  // carrying the tool channel. Best-effort by contract: a false return means agents
  // run on the sentinels alone, which is a supported configuration, not a failed start.
  const mcpReady = config.mcp.enabled ? await system.mcp.listen() : false;

  // The desktop channel, on the same terms. `listen()` is the only thing that
  // binds the stable socket or writes into the operator's home directory, which
  // is why it is behind an explicitly-off-by-default flag rather than a default.
  const desktopReady = config.validation.desktop ? await system.desktop.listen() : false;
  if (desktopReady && config.validation.desktopSkill) {
    installDesktopSkill(config.validation.desktopSkillPath, system.errors);
  }

  // Runs before the boot cycle, though the hold does not depend on that: the
  // harness re-asks every pulse, so what this ordering buys is only that the very
  // first cycle already knows. Nothing is resumed or buried here — each orphan
  // waits for the operator's restore / requeue / remove, and until they have all
  // been answered the harness dispatches nothing.
  const crashed = system.recovery.detect();

  const { app, cockpitUrl, tokenPath } = await buildApp(system);
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
  console.log(
    `[lubbdubb] agent tools: ${mcpReady ? 'on' : config.mcp.enabled ? 'unavailable — sentinels only' : 'disabled'}`,
  );
  if (desktopReady) {
    // Printed with the command rather than a reference to it: this is the one
    // thing an operator has to do by hand, exactly once, and looking it up in the
    // spec is the step where they stop.
    const { command, args } = system.desktop.registration();
    console.log(`[lubbdubb] desktop validation channel on — register it in Claude Code once with:`);
    console.log(`[lubbdubb]   claude mcp add --scope user lubbdubb -- ${command} ${args.join(' ')}`);
    console.log(`[lubbdubb] credential at ${system.desktop.credentialPath()} (0600), reminted every start`);
    if (config.validation.desktopSkill) {
      console.log(`[lubbdubb] /lubbdubb skill installed at ${config.validation.desktopSkillPath}`);
    }
  }

  if (crashed.length > 0) {
    // Loud, and printed after the cockpit URL so it is the last thing on screen:
    // the harness will now do nothing at all until these are answered, and an
    // operator who reads this as a warning rather than a stop sign will conclude
    // the heartbeat is broken.
    console.log(
      `[lubbdubb] ${crashed.length} piece(s) of work did not survive the last run — the pulse is HELD until ` +
        'you restore, requeue or remove each of them in the cockpit',
    );
    for (const c of crashed)
      console.log(
        `[lubbdubb]   ${c.taskId}${c.agentId ? ` (${c.agentId})` : ' — no agent ever started'} — ${c.title}` +
          `${c.originRef ? ` (${c.originRef})` : ''}`,
      );
  }

  system.harness.start();
  await system.harness.runCycle('boot');

  const shutdown = async (): Promise<void> => {
    console.log('\n[lubbdubb] shutting down...');
    system.harness.stop();
    // Interrupt (not kill) so the next boot offers this in-flight work for restore.
    system.agents.interruptAll();
    await system.mcp.close();
    await system.desktop.close();
    await app.close();
    system.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[lubbdubb] fatal:', err);
  process.exit(1);
});
