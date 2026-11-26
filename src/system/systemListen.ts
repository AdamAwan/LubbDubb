import { AutoSend } from '../listen/autoSend.js';
import { openPrs } from '../server/askReads.js';
import { cycleRan } from '../harness.js';
import type { System } from './system.js';

export { Listener } from '../listen/listener.js';

// → docs/spec/44-needs-you.md#sending-by-itself

export function wireAutoSend(system: System): void {
  const autoSend = new AutoSend(system.listener, () => system.config.listen);
  system.harness.on('cycle:end', (report) => {
    if (!cycleRan(report)) return;
    try {
      autoSend.observe(() => openPrs(system));
    } catch (err) {
      system.errors.record({ source: 'cycle', message: `Listen auto-send failed: ${(err as Error).message}` });
    }
  });
}
