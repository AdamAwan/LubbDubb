import type { Config } from './config.js';
import type { LiveConfig } from './configApply.js';
import { configRevision, readConfigText } from './configFile.js';
import type { ErrorRecorder } from './errorLog.js';

/**
 * The half of the config page that is not a page: the file, watched.
 *
 * "The project creator still likes to edit config.json" is only true if editing
 * it does what the form does. So a change on disk lands on the same
 * {@link LiveConfig.apply} a save lands on — live keys through their arms,
 * everything else held as pending and reported — and the two cannot produce
 * different outcomes because there is only one path to produce them with.
 *
 * It polls the file's *content* rather than watching it. `fs.watch` binds to an
 * inode, and an editor that writes through a temp file and a rename replaces it —
 * the handle then goes quiet with nothing to say it has. `fs.watchFile` keeps the
 * path but takes its own baseline stat asynchronously, so an edit that lands
 * between starting the watch and that first stat is absorbed into the baseline
 * and never reported. Comparing the bytes to what the harness is running has
 * neither hole, and costs one read of a two-kilobyte file every couple of seconds
 * against a harness whose resting state is an agent fleet.
 *
 * → `docs/spec/02-configuration.md#the-watcher`
 */
interface ConfigWatchDeps {
  filePath: string;
  liveConfig: LiveConfig;
  errors: ErrorRecorder;
  /**
   * Re-run the loader. Injected rather than called directly so a test can drive
   * this without a `lubbdubb.config.json` beside the suite — the same reason
   * `loadConfig` and `loadDeploymentConfig` are two functions.
   */
  reload: () => Config;
  /** Told when something actually changed, so open cockpits re-read. */
  onChanged: () => void;
  /** Poll interval. Left alone outside tests. */
  intervalMs?: number;
}

/**
 * Watch the config file. Returns the stop.
 *
 * A parse failure or a validation throw is **recorded and dropped**: the running
 * config is left exactly as it was. A half-typed file is a normal thing to
 * observe — the operator is mid-keystroke — and a watcher that applied one would
 * take the fleet down over a missing brace.
 */
export function watchConfigFile(deps: ConfigWatchDeps): () => void {
  const { filePath, liveConfig, errors, reload, onChanged } = deps;
  // What the harness is running on, so a touched-but-unchanged file (every `:w`
  // that saved nothing, every `stat` the poll notices) does no work and says
  // nothing.
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
  // The harness must not be held open by its own config watch.
  timer.unref();
  return () => clearInterval(timer);
}
