/**
 * Function that resolves after (at least) the given number of milliseconds.
 *
 * @category Helpers
 */
export type SleepFn = (ms: number) => Promise<undefined>;

/**
 * Minimal subset of the Web Worker API used by {@link createWorkerSleep}.
 * Exists so the timer can be tested without a browser.
 *
 * @category Helpers
 */
export interface TimerWorkerLike {
  postMessage(message: { id: number; ms: number }): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const WORKER_SOURCE = `
self.onmessage = function (e) {
  var id = e.data.id;
  setTimeout(function () { self.postMessage(id); }, e.data.ms);
};
`;

const timeoutSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a Web Worker that runs timers for us, or `undefined` outside of a browser main thread.
 *
 * Browsers throttle `setTimeout` on hidden pages (a 10 ms timer may fire after ~1 s or more),
 * but timers inside a dedicated worker are not throttled that way.
 */
const createBrowserTimerWorker = (): TimerWorkerLike | undefined => {
  if (
    typeof document === "undefined" || // Node.js, or already inside a worker (timers are not throttled there)
    typeof Worker === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return undefined;
  }

  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url);

  // The blob URL is only needed until the worker script has been loaded,
  // and the worker answers its first message only after that.
  worker.addEventListener("message", () => URL.revokeObjectURL(url), { once: true });
  worker.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });

  return worker as unknown as TimerWorkerLike;
};

/**
 * Create a sleep function that runs `setTimeout` inside a Web Worker, so delays are not
 * stretched when the browser tab is in the background.
 *
 * The worker is created on first use. If it can't be created (not a browser, CSP forbids blob workers, etc.)
 * or it fails later, plain `setTimeout` is used. In that case a delay can only become longer, never shorter.
 *
 * @param createWorker Worker factory, replaceable for testing.
 *
 * @category Helpers
 */
export const createWorkerSleep = (createWorker: () => TimerWorkerLike | undefined = createBrowserTimerWorker): SleepFn => {
  let worker: TimerWorkerLike | undefined;
  let initialized = false;
  let nextId = 0;
  const pending = new Map<number, { resolve: () => void; ms: number }>();

  const disableWorker = () => {
    const stuck = [...pending.values()];
    pending.clear();

    try {
      worker?.terminate();
    } catch {
      // ignore
    }
    worker = undefined;

    // Don't leave anyone hanging: restart their delay with the regular timer.
    for (const { resolve, ms } of stuck) {
      setTimeout(resolve, ms);
    }
  };

  const init = () => {
    initialized = true;

    try {
      worker = createWorker();
    } catch (e) {
      console.warn("Worker timer is unavailable, falling back to setTimeout:", e);
      worker = undefined;
    }

    if (worker) {
      worker.onmessage = (event) => {
        const entry = pending.get(event.data as number);
        if (entry) {
          pending.delete(event.data as number);
          entry.resolve();
        }
      };
      worker.onerror = disableWorker;
    }
  };

  return (ms: number): Promise<undefined> => {
    if (!initialized) {
      init();
    }

    if (worker === undefined || !(ms > 0)) {
      return timeoutSleep(ms);
    }

    const w = worker;

    return new Promise<undefined>((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve: () => resolve(undefined), ms });

      try {
        w.postMessage({ id, ms });
      } catch {
        disableWorker();
      }
    });
  };
};
