import type { CapabilityMeta } from '@patroltech/agent-capabilities';
import { z } from 'zod';

export const ACCOUNT_CONTEXT_TOOL = 'patroltech_account_get_context';

/**
 * Una línea por área del catálogo (la parte del id antes del punto) que dice cuándo NO usar sus
 * herramientas: el cuándo sí ya lo da el resumen del catálogo («Use when…»). Solo describe el
 * alcance: no da instrucciones de comportamiento.
 */
export const AREA_GUIDANCE: Readonly<Record<string, string>> = {
  rounds: 'Do not use when you need the definition of routes or checkpoints.',
  routes: 'Do not use when you need what happened in past rounds.',
  scans: 'Do not use when round totals are enough.',
  checkpoints: 'Do not use when you need the scans of one round.',
  patrollers: 'Do not use when you need the people who sign in to the dashboard.',
  incidents: 'Do not use when you need scans or rounds.',
  access: 'Do not use when you need guard scans.',
  users: 'Do not use when you need the guards.',
  license: 'Do not use when you need operational data.',
  account: 'Do not use when you need a detailed list; the specific tools give it.',
};

/**
 * Descripción MCP de una lectura: SOLO textos en inglés del catálogo (el resumen, que dice cuándo
 * usarla, y `returns`, qué devuelve y cómo leer sus campos) más la línea de su área.
 */
export function describeCapability(meta: CapabilityMeta): string {
  const area = meta.id.split('.')[0];
  const guidance = AREA_GUIDANCE[area];
  if (!guidance) {
    throw new Error(`No tool guidance for catalog area "${area}" (${meta.id})`);
  }
  if (!meta.returns) {
    throw new Error(`No English "returns" line in the catalog for ${meta.id}`);
  }
  return `${meta.summary.en} ${meta.returns.en} ${guidance}`;
}

/**
 * Parámetro común de las lecturas: opcional, imprescindible solo con varias organizaciones (la
 * condición va primero: los modelos tienden a rellenar los parámetros opcionales).
 */
export const organizationInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    `Omit unless the account has more than one organization; then the exact name (or id) as listed by ${ACCOUNT_CONTEXT_TOOL}.`
  );
