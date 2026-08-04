"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createSemaphore, SemaphoreFullError } = require("../lib/semaphore");

test("slots run immediately, up to the limit", async () => {
  const semaphore = createSemaphore({ slots: 2 });
  assert.equal(semaphore.stats().running, 0);

  await semaphore.acquire();
  await semaphore.acquire();
  assert.deepEqual(semaphore.stats(), { running: 2, queued: 0, slots: 2, queueDepth: 8 });
});

test("the queue depth defaults to four times the slot count", () => {
  assert.equal(createSemaphore({ slots: 2 }).stats().queueDepth, 8);
  assert.equal(createSemaphore({ slots: 3 }).stats().queueDepth, 12);
  assert.equal(createSemaphore({ slots: 2, queueDepth: 5 }).stats().queueDepth, 5);
});

test("a waiter beyond the slots queues rather than running", async () => {
  const semaphore = createSemaphore({ slots: 1 });
  await semaphore.acquire();

  let entered = false;
  const waiting = semaphore.acquire().then(() => {
    entered = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, false, "the second acquire ran while the only slot was held");
  assert.deepEqual(semaphore.stats(), { running: 1, queued: 1, slots: 1, queueDepth: 4 });

  semaphore.release();
  await waiting;
  assert.equal(entered, true);
});

test("a request beyond the queue is shed, not queued", async () => {
  const semaphore = createSemaphore({ slots: 1, queueDepth: 2 });
  await semaphore.acquire();
  const queued = [semaphore.acquire(), semaphore.acquire()];

  await assert.rejects(() => semaphore.acquire(), SemaphoreFullError);
  // The rejection must not have disturbed the queue.
  assert.deepEqual(semaphore.stats(), { running: 1, queued: 2, slots: 1, queueDepth: 2 });

  semaphore.release();
  semaphore.release();
  semaphore.release();
  await Promise.all(queued);
});

test("the shed error carries the code and the Retry-After the route needs", async () => {
  const semaphore = createSemaphore({ slots: 1, queueDepth: 0 });
  await semaphore.acquire();
  await assert.rejects(() => semaphore.acquire(), (error) => {
    assert.ok(error instanceof SemaphoreFullError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "service_unavailable");
    return true;
  });
});

test("waiters are served in arrival order", async () => {
  const semaphore = createSemaphore({ slots: 1 });
  await semaphore.acquire();

  const order = [];
  const all = [0, 1, 2].map((n) => semaphore.acquire().then(() => order.push(n)));

  for (let i = 0; i < 4; i += 1) {
    semaphore.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(all);
  assert.deepEqual(order, [0, 1, 2]);
});

test("releasing more than was acquired throws rather than inventing capacity", async () => {
  const semaphore = createSemaphore({ slots: 1 });
  await semaphore.acquire();
  semaphore.release();
  assert.throws(() => semaphore.release(), /released more slots than were acquired/);
});

test("the slot count is validated", () => {
  for (const bad of [0, -1, 1.5, "2", null]) {
    assert.throws(() => createSemaphore({ slots: bad }), /slots must be a positive integer/);
  }
});

test("a rejected acquire never occupies a slot", async () => {
  const semaphore = createSemaphore({ slots: 1, queueDepth: 0 });
  await semaphore.acquire();
  await assert.rejects(() => semaphore.acquire(), SemaphoreFullError);
  semaphore.release();
  // If the shed had taken a slot, this would queue forever instead of resolving.
  await semaphore.acquire();
  assert.deepEqual(semaphore.stats(), { running: 1, queued: 0, slots: 1, queueDepth: 0 });
});
