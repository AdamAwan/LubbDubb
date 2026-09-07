// → docs/spec/09-execution.md

const queues = new Map<string, Promise<unknown>>();

export function runSerial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const tail = queues.get(key) ?? Promise.resolve();
  const next = tail.then(work, work);
  queues.set(key, next);
  void next
    .catch(() => undefined)
    .then(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  return next;
}
