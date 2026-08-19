import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PreparedAttachment } from './attachments.js';

/** What a stored file is, once written: where it landed and how big it was. */
interface StoredAttachment extends PreparedAttachment {
  /** Absolute path to the file — what an agent is handed, and what the row records. */
  path: string;
}

/**
 * Where a blueprint's images live on disk (issue #249).
 *
 * **One canonical file, outside every worktree.** The alternative — a copy into
 * each dispatched agent's cwd — was considered and rejected: it risks a
 * screenshot being committed onto a branch, and it duplicates the file once per
 * agent on a goal that may have a planner, several part agents and a retro. One
 * file under a config'd root, plus a `permissions.additionalDirectories` grant on
 * the launch, is what makes the same image readable by all of them.
 *
 * **A directory per target ref, not per file.** The ref is what an attachment
 * belongs to — `job:<id>` for a blueprint that dispatches, `issue:<n>` for one
 * the harness files as a ticket instead (issue #394), which is what makes the
 * image the *goal's* rather than one agent's.
 */
export class AttachmentFiles {
  constructor(private readonly root: string) {}

  /** The directory holding one target's files. `:` is not path-safe on Windows. */
  dirFor(targetRef: string): string {
    return join(this.root, targetRef.replace(/[^A-Za-z0-9_-]+/g, '_'));
  }

  /**
   * Write the prepared files under `targetRef`, returning where each landed.
   *
   * The stem is the index and the extension is the *sniffed* format — the
   * client's filename reaches neither, which is what makes a traversal attempt
   * (`../../etc/x.png`) a label nobody resolves rather than a path to sanitise.
   */
  write(targetRef: string, files: PreparedAttachment[]): StoredAttachment[] {
    if (files.length === 0) return [];
    const dir = this.dirFor(targetRef);
    mkdirSync(dir, { recursive: true });
    return files.map((file) => {
      const path = resolve(dir, `${file.index}.${file.ext}`);
      writeFileSync(path, file.data);
      return { ...file, path };
    });
  }

  /**
   * Drop a target's files — a blueprint cancelled before it ran, which is the one
   * case nothing downstream can want them. `force` because the directory is absent
   * for the overwhelmingly common blueprint that carried no image at all.
   */
  remove(targetRef: string): void {
    rmSync(this.dirFor(targetRef), { recursive: true, force: true });
  }
}
