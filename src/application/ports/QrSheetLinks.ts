/** Enlace firmado (temporal) al PDF con los QR de los checkpoints de una ubicación. */
export interface QrSheetLink {
  url: string;
  expiresAt: string;
  checkpointCount: number;
  pageCount: number;
}

/** La ubicación no tiene ningún checkpoint terminado con QR que imprimir (o ninguno de los pedidos). */
export class NoPrintableCheckpointsError extends Error {
  constructor() {
    super('No printable QR checkpoint in the location');
    this.name = 'NoPrintableCheckpointsError';
  }
}

/** Hay más checkpoints con QR de los que caben en una hoja. */
export class QrSheetTooLargeError extends Error {
  constructor() {
    super('Too many QR checkpoints for one sheet');
    this.name = 'QrSheetTooLargeError';
  }
}

/**
 * Puerto: pide al backend el enlace a la hoja de QR de una ubicación con el JWT de sesión de
 * agente. Lanza `NoPrintableCheckpointsError` o `QrSheetTooLargeError` cuando la hoja no se puede
 * hacer tal cual; cualquier otro rechazo, como `PatrolTechApiError`.
 */
export interface QrSheetLinks {
  create(
    input: { locationId: string; checkpointIds?: readonly string[] },
    token: string
  ): Promise<QrSheetLink>;
}
