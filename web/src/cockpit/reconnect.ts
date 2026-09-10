// → docs/spec/17-cockpit.md#data-flow

/**
 * Answers whether a status is the socket coming *back* after a drop. The first open is not one —
 * the mount fetch has already read everything — so only a reconnect asks for a re-read.
 */
export function reconnectWatch(): (connected: boolean) => boolean {
  let dropped = false;
  return (connected) => {
    if (!connected) {
      dropped = true;
      return false;
    }
    const back = dropped;
    dropped = false;
    return back;
  };
}
