import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type {
  CapabilityContext,
  FixedTextLanguage,
  Logger,
  PatrolTechUrls,
} from '@patroltech/agent-capabilities';
import { z } from 'zod';
import type { AgentSessionProvider } from '../../application/ports/AgentSessionProvider.js';
import type { RateLimiter } from '../../application/ports/RateLimiter.js';
import type { RateLimitRule } from '../../domain/rate-limit/rateLimit.js';
import { DEFAULT_LANGUAGE } from '../../domain/session/preferences.js';
import type { McpCallIdentity } from './mcpRequest.js';
import type { SessionDirectory } from '../../application/ports/SessionDirectory.js';
import type {
  SessionContextLoader,
  UserSessionContext,
} from '../../application/session/sessionContext.js';
import {
  anyOrganization,
  selectOrganization,
} from '../../application/session/selectOrganization.js';
import type { AuditTrail, ToolCallOutcome } from '../../application/ports/AuditTrail.js';
import type { BackendCallTracker } from '../../application/ports/BackendCallTracker.js';
import { envelopeOf, errorResult, successResult } from './envelope.js';
import { writeScopeChallenge } from './scopeChallenge.js';
import { describeThrownFailure, redactedFailure, reportedFailureKind } from './toolFailures.js';
import { isRefusal, type ToolOutcome, type ToolRefusal } from '../../application/ToolOutcome.js';

/** Lecturas: 60 llamadas por minuto por usuario y herramienta. */
export const READ_RATE_LIMIT: RateLimitRule = { limit: 60, windowMs: 60_000 };
/** Herramientas con scope `write` (propuestas, confirmación, hoja de QR): 20 por minuto por usuario y herramienta. */
export const WRITE_RATE_LIMIT: RateLimitRule = { limit: 20, windowMs: 60_000 };

/** Anotaciones de toda lectura: explícitas (los valores por defecto del protocolo son los contrarios). */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const SESSION_EXPIRED_MESSAGE = 'The PatrolTech session expired; retry the request.';

/** Dependencias de módulo de todas las herramientas (una instancia por proceso). */
export interface ToolRuntime {
  rateLimiter: RateLimiter;
  audit: AuditTrail;
  tracker: BackendCallTracker;
  /** Para olvidar la sesión en caché cuando `/api` la rechaza. */
  sessions: Pick<AgentSessionProvider, 'forget'>;
  directory: SessionDirectory;
  urls: Partial<PatrolTechUrls>;
  logger: Logger;
}

/** Lo de ESTA petición que comparten sus herramientas. */
export interface ToolBinding {
  runtime: ToolRuntime;
  /** `undefined` solo si la petición no pasó por la puerta de `/mcp` (no debería ocurrir). */
  identity: McpCallIdentity | undefined;
  loadSession: SessionContextLoader;
}

export interface CapabilityToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /**
   * Qué hace la herramienta, para el texto de sus errores: `read` no cambia nada (sin «No se ha
   * hecho ningún cambio»); `write` es una acción (texto de acción, sin upsell). Va aparte del
   * scope: la hoja de QR pide `write` pero no cambia nada.
   */
  operation: 'read' | 'write';
  /**
   * `'write'`: el SDK responde 403 `insufficient_scope` (pidiendo `read write`) antes de ejecutar si
   * el access token o la sesión de agente (el scope efectivo de la concesión) no lo traen.
   */
  requiredScope?: 'write';
  rateLimit: RateLimitRule;
}

/** Lo que el cuerpo de una herramienta puede pedir durante su ejecución. */
export interface ToolCall {
  readonly identity: McpCallIdentity;
  /** El contexto de sesión del usuario (se construye una vez por petición). */
  session(): Promise<UserSessionContext>;
  /**
   * El `CapabilityContext` para la organización pedida (o la única del usuario), o la negativa
   * accionable si falta o no es suya. Deja la organización anotada para la auditoría.
   */
  capabilityContext(organization?: string): Promise<CapabilityContext | ToolRefusal>;
  /**
   * Para capacidades que solo afectan al usuario (`scope: 'user'`): el contexto con cualquiera de
   * sus organizaciones, sin pedirle que elija; solo sirve para el rol mínimo. La auditoría no la
   * anota: la acción no es de esa organización. Si el usuario la pierde antes de confirmar, la
   * confirmación lo rechaza aunque la acción no dependa de ella (raro; basta con volver a proponer).
   */
  userCapabilityContext(): Promise<CapabilityContext | ToolRefusal>;
}

export type CapabilityToolRun = (
  args: Record<string, unknown>,
  call: ToolCall
) => Promise<ToolOutcome>;

interface CallState {
  organizationId?: string;
  language: FixedTextLanguage;
}

function toolCallFor(binding: ToolBinding, identity: McpCallIdentity, state: CallState): ToolCall {
  const session = async () => {
    const context = await binding.loadSession();
    state.language = context.language;
    return context;
  };
  return {
    identity,
    session,
    async capabilityContext(organization) {
      const context = await session();
      const org = selectOrganization(context.organizations, organization);
      if (isRefusal(org)) return org;
      state.organizationId = org.orgId;
      return { ...context, org };
    },
    async userCapabilityContext() {
      const context = await session();
      const org = anyOrganization(context.organizations);
      if (isRefusal(org)) return org;
      return { ...context, org };
    },
  };
}

/**
 * Registra una herramienta con la envoltura común de seguridad, en este orden: límite de uso
 * por usuario y herramienta → cuerpo (con las llamadas al backend etiquetadas y vigiladas) →
 * 401 de `/api` = sesión caducada (se olvida la sesión en caché) → errores traducidos sin
 * trazas → envoltorio `{ data, truncated?, notices?, note }` con tope de tamaño → una línea
 * de auditoría. `requiredScope: 'write'` añade el reto de scope (`writeScopeChallenge`).
 */
export function registerCapabilityTool(
  server: McpServer,
  binding: ToolBinding,
  spec: CapabilityToolSpec,
  run: CapabilityToolRun
): void {
  const { runtime } = binding;
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: z.object(spec.inputSchema),
      // `annotations.title` repite el título: el directorio de conectores de Claude lo exige
      // dentro de las anotaciones (no le basta el `title` de primer nivel).
      annotations: { ...spec.annotations, title: spec.title },
      ...(spec.requiredScope
        ? { scopeChallenge: writeScopeChallenge(runtime.audit, spec.name) }
        : {}),
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const identity = binding.identity;
      if (!identity) {
        return errorResult('This request is not authenticated.');
      }
      const startedAt = performance.now();
      const state: CallState = { language: DEFAULT_LANGUAGE };
      const finish = (
        result: CallToolResult,
        outcome: ToolCallOutcome,
        errorKind?: string
      ): CallToolResult => {
        runtime.audit.toolCall({
          userId: identity.userId,
          clientId: identity.clientId,
          ...(state.organizationId ? { organizationId: state.organizationId } : {}),
          tool: spec.name,
          args,
          outcome,
          ...(errorKind ? { errorKind } : {}),
          durationMs: performance.now() - startedAt,
          requestId: identity.requestId,
        });
        return result;
      };

      const limit = await runtime.rateLimiter.consume(
        `${identity.userId}:${spec.name}`,
        spec.rateLimit
      );
      if (!limit.allowed) {
        const message = `Too many calls to ${spec.name}. Retry in ${String(limit.retryAfterSec)} seconds.`;
        return finish(errorResult(message), 'refused', 'rate_limited');
      }

      const call = toolCallFor(binding, identity, state);
      const { settled, report } = await runtime.tracker.track(
        { requestId: identity.requestId, clientId: identity.clientId },
        () => run(args, call)
      );

      if (report.sessionRejected) {
        runtime.sessions.forget(identity.accessToken);
        // Un resultado que ya dice qué se hizo antes del 401 (una confirmación a medias) se
        // devuelve tal cual: el mensaje fijo haría creer que no se hizo nada.
        const partial = settled.status === 'fulfilled' ? settled.value : undefined;
        if (
          partial &&
          !isRefusal(partial) &&
          partial.ok &&
          'sessionEnded' in partial &&
          partial.sessionEnded
        ) {
          return finish(successResult(envelopeOf(partial)), 'error', 'session_expired');
        }
        return finish(errorResult(SESSION_EXPIRED_MESSAGE), 'error', 'session_expired');
      }
      if (settled.status === 'rejected') {
        const failure = describeThrownFailure(settled.reason, report, {
          language: state.language,
          urls: runtime.urls,
          operation: spec.operation,
        });
        runtime.logger.error('mcp.tool_failed', {
          tool: spec.name,
          errorKind: failure.kind,
          // El detalle solo va al log (nunca al modelo), y sin los tokens de esta llamada.
          ...redactedFailure(settled.reason, [identity.accessToken, identity.agentSession.token]),
          requestId: identity.requestId,
        });
        return finish(errorResult(failure.message), 'error', failure.kind);
      }

      const outcome = settled.value;
      if (isRefusal(outcome)) {
        return finish(errorResult(outcome.message, outcome.options), 'refused', outcome.reason);
      }
      if (!outcome.ok) {
        return finish(
          errorResult(outcome.error, outcome.opciones, { fromData: true }),
          'error',
          reportedFailureKind(report)
        );
      }
      return finish(successResult(envelopeOf(outcome)), 'ok');
    }
  );
}
