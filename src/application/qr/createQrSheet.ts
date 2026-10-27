import { localIsoWithOffset, ok } from '@patroltech/agent-capabilities';
import {
  NoPrintableCheckpointsError,
  QrSheetTooLargeError,
  type QrSheetLinks,
} from '../ports/QrSheetLinks.js';
import { refuse, type ToolOutcome } from '../ToolOutcome.js';

export const NO_PRINTABLE_CHECKPOINTS =
  'This location has no finished checkpoint with a QR code to print (or none of the given checkpointIds is one). ' +
  'Check its checkpoints with patroltech_checkpoints_list.';

export const QR_SHEET_TOO_LARGE =
  'This location has more QR checkpoints than fit in one sheet. Pass up to 100 checkpointIds (from patroltech_checkpoints_list) to print a part of them.';

/**
 * El enlace firmado a la hoja de QR de una ubicación (o de algunos de sus checkpoints), con su
 * caducidad también en la hora de la cuenta (`tz`): el modelo pasa mal UTC a local. Una hoja
 * que no se puede hacer tal cual es una negativa accionable (textos nuestros, sin datos de
 * usuarios); el resto de fallos sigue su camino.
 */
export async function createQrSheet(
  links: QrSheetLinks,
  input: { locationId: string; checkpointIds?: readonly string[] },
  token: string,
  tz: string
): Promise<ToolOutcome> {
  try {
    const link = await links.create(input, token);
    return ok({
      ...link,
      expiresAtLocal: localIsoWithOffset(new Date(link.expiresAt), tz),
      timezone: tz,
    });
  } catch (error) {
    if (error instanceof NoPrintableCheckpointsError) {
      return refuse('no_printable_checkpoints', NO_PRINTABLE_CHECKPOINTS);
    }
    if (error instanceof QrSheetTooLargeError) {
      return refuse('qr_sheet_too_large', QR_SHEET_TOO_LARGE);
    }
    throw error;
  }
}
