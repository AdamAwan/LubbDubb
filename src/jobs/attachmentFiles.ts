import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
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
 * belongs to (`job:<id>` while the blueprint is one), so emptying one directory
 * into another is how the ref changes hands — see {@link AttachmentFiles.relocate},
 * which is what runs when the blueprint becomes a ticket.
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
   * Move `files` out of `fromRef`'s directory and into `toRef`'s, renumbering from
   * `nextIndex`, and return where each landed (issue #249).
   *
   * This is the disk half of the re-key that happens when a blueprint becomes a
   * ticket. Three things it deliberately does:
   *
   * - **Renumbers rather than keeping the stem.** The destination may already hold
   *   images — a filing agent may link to an issue that already exists — and a
   *   fixed stem would silently overwrite them.
   * - **Renames, never copies.** Source and destination are two directories under
   *   one root, so a rename is atomic per file and leaves no window in which the
   *   same bytes exist twice.
   * - **Moves before any row is rewritten**, and the store's own contract says so.
   *   A crash between the two halves then leaves rows naming the old paths — which
   *   still resolve — rather than rows naming paths that do not.
   *
   * A file that is already missing is skipped rather than throwing: the row it
   * belongs to is then re-keyed to a path in the new directory that does not
   * exist, which is exactly as broken as it was before the move and no more.
   */
  relocate(
    fromRef: string,
    toRef: string,
    files: { id: string; path: string }[],
    nextIndex: number,
  ): { id: string; index: number; path: string }[] {
    if (files.length === 0) return [];
    const dir = this.dirFor(toRef);
    mkdirSync(dir, { recursive: true });
    const moved = files.map((file, offset) => {
      const index = nextIndex + offset;
      const path = resolve(dir, `${index}${extname(file.path)}`);
      if (existsSync(file.path)) renameSync(file.path, path);
      return { id: file.id, index, path };
    });
    // The old directory holds nothing anyone points at now. `force` and a
    // recursive remove because a partially-moved directory is still ours to clear.
    rmSync(this.dirFor(fromRef), { recursive: true, force: true });
    return moved;
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
