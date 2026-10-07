import { test, describe, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { Utils, createWorkerSleep, TimerWorkerLike } from "..";

/** Behaves like the real timer worker: runs setTimeout and answers with the message id. */
class FakeTimerWorker implements TimerWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  received: { id: number; ms: number }[] = [];
  terminated = false;

  postMessage(message: { id: number; ms: number }): void {
    this.received.push(message);
    setTimeout(() => this.onmessage?.({ data: message.id }), message.ms);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Never answers, so we can check what happens when the worker breaks. */
class SilentWorker extends FakeTimerWorker {
  override postMessage(message: { id: number; ms: number }): void {
    this.received.push(message);
  }
}

describe("Worker sleep", () => {
  test("delegates delays to the worker and resolves on its reply", async () => {
    const worker = new FakeTimerWorker();
    const sleep = createWorkerSleep(() => worker);

    const start = Date.now();
    const result = await sleep(30);

    strictEqual(result, undefined);
    ok(Date.now() - start >= 25);
    strictEqual(worker.received.length, 1);
    strictEqual(worker.received[0].ms, 30);
  });

  test("creates the worker lazily and only once", async () => {
    let created = 0;
    const sleep = createWorkerSleep(() => {
      created++;
      return new FakeTimerWorker();
    });

    strictEqual(created, 0);
    await sleep(1);
    await sleep(1);
    strictEqual(created, 1);
  });

  test("handles concurrent delays independently", async () => {
    const worker = new FakeTimerWorker();
    const sleep = createWorkerSleep(() => worker);
    const order: number[] = [];

    await Promise.all([
      sleep(40).then(() => order.push(40)),
      sleep(10).then(() => order.push(10)),
      sleep(25).then(() => order.push(25)),
    ]);

    strictEqual(order.join(","), "10,25,40");
  });

  test("zero delay does not need the worker", async () => {
    const worker = new FakeTimerWorker();
    const sleep = createWorkerSleep(() => worker);

    await sleep(0);
    strictEqual(worker.received.length, 0);
  });

  test("falls back to setTimeout when no worker is available", async () => {
    const sleep = createWorkerSleep(() => undefined);
    const start = Date.now();
    await sleep(20);
    ok(Date.now() - start >= 15);
  });

  test("falls back to setTimeout when the factory throws", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const sleep = createWorkerSleep(() => {
        throw new Error("blocked by CSP");
      });
      const start = Date.now();
      await sleep(20);
      ok(Date.now() - start >= 15);
    } finally {
      console.warn = warn;
    }
  });

  test("worker error terminates it, pending delays still finish and later delays use setTimeout", async () => {
    const worker = new SilentWorker();
    const sleep = createWorkerSleep(() => worker);

    const start = Date.now();
    const pending = sleep(20);
    worker.onerror?.({});
    await pending;

    ok(Date.now() - start >= 15, "pending delay must not finish early");
    strictEqual(worker.terminated, true);

    await sleep(5);
    strictEqual(worker.received.length, 1, "worker must not be used after it failed");
  });
});

describe("Utils.sleep", () => {
  afterEach(() => Utils.setSleepImplementation());

  test("works without a browser (setTimeout fallback)", async () => {
    const start = Date.now();
    await Utils.sleep(20);
    ok(Date.now() - start >= 15);
  });

  test("can be replaced and restored", async () => {
    const calls: number[] = [];
    Utils.setSleepImplementation(async (ms) => {
      calls.push(ms);
      return undefined;
    });

    await Utils.sleep(1234);
    strictEqual(calls.join(","), "1234");

    Utils.setSleepImplementation();
    const start = Date.now();
    await Utils.sleep(15);
    ok(Date.now() - start >= 10);
    strictEqual(calls.length, 1);
  });
});
