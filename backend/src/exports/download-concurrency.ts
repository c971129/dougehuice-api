export const DEFAULT_EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY = 4;
export const DEFAULT_EXPORT_DOWNLOAD_PER_USER_CONCURRENCY = 2;
export const DEFAULT_EXPORT_DOWNLOAD_READ_TIMEOUT_MILLISECONDS = 60_000;
export const DEFAULT_EXPORT_DOWNLOAD_WRITE_TIMEOUT_MILLISECONDS = 120_000;

export interface ExportDownloadPermit {
  release(): void;
}

/**
 * Process-local, non-queueing admission control for buffered private exports.
 * A deployment-wide limit still needs a distributed lease/semaphore.
 */
export class ExportDownloadConcurrencyGate {
  private activeGlobal = 0;
  private readonly activeByUser = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly perUserLimit: number,
  ) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1) {
      throw new Error("globalLimit must be a positive integer");
    }
    if (!Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > globalLimit) {
      throw new Error("perUserLimit must be a positive integer no greater than globalLimit");
    }
  }

  tryAcquire(userId: string): ExportDownloadPermit | null {
    const activeForUser = this.activeByUser.get(userId) ?? 0;
    if (this.activeGlobal >= this.globalLimit || activeForUser >= this.perUserLimit) return null;
    this.activeGlobal += 1;
    this.activeByUser.set(userId, activeForUser + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeGlobal -= 1;
        const nextForUser = (this.activeByUser.get(userId) ?? 1) - 1;
        if (nextForUser <= 0) this.activeByUser.delete(userId);
        else this.activeByUser.set(userId, nextForUser);
      },
    };
  }
}
