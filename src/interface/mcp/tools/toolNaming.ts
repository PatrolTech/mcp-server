export const TOOL_NAME_PREFIX = 'patroltech_';
/** Límite de los clientes (Claude, ChatGPT) para el nombre de una herramienta. */
export const MAX_TOOL_NAME_LENGTH = 64;

const CATALOG_ID = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * Nombre MCP de una capacidad del catálogo: `patroltech_` + su id con `.` → `_`
 * (`rounds.get_status` → `patroltech_rounds_get_status`). Lanza si el id no da un nombre
 * válido: es un error de programación del catálogo, no algo a tolerar en tiempo de ejecución.
 */
export function toolNameFor(catalogId: string): string {
  if (!CATALOG_ID.test(catalogId)) {
    throw new Error(`Catalog id cannot become a tool name: ${catalogId}`);
  }
  const name = `${TOOL_NAME_PREFIX}${catalogId.replaceAll('.', '_')}`;
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    throw new Error(`Tool name longer than ${String(MAX_TOOL_NAME_LENGTH)} characters: ${name}`);
  }
  return name;
}
