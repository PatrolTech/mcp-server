import type {
  ActionDefinition,
  Logger,
  PatrolTechUrls,
  PendingActionStore,
} from '@patroltech/agent-capabilities';
import type { KeyedLock } from '../ports/KeyedLock.js';

/** Minutos que vive un lote sin confirmar (se renueva cada vez que se añade una propuesta). */
export const PROPOSAL_TTL_MIN = 30;

/** Una acción del catálogo `mcp` con el nombre de su herramienta `propose_*`. */
export interface ProposableAction {
  toolName: string;
  definition: ActionDefinition;
}

/** Lo que necesitan proponer, confirmar y cancelar para UN usuario y cliente OAuth. */
export interface ProposalDeps {
  /** El almacén con el JWT de sesión de agente de este usuario. */
  store: PendingActionStore;
  lock: KeyedLock;
  /** `proposalContextKey(userId, clientId)`: un único lote vivo por usuario y cliente. */
  contextKey: string;
  /** Las acciones del catálogo `mcp`, por su `nombre` (el que se guarda en cada propuesta). */
  actions: ReadonlyMap<string, ProposableAction>;
  ttlMin: number;
  urls: Partial<PatrolTechUrls>;
  logger: Logger;
}
