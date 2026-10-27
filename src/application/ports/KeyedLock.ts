export type LockedRun<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Puerto: ejecuta `body` en exclusiva para `key` (como mucho uno a la vez, de todos los workers).
 * El backend guarda UN lote vivo por `contextKey` y proponer sustituye al anterior: sin exclusión,
 * dos propuestas en paralelo (los modelos llaman herramientas en paralelo) leerían el mismo lote
 * y la segunda borraría la primera. `acquired: false` = no se consiguió a tiempo (no se ejecutó).
 */
export interface KeyedLock {
  run<T>(key: string, body: () => Promise<T>): Promise<LockedRun<T>>;
}
