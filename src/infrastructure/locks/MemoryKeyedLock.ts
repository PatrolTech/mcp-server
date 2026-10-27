import type { KeyedLock, LockedRun } from '../../application/ports/KeyedLock.js';

/** Espera máxima por defecto a que termine el anterior de la misma clave. */
export const DEFAULT_LOCK_WAIT_MS = 10_000;

/**
 * Exclusión por clave en la memoria del proceso: una cola de promesas por clave. Solo es el
 * respaldo cuando no hay Redis (con varios workers deja de ser global) y la versión de los tests.
 */
export class MemoryKeyedLock implements KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waitMs: number;

  constructor(options: { waitMs?: number } = {}) {
    this.waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  }

  async run<T>(key: string, body: () => Promise<T>): Promise<LockedRun<T>> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // El siguiente espera a este Y a los anteriores (si este se rinde, sigue esperándolos).
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);

    let timer: NodeJS.Timeout | undefined;
    const turn = await Promise.race([
      previous.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, this.waitMs);
      }),
    ]);
    clearTimeout(timer);

    const done = () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    if (!turn) {
      void previous.then(done);
      return { acquired: false };
    }
    try {
      return { acquired: true, value: await body() };
    } finally {
      done();
    }
  }
}
