import { loadConfig } from '../config.js';
import { buildSystem, reconcileOnBoot } from '../system.js';
import { buildApp } from './app.js';

/**
 * Entry point. Wires the system, reconciles any agents orphaned by a previous
 * crash, starts the HTTP/WebSocket server, then starts the heartbeat and runs
 * one boot cycle so the harness reacts to whatever the world looks like on
 * startup.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const system = buildSystem(config);

  const reconciled = reconcileOnBoot(system.store);
  if (reconciled > 0) {
    console.log(`[lubbdubb] reconciled ${reconciled} orphaned agent(s) from a previous run`);
  }

  const { app } = await buildApp(system);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[lubbdubb] cockpit listening on http://localhost:${config.port}`);
  console.log(
    `[lubbdubb] dispatcher=${config.dispatcher} heartbeat=${config.heartbeatIntervalMs}ms cap=${config.maxConcurrentAgents}`,
  );

  system.harness.start();
  await system.harness.runCycle('boot');

  const shutdown = async (): Promise<void> => {
    console.log('\n[lubbdubb] shutting down...');
    system.harness.stop();
    system.agents.killAll();
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
