import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createQrSheet } from '../../../application/qr/createQrSheet.js';
import { isRefusal } from '../../../application/ToolOutcome.js';
import {
  WRITE_RATE_LIMIT,
  registerCapabilityTool,
  type ToolBinding,
} from '../registerCapabilityTool.js';
import { ACCOUNT_CONTEXT_TOOL, organizationInput } from './toolDescriptions.js';
import { QR_SHEET_ANNOTATIONS, type WriteToolDeps } from './writeTools.js';

export const QR_SHEET_TOOL = 'patroltech_locations_get_qr_sheet';

export const QR_SHEET_DESCRIPTION = [
  "Creates a temporary link (valid for about one hour) to a printable PDF with the QR codes of a location's checkpoints; it changes nothing in the account.",
  'It returns when the link expires both in UTC (`expiresAt`) and in the local time of the account (`expiresAtLocal`, with its offset): tell the user the local one.',
  'Use this when the user wants to print or download the QR codes of a location, or of some of its checkpoints.',
].join(' ');

/**
 * `patroltech_locations_get_qr_sheet`: el enlace firmado a la hoja de QR de una ubicación. Pide
 * el scope `write` (el backend lo exige: emite un enlace), pero es una lectura para sus errores.
 * `organization` es opcional y solo se resuelve si viene (la ubicación ya la identifica).
 */
export function registerQrSheetTool(
  server: McpServer,
  binding: ToolBinding,
  writes: WriteToolDeps
): void {
  registerCapabilityTool(
    server,
    binding,
    {
      name: QR_SHEET_TOOL,
      title: 'Get the QR sheet of a location',
      description: QR_SHEET_DESCRIPTION,
      inputSchema: {
        locationId: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe(`Id of the location, as listed by ${ACCOUNT_CONTEXT_TOOL}.`),
        checkpointIds: z
          .array(z.string().trim().min(1).max(100))
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Omit to print every QR checkpoint of the location; otherwise the ids to print.'
          ),
        organization: organizationInput,
      },
      annotations: QR_SHEET_ANNOTATIONS,
      operation: 'read',
      requiredScope: 'write',
      rateLimit: WRITE_RATE_LIMIT,
    },
    async (args, call) => {
      const organization = typeof args.organization === 'string' ? args.organization : undefined;
      let session: { token: string; tz: string };
      if (organization) {
        const context = await call.capabilityContext(organization);
        if (isRefusal(context)) return context;
        session = context;
      } else {
        session = await call.session();
      }
      const checkpointIds = Array.isArray(args.checkpointIds)
        ? args.checkpointIds.map(String)
        : undefined;
      return createQrSheet(
        writes.qrSheets,
        { locationId: String(args.locationId), ...(checkpointIds ? { checkpointIds } : {}) },
        session.token,
        session.tz
      );
    }
  );
}
