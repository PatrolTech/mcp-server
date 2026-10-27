/**
 * Rechazos del almacén de propuestas al guardar un lote que el modelo puede resolver (o esperar).
 * Los lanza el adaptador del almacén (`proposeActions`), traducidos de la respuesta del backend:
 * la aplicación no mira status HTTP ni códigos de error.
 */

/** Se ha agotado la cuota diaria de propuestas de la cuenta. */
export class ProposalQuotaExceededError extends Error {
  constructor() {
    super('The daily quota of proposals is exhausted');
    this.name = 'ProposalQuotaExceededError';
  }
}

/** Demasiadas propuestas en poco tiempo: hay que esperar. */
export class ProposalsRateLimitedError extends Error {
  constructor() {
    super('Too many proposals in a short time');
    this.name = 'ProposalsRateLimitedError';
  }
}

/** Los parámetros de un cambio son demasiado largos para guardarlos. */
export class ProposalParamsTooLargeError extends Error {
  constructor() {
    super('The params of a proposal are too large to store');
    this.name = 'ProposalParamsTooLargeError';
  }
}
