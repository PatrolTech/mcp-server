import { createHash } from 'node:crypto';
import type { AuditTrail, ToolCallRecord } from '../../application/ports/AuditTrail.js';
import type { ServiceLogger } from '../logging/logger.js';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

/** JSON con las claves ordenadas a todos los niveles: los mismos argumentos dan el mismo texto. */
export function canonicalJson(value: unknown): string {
  // `JSON.stringify(undefined)` es `undefined` en tiempo de ejecución, aunque el tipo diga string.
  const text = JSON.stringify(canonicalValue(value)) as string | undefined;
  return text ?? 'null';
}

/** sha256 (hex) del JSON canónico de los argumentos. */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

/**
 * Auditoría como una línea JSON por llamada (`event: 'mcp.tool_call'`) en el canal `always` del
 * logger del servicio (se escribe sea cual sea LOG_LEVEL), para el colector de logs. Los argumentos solo
 * salen como hash: pueden llevar texto del usuario o datos personales.
 */
export class LoggerAuditTrail implements AuditTrail {
  constructor(private readonly logger: Pick<ServiceLogger, 'always'>) {}

  toolCall(record: ToolCallRecord): void {
    const { args, organizationId, errorKind, durationMs, ...rest } = record;
    this.logger.always('mcp.tool_call', {
      event: 'mcp.tool_call',
      userId: rest.userId,
      clientId: rest.clientId,
      ...(organizationId ? { organizationId } : {}),
      tool: rest.tool,
      argsHash: argsHash(args),
      outcome: rest.outcome,
      ...(errorKind ? { errorKind } : {}),
      durationMs: Math.round(durationMs),
      requestId: rest.requestId,
    });
  }
}
