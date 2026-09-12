import type { Config } from './config.js';
import type { LiveConfig } from './configApply.js';
import { configRevision, readConfigText } from './configFile.js';
import type { ErrorRecorder } from '../errorLog.js';

// → docs/spec/02-configuration.md

interface ConfigWatchDeps {
  filePath: string;
  liveConfig: LiveConfig;
  errors: ErrorRecorder;
  reload: () => Config;
  onChanged: () => void;
  intervalMs?: number;
}

export function watchConfigFile(deps: ConfigWatchDeps): () => void {
  const { filePath, liveConfig, errors, reload, onChanged } = deps;
  let seen = configRevision(readConfigText(filePath));

  const listener = (): void => {
    let revision: string;
    try {
      revision = configRevision(readConfigText(filePath));
    } catch (err) {
      errors.record({ source: 'server', message: `Failed to read ${filePath}: ${(err as Error).message}` });
      return;
    }
    if (revision === seen) return;
    seen = revision;

    let next: Config;
    try {
      next = reload();
    } catch (err) {
      errors.record({
        source: 'server',
        message: `${filePath} changed and could not be loaded, so the harness is still running the config it booted with: ${(err as Error).message}`,
      });
      return;
    }
    if (liveConfig.apply(next).length > 0) onChanged();
  };

  const timer = setInterval(listener, deps.intervalMs ?? 2000);
  timer.unref();
  return () => clearInterval(timer);
}
