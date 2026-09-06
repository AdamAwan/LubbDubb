import { loadDeploymentConfig } from '../config.js';
import { watchConfigFile } from '../configWatch.js';
import { UPGRADE_EXIT_CODE } from '../selfUpdate/handoff.js';
import { installRoot } from '../selfUpdate/buildStanding.js';
import { buildSystem } from '../system.js';
import { installDesktopSkill } from '../validation/desktopSkill.js';
import { buildApp } from './app.js';

// → docs/spec/21-self-update.md#where-the-shutdown-handlers-are-registered

const HANDOFF_GRACE_MS = 250;

async function main(): Promise<void> {
  const config = loadDeploymentConfig();
  const system = buildSystem(config);

  try {
    const reset = system.pets.resetOnce();
    if (reset)
      console.log(`[lubbdubb] vivarium cleared: ${reset.cleared} pet(s) released and the beats start again from zero`);
  } catch (err) {
    system.errors.record({ source: 'server', message: `Vivarium clearance failed: ${(err as Error).message}` });
  }

  const mcpReady = await system.mcp.listen();

  const desktopReady = await system.desktop.listen();
  if (desktopReady) installDesktopSkill(config.validation.desktopSkillPath, system.errors, installRoot());

  const crashed = system.recovery.detect();

  const { app, hub, cockpitUrl, tokenPath } = await buildApp(system);
  await app.listen({ port: config.port, host: config.host });
  console.log(`[lubbdubb] cockpit listening on ${config.host}:${config.port}`);
  if (cockpitUrl) {
    console.log(`[lubbdubb] open the cockpit: ${cockpitUrl}`);
    if (tokenPath) console.log(`[lubbdubb] token minted at ${tokenPath} (0600) — reused on the next start`);
  } else {
    console.log('[lubbdubb] cockpit auth is DISABLED — anyone who can reach this port can queue jobs');
  }
  console.log(`[lubbdubb] heartbeat=${config.heartbeatIntervalMs}ms cap=${config.maxConcurrentAgents}`);
  console.log(`[lubbdubb] agent tools: ${mcpReady ? 'on' : 'unavailable — sentinels only'}`);
  if (desktopReady) {
    const { command, args } = system.desktop.registration();
    console.log(`[lubbdubb] desktop validation channel on — register it in Claude Code once with:`);
    console.log(`[lubbdubb]   claude mcp add --scope user lubbdubb -- ${command} ${args.join(' ')}`);
    console.log(`[lubbdubb] credential at ${system.desktop.credentialPath()} (0600), reminted every start`);
    console.log(`[lubbdubb] /lubbdubb skill installed at ${config.validation.desktopSkillPath}`);
  } else {
    console.log(
      `[lubbdubb] desktop validation channel unavailable — nothing is listening on ${config.validation.desktopSocketPath}; see the error log`,
    );
  }

  const stopConfigWatch = watchConfigFile({
    filePath: system.configFile,
    liveConfig: system.liveConfig,
    errors: system.errors,
    reload: () => loadDeploymentConfig(),
    onChanged: () => hub.broadcast({ type: 'config:changed' }),
  });

  const stopProjectConfigWatch = watchConfigFile({
    filePath: system.projectConfigFile,
    liveConfig: system.liveConfig,
    errors: system.errors,
    reload: () => loadDeploymentConfig(),
    onChanged: () => hub.broadcast({ type: 'config:changed' }),
  });

  const shutdown = (exitCode: number) => async (): Promise<void> => {
    console.log(
      exitCode === UPGRADE_EXIT_CODE ? '\n[lubbdubb] going down for an upgrade...' : '\n[lubbdubb] shutting down...',
    );
    system.harness.stop();
    system.localCycles.stop();
    system.ingressCycles.stop();
    stopConfigWatch();
    stopProjectConfigWatch();
    system.agents.interruptAll();
    system.localRunWatch.stop();
    system.localRun.stopFast('the harness shut down');
    await system.mcp.close();
    await system.desktop.close();
    await app.close();
    system.store.close();
    process.exit(exitCode);
  };
  process.on('SIGINT', shutdown(0));
  process.on('SIGTERM', shutdown(0));
  process.on('SIGHUP', shutdown(0));
  process.on('SIGBREAK', shutdown(0));
  system.updates.onHandoff = () => {
    setTimeout(() => void shutdown(UPGRADE_EXIT_CODE)(), HANDOFF_GRACE_MS);
  };

  const pausedBack = system.updates.restorePause();
  if (pausedBack !== null && pausedBack)
    console.log('[lubbdubb] dispatch is still paused after the upgrade — it was paused before it');

  const upgrade = system.recovery.settleUpgrade();
  system.updates.clearIntent();
  for (const item of upgrade.restored)
    console.log(`[lubbdubb] restored ${item.taskId} (${item.agentId}) after the upgrade — ${item.title}`);
  const held = upgrade.restored.length > 0 ? upgrade.left : crashed;

  if (held.length > 0) {
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

  const interrupted = system.localRun.resumeInterrupted();
  if (interrupted.outcome === 'resumed')
    console.log(
      `[lubbdubb] bringing the local run of ${interrupted.run.originRef} back up at ${interrupted.run.ref} — ` +
        'watch the running-locally panel',
    );
  else if (interrupted.outcome === 'settled')
    console.log(`[lubbdubb] the local run of ${interrupted.run.originRef} did not survive: ${interrupted.reason}`);
  system.localRunWatch.start();

  system.harness.start();
  await system.harness.runCycle('boot');
}

main().catch((err) => {
  console.error('[lubbdubb] fatal:', err);
  process.exit(1);
});
