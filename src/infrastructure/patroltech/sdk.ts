/**
 * Único punto de entrada a las operaciones del SDK HTTP de PatrolTech que el conector llama por su
 * cuenta (el resto las llama `@patroltech/agent-capabilities`): las propuestas de agente,
 * `listOrganizations`, `getUserPreferences` y `createLocationQrSheetLink`, cada una con su
 * `get…Url`, más los tipos de las propuestas.
 *
 * Hoy salen del SDK interno de PatrolTech, que no se publica. Cuando estén en el contrato público
 * (`@patroltech/sdk-api` 1.3.0), el cambio es solo este módulo: importar de `@patroltech/sdk-api` y
 * subir esa dependencia en `package.json`. Ningún otro fichero importa un SDK directamente.
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
} from '@patroltech/sdk-api-private';
