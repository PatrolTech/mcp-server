import { createLocationQrSheetLink, getCreateLocationQrSheetLinkUrl } from './sdk.js';
import { PatrolTechApiError, callSdk, type SdkCallConfig } from '@patroltech/agent-capabilities';
import {
  NoPrintableCheckpointsError,
  QrSheetTooLargeError,
  type QrSheetLink,
  type QrSheetLinks,
} from '../../application/ports/QrSheetLinks.js';
import { backendErrorCode } from './backendErrorCode.js';

/** Un 422 del backend que dice por qué no se puede hacer la hoja, como error tipado. */
function qrSheetRejection(error: unknown): unknown {
  if (!(error instanceof PatrolTechApiError) || error.status !== 422) return error;
  const code = backendErrorCode(error);
  if (code === 'NO_PRINTABLE_CHECKPOINTS') return new NoPrintableCheckpointsError();
  if (code === 'QR_SHEET_TOO_LARGE') return new QrSheetTooLargeError();
  return error;
}

/** `QrSheetLinks` sobre `POST /api/locations/{locationId}/qr-sheet` (SDK oficial). */
export class SdkQrSheetLinks implements QrSheetLinks {
  constructor(private readonly options: SdkCallConfig) {}

  async create(
    input: { locationId: string; checkpointIds?: readonly string[] },
    token: string
  ): Promise<QrSheetLink> {
    const id = encodeURIComponent(input.locationId);
    const body = input.checkpointIds ? { checkpointIds: [...input.checkpointIds] } : {};
    const response = await callSdk(
      this.options,
      token,
      getCreateLocationQrSheetLinkUrl(id),
      (init) => createLocationQrSheetLink(id, body, init)
    ).catch((error: unknown) => {
      throw qrSheetRejection(error);
    });
    // `sdkFetch` lanza en todo lo que no es 200: aquí `data` es la del enlace.
    const { url, expiresAt, checkpointCount, pageCount } = response.data as QrSheetLink;
    return { url, expiresAt, checkpointCount, pageCount };
  }
}
