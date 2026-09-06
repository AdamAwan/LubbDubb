// → docs/spec/15-integrations.md

const MAX_ENTRIES = 256;

const MAX_BODY_BYTES = 512 * 1024;

export class AzureEtagCache {
  private readonly entries = new Map<string, { etag: string; body: string }>();

  constructor(private readonly max = MAX_ENTRIES) {}

  get(url: string): { etag: string; body: string } | undefined {
    const hit = this.entries.get(url);
    if (hit) {
      this.entries.delete(url);
      this.entries.set(url, hit);
    }
    return hit;
  }

  set(url: string, etag: string, body: string): void {
    if (body.length > MAX_BODY_BYTES) return;
    this.entries.delete(url);
    this.entries.set(url, { etag, body });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
