import type { ToolResult } from '@patroltech/agent-capabilities';

/**
 * La herramienta no llega a consultar nada porque la petición no se puede atender tal cual
 * (organización ambigua, límite de uso…): el modelo recibe un `isError` accionable y la
 * auditoría registra `outcome: 'refused'` con `reason` como `errorKind`.
 */
export interface ToolRefusal {
  refused: true;
  reason: string;
  message: string;
  options?: string[];
}

export function refuse(reason: string, message: string, options?: string[]): ToolRefusal {
  return { refused: true, reason, message, ...(options && options.length > 0 ? { options } : {}) };
}

export function isRefusal(value: unknown): value is ToolRefusal {
  return typeof value === 'object' && value !== null && 'refused' in value;
}

/**
 * Un resultado correcto con, opcionalmente, el siguiente paso para el modelo: va FUERA de `data`
 * (que es dato, nunca instrucción) en el envoltorio.
 */
export type ToolSuccess = Extract<ToolResult<unknown>, { ok: true }> & {
  next?: string;
  /**
   * La sesión de agente caducó (401) durante la herramienta, pero el resultado dice qué se hizo
   * hasta entonces: la envoltura olvida la sesión y lo devuelve en vez del mensaje fijo.
   */
  sessionEnded?: boolean;
};

/** Un resultado correcto con el siguiente paso para el modelo (y avisos nuestros, si los hay). */
export function okWithNext(data: unknown, next: string, avisos: string[] = []): ToolSuccess {
  return { ok: true, data, next, ...(avisos.length > 0 ? { avisos } : {}) };
}

/** Lo que devuelve el cuerpo de una herramienta: el `ToolResult` de la capacidad o una negativa. */
export type ToolOutcome = ToolResult<unknown> | ToolSuccess | ToolRefusal;
