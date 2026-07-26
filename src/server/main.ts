import { loadConfig } from '../config.js';
import { buildSystem, reconcileAndResumeOnBoot } from '../system.js';
import { buildApp } from './app.js';

/**
 * Entry point. Wires the system, resumes/reconciles any agents orphaned by a
 * previous run *before* anything else reacts to the world, starts the
 * HTTP/WebSocket server, then starts the heartbeat and runs one boot cycle so
 * the harness reacts to whatever the world looks like on startup.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const system = buildSystem(config);

  // Before boot resume, so a resumed agent's relaunch already carries the tool
  // channel. Best-effort by contract: a false return means agents run on the
  // sentinels alone, which is a supported configuration, not a failed start.
  const mcpReady = config.mcp.enabled ? await system.mcp.listen() : false;

  // Runs before the boot cycle so resumed agents occupy their concurrency slots
  // before any new work is dispatched.
  const { resumed, interrupted } = reconcileAndResumeOnBoot(
    system.store,
    system.agents,
    system.escalations,
    system.errors,
  );
  if (resumed > 0 || interrupted > 0) {
    console.log(`[lubbdubb] boot: resumed ${resumed} agent(s), interrupted ${interrupted} from a previous run`);
  }

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
  console.log(
    `[lubbdubb] dispatcher=${config.dispatcher} heartbeat=${config.heartbeatIntervalMs}ms cap=${config.maxConcurrentAgents}`,
  );
  console.log(
    `[lubbdubb] agent tools: ${mcpReady ? 'on' : config.mcp.enabled ? 'unavailable — sentinels only' : 'disabled'}`,
  );

  system.harness.start();
  await system.harness.runCycle('boot');

  const shutdown = async (): Promise<void> => {
    console.log('\n[lubbdubb] shutting down...');
    system.harness.stop();
    // Interrupt (not kill) so the next boot can resume this in-flight work.
    system.agents.interruptAll();
    await system.mcp.close();
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
