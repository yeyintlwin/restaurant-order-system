"use strict";

// PURE (Tier 1): no database, no filesystem, no network, no clock. The queue is
// in-process state, which is correct -- it bounds THIS process's CPU, and there
// is exactly one replica.
//
// Why shedding rather than queueing without limit: scrypt is the only CPU-bound
// path in the service and it is reachable from two unauthenticated routes. A
// queue that grows without bound converts a CPU limit into a timeout storm, in
// which every caller waits and then fails anyway.

class SemaphoreFullError extends Error {
  constructor() {
    super("service_unavailable");
    this.name = "SemaphoreFullError";
    // Shaped so a route can rethrow it untouched: http/respond.js reads only
    // `status` and `code`, and adds Retry-After: 5 for any 503.
    this.status = 503;
    this.code = "service_unavailable";
  }
}

function createSemaphore({ slots, queueDepth } = {}) {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`createSemaphore: slots must be a positive integer, got ${JSON.stringify(slots)}`);
  }
  const depth = queueDepth === undefined ? slots * 4 : queueDepth;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(
      `createSemaphore: queueDepth must be a non-negative integer, got ${JSON.stringify(queueDepth)}`
    );
  }

  let running = 0;
  const waiters = [];

  function acquire() {
    if (running < slots) {
      running += 1;
      return Promise.resolve();
    }
    if (waiters.length >= depth) {
      // Reject BEFORE touching `running`, so a shed request never consumes the
      // capacity it was denied.
      return Promise.reject(new SemaphoreFullError());
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    if (running === 0) {
      throw new Error("semaphore: released more slots than were acquired");
    }
    const next = waiters.shift();
    if (next === undefined) {
      running -= 1;
      return;
    }
    // The slot transfers directly to the waiter: `running` does not dip, so a
    // third caller arriving in this tick cannot slip past the limit.
    next();
  }

  function stats() {
    return { running, queued: waiters.length, slots, queueDepth: depth };
  }

  return { acquire, release, stats };
}

module.exports = { createSemaphore, SemaphoreFullError };
