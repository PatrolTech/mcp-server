export type ToolCallOutcome = 'ok' | 'error' | 'refused';

/** Una llamada a una herramienta, tal como la recibe el puerto de auditoría. */
export interface ToolCallRecord {
  userId: string;
  clientId: string;
  organizationId?: string;
  tool: string;
  /** Los argumentos tal cual: el adaptador SOLO puede registrar su hash, nunca el valor. */
  args: unknown;
  outcome: ToolCallOutcome;
  errorKind?: string;
  durationMs: number;
  requestId: string;
}

/** Puerto: deja constancia de cada llamada a una herramienta. */
export interface AuditTrail {
  toolCall(record: ToolCallRecord): void;
}
