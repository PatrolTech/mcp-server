/**
 * Único punto de entrada a las operaciones del SDK HTTP de PatrolTech que el conector llama por su
 * cuenta (el resto las llama `@patroltech/agent-capabilities`): las propuestas de agente,
 * `listOrganizations`, `getUserPreferences` y `createLocationQrSheetLink`, cada una con su
 * `get…Url`, más los tipos de las propuestas.
 *
 * Salen del contrato público (`@patroltech/sdk-api` ≥ 1.3.0). Ningún otro fichero importa el SDK
 * directamente: si una versión nueva renombra algo, el cambio se queda aquí.
 */
export {
  agentProposalExecutedRecently,
  cancelAgentProposals,
  claimAgentProposal,
  createLocationQrSheetLink,
  getAgentProposal,
  getAgentProposalBatch,
  getAgentProposalExecutedRecentlyUrl,
  getCancelAgentProposalsUrl,
  getClaimAgentProposalUrl,
  getCreateLocationQrSheetLinkUrl,
  getGetAgentProposalBatchUrl,
  getGetAgentProposalUrl,
  getGetLiveAgentProposalUrl,
  getGetUserPreferencesUrl,
  getListOrganizationsUrl,
  getLiveAgentProposal,
  getMarkAgentProposalExecutedUrl,
  getMarkAgentProposalFailedUrl,
  getProposeAgentActionsUrl,
  getReopenAgentProposalsUrl,
  getUserPreferences,
  listOrganizations,
  markAgentProposalExecuted,
  markAgentProposalFailed,
  proposeAgentActions,
  reopenAgentProposals,
  type AgentProposal,
  type AgentProposalItem,
} from '@patroltech/sdk-api';
