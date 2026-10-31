import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { CatalogAction, PendingActionStore } from '@patroltech/agent-capabilities';
import { proposalContextKey } from '../../../domain/proposals/contextKey.js';
import type { McpCallIdentity } from '../mcpRequest.js';
import type { KeyedLock } from '../../../application/ports/KeyedLock.js';
import type {
  ProposableAction,
  ProposalDeps,
} from '../../../application/proposals/ProposalDeps.js';
import type { QrSheetLinks } from '../../../application/ports/QrSheetLinks.js';
import type { ToolBinding } from '../registerCapabilityTool.js';
import { toolNameFor } from './toolNaming.js';

/** Dependencias de módulo de las herramientas con scope `write` (una instancia por proceso). */
export interface WriteToolDeps {
  /** El almacén de propuestas con el JWT de sesión de agente de un usuario. */
  stores: (token: string) => PendingActionStore;
  lock: KeyedLock;
  qrSheets: QrSheetLinks;
  ttlMin: number;
}

/** Proponer: no cambia nada en la cuenta, pero cada llamada añade otra propuesta al lote. */
export const PROPOSE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Confirmar ejecuta los cambios del lote: lo que el cliente debe confirmar con el usuario. */
export const CONFIRM_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Cancelar descarta un lote pendiente: no toca la cuenta, pero las propuestas se pierden y no se
 * recuperan (habría que volver a proponerlas), así que se declara destructiva para que el cliente
 * lo confirme. Repetirlo no cambia nada más.
 */
export const CANCEL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** La hoja de QR emite un enlace nuevo en cada llamada; no cambia nada de la cuenta. */
export const QR_SHEET_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Las acciones del catálogo `mcp` por su `nombre`, con el nombre de su herramienta. */
export function proposableActions(
  actions: readonly CatalogAction[]
): ReadonlyMap<string, ProposableAction> {
  return new Map(
    actions.map(({ meta, action }) => [
      action.nombre,
      { toolName: toolNameFor(meta.id), definition: action },
    ])
  );
}

/** Quien propone o confirma, tal como lo citan las acciones (su nombre, o su id si no lo hay). */
export function actingUser(identity: McpCallIdentity): { id: string; name: string } {
  return { id: identity.userId, name: identity.agentSession.userName ?? identity.userId };
}

/** Las dependencias de propuesta de ESTE usuario y cliente OAuth, con su JWT de sesión. */
export function proposalDepsFor(
  binding: ToolBinding,
  writes: WriteToolDeps,
  actions: ReadonlyMap<string, ProposableAction>,
  identity: McpCallIdentity,
  token: string
): ProposalDeps {
  return {
    store: writes.stores(token),
    lock: writes.lock,
    contextKey: proposalContextKey(identity.userId, identity.clientId),
    actions,
    ttlMin: writes.ttlMin,
    urls: binding.runtime.urls,
    logger: binding.runtime.logger,
  };
}
