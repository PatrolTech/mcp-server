interface ArrayLocation {
  array: unknown[];
  size: number;
}

const serializedSize = (value: unknown[]): number => JSON.stringify(value).length;

/** El array no vacío más pesado (serializado) de todo el valor, el propio valor incluido. */
function largestArray(value: unknown): ArrayLocation | undefined {
  let best: ArrayLocation | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      const size = serializedSize(node);
      if (node.length > 0 && (!best || size > best.size)) best = { array: node, size };
      node.forEach(visit);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return best;
}

export interface FitOptions<T> {
  maxSize: number;
  /** Tamaño de lo que se enviará con este candidato (p. ej. el envoltorio entero serializado). */
  measure: (candidate: T | null) => number;
}

/**
 * Recorta el valor hasta que `measure` quede dentro de `maxSize` quitando elementos del FINAL
 * del array más pesado (las listas llegan ordenadas por relevancia: lo primero se conserva),
 * una y otra vez. Si ya no queda nada que recortar y sigue sin caber, devuelve `null`. No
 * modifica la entrada.
 */
export function fitToSize<T>(
  value: T,
  { maxSize, measure }: FitOptions<T>
): { value: T | null; truncated: boolean } {
  if (measure(value) <= maxSize) return { value, truncated: false };

  const copy = structuredClone(value);
  for (;;) {
    const target = largestArray(copy);
    if (!target) {
      return { value: null, truncated: true };
    }
    const perItem = Math.max(1, target.size / target.array.length);
    // Cuántos elementos sobran aproximadamente; al menos uno por vuelta, así siempre progresa.
    const excess = Math.max(1, Math.ceil((measure(copy) - maxSize) / perItem));
    target.array.splice(Math.max(0, target.array.length - excess));
    if (measure(copy) <= maxSize) {
      return { value: copy, truncated: true };
    }
  }
}
