import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PreparedAttachment } from './attachments.js';

// → docs/spec/13-jobs-and-tickets.md

interface StoredAttachment extends PreparedAttachment {
  path: string;
}

export class AttachmentFiles {
  constructor(private readonly root: string) {}

  dirFor(targetRef: string): string {
    return join(this.root, targetRef.replace(/[^A-Za-z0-9_-]+/g, '_'));
  }

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

  remove(targetRef: string): void {
    rmSync(this.dirFor(targetRef), { recursive: true, force: true });
  }
}
