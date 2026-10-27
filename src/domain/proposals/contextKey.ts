import { createHash } from 'node:crypto';

/**
 * La `contextKey` de las propuestas de un usuario en un cliente OAuth: `mcp:<userId>:<32 hex>`,
 * con los 32 primeros hex del sha256 del `clientId` (acota la longitud sea cual sea el id del
 * cliente y nunca acaba en espacio). El backend ya acota por usuario y cliente; la clave separa
 * además el canal (`mcp:`) y deja un solo lote vivo por usuario y cliente.
 */
export function proposalContextKey(userId: string, clientId: string): string {
  const client = createHash('sha256').update(clientId).digest('hex').slice(0, 32);
  return `mcp:${userId}:${client}`;
}
