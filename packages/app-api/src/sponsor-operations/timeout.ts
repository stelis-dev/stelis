/**
 * [app-api] Sponsor operations bounded-probe helper.
 *
 * Timeout budget names, units, and required-env semantics live in
 * `docs/parameters.md` under sponsor operation environment variables. There are no code-side
 * numeric defaults for these budgets.
 */

export class SponsorOperationsTimeoutError extends Error {
  readonly operation: string;
  readonly budgetMs: number;

  constructor(operation: string, budgetMs: number) {
    super(`sponsor operation '${operation}' exceeded timeout budget ${budgetMs}ms`);
    this.name = 'SponsorOperationsTimeoutError';
    this.operation = operation;
    this.budgetMs = budgetMs;
  }
}

/**
 * Run `task` with a bounded time budget. Rejects with `SponsorOperationsTimeoutError`
 * when the budget elapses before `task` settles; otherwise propagates the
 * task's resolved value or its rejection unchanged.
 *
 * Contract lock:
 * - `budgetMs` must be a finite positive number; non-conforming input throws
 *   synchronously-via-promise with a descriptive `Error`, never returns a
 *   resolved value.
 * - The internal timer is always cleared on settlement (resolve, reject, or
 *   timeout) so no dangling handle survives the call.
 * - The timer is unref'd so it never keeps the Node event loop alive.
 */
export async function withTimeout<T>(
  operation: string,
  budgetMs: number,
  task: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
    throw new Error(
      `withTimeout: budgetMs must be a positive safe integer, got ${String(budgetMs)}`,
    );
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new SponsorOperationsTimeoutError(operation, budgetMs));
      }, budgetMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      task().then(resolve, reject);
    });
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
