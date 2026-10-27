import {
  agentProposalExecutedRecently,
  cancelAgentProposals,
  claimAgentProposal,
  getAgentProposal,
  getAgentProposalBatch,
  getAgentProposalExecutedRecentlyUrl,
  getCancelAgentProposalsUrl,
  getClaimAgentProposalUrl,
  getGetAgentProposalBatchUrl,
  getGetAgentProposalUrl,
  getGetLiveAgentProposalUrl,
  getLiveAgentProposal,
  getMarkAgentProposalExecutedUrl,
  getMarkAgentProposalFailedUrl,
  getProposeAgentActionsUrl,
  getReopenAgentProposalsUrl,
  markAgentProposalExecuted,
  markAgentProposalFailed,
  proposeAgentActions,
  reopenAgentProposals,
  type AgentProposal,
  type AgentProposalItem,
} from '../patroltech/sdk.js';
import {
  PatrolTechApiError,
  callSdk,
  type PendingAction,
  type PendingActionStore,
  type ProposedItem,
  type SdkCallConfig,
} from '@patroltech/agent-capabilities';
import {
  ProposalParamsTooLargeError,
  ProposalQuotaExceededError,
  ProposalsRateLimitedError,
} from '../../application/ports/proposalStoreErrors.js';
import { backendErrorCode } from '../patroltech/backendErrorCode.js';

export interface HttpPendingActionStoreOptions extends SdkCallConfig {
  /** JWT de sesión de agente del usuario: el backend acota todo por su usuario y su cliente. */
  token: string;
  /**
   * Se llama con el status de cada rechazo del backend que el almacén trata como respuesta
   * prevista (404 = no existe, 409 = ya reclamada…), para que no cuente como fallo en la
   * auditoría (`BackendCallTracker.acknowledge`).
   */
  onExpectedStatus?: (status: number) => void;
}

/** La parte de éxito de una respuesta del SDK (`sdkFetch` lanza en las demás). */
type SuccessData<R> = R extends { status: 200 | 201; data: infer D } ? D : never;
const successData = <R extends { data: unknown }>(response: R) => response.data as SuccessData<R>;

function toPendingAction(p: AgentProposal): PendingAction {
  return {
    id: p.id,
    contextKey: p.contextKey,
    action: p.action,
    params: p.params,
    organizationId: p.organizationId,
    status: p.status,
    idempotencyKey: p.idempotencyKey,
    result: p.result ?? null,
    error: p.error,
    expiresAt: new Date(p.expiresAt),
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
    batchId: p.batchId,
  };
}

function toItem(item: ProposedItem): AgentProposalItem {
  return {
    action: item.action,
    params: item.params as AgentProposalItem['params'],
    organizationId: item.organizationId,
    // El contrato no admite `null`: sin clave, el campo no va.
    ...(item.idempotencyKey ? { idempotencyKey: item.idempotencyKey } : {}),
  };
}

/** El rechazo del backend al guardar un lote, como error tipado si el modelo puede resolverlo. */
function proposeRejection(error: unknown): unknown {
  if (!(error instanceof PatrolTechApiError)) return error;
  const code = backendErrorCode(error);
  if (error.status === 429 && code === 'PROPOSAL_QUOTA_EXCEEDED') {
    return new ProposalQuotaExceededError();
  }
  if (error.status === 429) return new ProposalsRateLimitedError();
  if (error.status === 400 && code === 'PARAMS_TOO_LARGE') return new ProposalParamsTooLargeError();
  return error;
}

/**
 * `PendingActionStore` del paquete sobre `/api/agent-proposals` (SDK oficial), con el JWT de
 * sesión de agente de UN usuario: el backend acota cada consulta y transición por su usuario y su
 * cliente OAuth, así que la clave de otro nunca da acceso a nada. Los ids del modelo van siempre
 * codificados en la ruta.
 */
export class HttpPendingActionStore implements PendingActionStore {
  constructor(private readonly options: HttpPendingActionStoreOptions) {}

  async proposeActions(input: {
    contextKey: string;
    ttlMin: number;
    items: ProposedItem[];
  }): Promise<PendingAction[]> {
    const body = {
      contextKey: input.contextKey,
      ttlMin: input.ttlMin,
      items: input.items.map(toItem),
    };
    const response = await this.call(getProposeAgentActionsUrl(), (init) =>
      proposeAgentActions(body, init)
    ).catch((error: unknown) => {
      throw proposeRejection(error);
    });
    return successData(response).map(toPendingAction);
  }

  async findBatch(contextKey: string, batchId: string): Promise<PendingAction[]> {
    const id = encodeURIComponent(batchId);
    const response = await this.call(getGetAgentProposalBatchUrl(id, { contextKey }), (init) =>
      getAgentProposalBatch(id, { contextKey }, init)
    );
    return successData(response).map(toPendingAction);
  }

  async findProposed(contextKey: string): Promise<PendingAction | undefined> {
    const response = await this.unless([404], () =>
      this.call(getGetLiveAgentProposalUrl({ contextKey }), (init) =>
        getLiveAgentProposal({ contextKey }, init)
      )
    );
    return response && toPendingAction(successData(response));
  }

  async findById(id: string): Promise<PendingAction | undefined> {
    const encoded = encodeURIComponent(id);
    const response = await this.unless([404], () =>
      this.call(getGetAgentProposalUrl(encoded), (init) => getAgentProposal(encoded, init))
    );
    return response && toPendingAction(successData(response));
  }

  async claimForExecution(id: string, contextKey: string): Promise<PendingAction | undefined> {
    const encoded = encodeURIComponent(id);
    // 404 = no es de esta clave (o no existe); 409 = ya en curso, hecha, cancelada o caducada.
    const response = await this.unless([404, 409], () =>
      this.call(getClaimAgentProposalUrl(encoded), (init) =>
        claimAgentProposal(encoded, { contextKey }, init)
      )
    );
    return response && toPendingAction(successData(response));
  }

  async markExecuted(id: string, result: unknown): Promise<void> {
    const encoded = encodeURIComponent(id);
    await this.call(getMarkAgentProposalExecutedUrl(encoded), (init) =>
      markAgentProposalExecuted(encoded, { result }, init)
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    const encoded = encodeURIComponent(id);
    await this.call(getMarkAgentProposalFailedUrl(encoded), (init) =>
      markAgentProposalFailed(encoded, { error }, init)
    );
  }

  async reopenProposed(ids: readonly string[], ttlMin: number): Promise<void> {
    if (ids.length === 0) return;
    await this.call(getReopenAgentProposalsUrl(), (init) =>
      reopenAgentProposals({ ids: [...ids], ttlMin }, init)
    );
  }

  async cancelProposed(contextKey: string): Promise<PendingAction | undefined> {
    const response = await this.unless([404], () =>
      this.call(getCancelAgentProposalsUrl(), (init) => cancelAgentProposals({ contextKey }, init))
    );
    return response && toPendingAction(successData(response));
  }

  async executedRecently(contextKey: string, withinMin: number): Promise<boolean> {
    const params = { contextKey, withinMin };
    const response = await this.call(getAgentProposalExecutedRecentlyUrl(params), (init) =>
      agentProposalExecutedRecently(params, init)
    );
    return successData(response).executed;
  }

  private call<R>(path: string, fn: Parameters<typeof callSdk<R>>[3]): Promise<R> {
    return callSdk(this.options, this.options.token, path, fn);
  }

  /** `undefined` en vez de lanzar cuando el backend responde con uno de esos estados (previstos). */
  private async unless<T>(
    statuses: readonly number[],
    call: () => Promise<T>
  ): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof PatrolTechApiError && statuses.includes(error.status)) {
        this.options.onExpectedStatus?.(error.status);
        return undefined;
      }
      throw error;
    }
  }
}
