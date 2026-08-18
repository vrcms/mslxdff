// In-memory event bus for live debugging: routes.js emits, -debug streams
// over HTTP. Keeps a small ring buffer so late subscribers can catch up.

const MAX_BUFFERED = 500;

export function createEventBus() {
  let buffer = [];
  const listeners = new Set();

  return {
    // emit an event to every current subscriber (sync, never throws)
    emit(event) {
      buffer.push(event);
      if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
      for (const fn of listeners) {
        try {
          fn(event);
        } catch {
          // subscriber errors must never break the request path
        }
      }
    },
    // subscribe; returns an unsubscribe fn
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // buffered events since start (or from offset), consumed left-to-right
    replay({ since = 0 } = {}) {
      return buffer.slice(since);
    },
    replayAll() {
      return buffer.slice();
    },
    size() {
      return buffer.length;
    },
  };
}