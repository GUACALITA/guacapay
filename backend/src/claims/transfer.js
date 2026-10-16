// The transfer step of a claim. Until the Open Payments transfer is approved (prompt 08), it refuses
// to run, and the claim stays open so the recipient can try again later.
import { AppError } from '../errors.js';

export async function unconfiguredTransfer() {
  throw new AppError('transfer_not_configured', 503, 'Transfers are not available yet.');
}
