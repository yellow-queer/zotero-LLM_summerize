/**
 * Request timeouts for code running inside Zotero's plugin sandbox.
 *
 * Two facts about that sandbox shape everything below:
 *
 *   1. **There is no `AbortController`.** `xpcom/plugins.js` → `_loadScope()`
 *      builds the plugin scope from an explicit `wantGlobalProperties`
 *      allow-list — `fetch`, `URL`, `Blob`, `crypto`, … are on it,
 *      `AbortController` is not — so `new AbortController()` throws
 *      `ReferenceError` *before* any request is sent, and the whole action dies
 *      with nothing to show for it.
 *
 *   2. **There is no DOM window of our own.** `Services.appShell.hiddenDOMWindow`
 *      looks like the obvious place to borrow one, but it is **macOS-only**.
 *      Zotero's own comment at `plugins.js:502` spells out the priority:
 *      "Use the main window (which we always have on non-macOS), falling back to
 *      the hidden window (which we always have on macOS)." On Windows and Linux
 *      the property getter *throws* `NS_ERROR_FAILURE` rather than returning
 *      null, so even reading it needs a `try`.
 *
 * Hence the rule `withTimeout` is built around: **the timeout must never depend
 * on an `AbortController` existing.** Dropping the socket is best-effort;
 * settling the caller's promise is not.
 */

/** Raised by `withTimeout` when `timeoutMs` elapses first. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`操作超时（${timeoutMs} 毫秒）`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Shape of the constructor as found on a window object. */
type AbortControllerCtor = new () => AbortController;

/**
 * An `AbortController` from whichever realm can supply one, or `null`.
 *
 * Callers must treat `null` as an ordinary outcome, not a failure — see the
 * module comment for why none of the three sources is guaranteed.
 */
export function createAbortController(): AbortController | null {
  // 1. The sandbox global. Absent on every Zotero shipping today, but it is the
  //    natural path should a future release widen the allow-list — and it is the
  //    one the self-test takes, running as it does under Node.
  const fromSandbox = (globalThis as { AbortController?: AbortControllerCtor }).AbortController;
  if (typeof fromSandbox === "function") {
    return new fromSandbox();
  }

  // 2. A real chrome window. `Zotero.getMainWindow()` is
  //    `Services.wm.getMostRecentWindow("navigator:browser")` — a lookup that
  //    returns null when no window is open, and never throws. This is the window
  //    Zotero itself reaches for on Windows and Linux.
  try {
    const ctor = (Zotero.getMainWindow() as unknown as { AbortController?: AbortControllerCtor })
      ?.AbortController;
    if (typeof ctor === "function") {
      return new ctor();
    }
  } catch {
    // No window yet: early startup, or every window closed.
  }

  // 3. The hidden window, which exists precisely so macOS has a DOM window when
  //    no main window does. Accessing it on Windows/Linux throws NS_ERROR_FAILURE
  //    — expected there, not a fault.
  try {
    const ctor = (
      Services?.appShell?.hiddenDOMWindow as { AbortController?: AbortControllerCtor } | undefined
    )?.AbortController;
    if (typeof ctor === "function") {
      return new ctor();
    }
  } catch {
    // Windows/Linux: there is no hidden window to borrow from.
  }

  return null;
}

/**
 * Resolves with `run()`'s value, or rejects with `TimeoutError` once `timeoutMs`
 * has passed.
 *
 * `run` is handed an `AbortSignal` when one could be obtained, so a timed-out
 * request also drops its socket; when none could, the request is simply left to
 * finish unobserved. Either way the caller is unblocked on schedule, which is
 * the part the user actually experiences.
 */
export function withTimeout<T>(
  run: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = createAbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  // `Promise.resolve().then(...)` rather than calling `run` directly: a
  // synchronous throw inside it then reaches the caller as a rejection, instead
  // of escaping past the race and leaving the timer armed.
  const work = Promise.resolve().then(() => run(controller?.signal));

  // The loser of the race may still reject afterwards — a request that timed out
  // often gives up on its own seconds later — and by then nothing is listening.
  // Unhandled, that shows up as a rejection in Zotero's debug log.
  work.catch(() => {});

  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
