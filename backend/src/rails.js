// Guards for the card rail (Rapyd). It is off unless PAYMENT_RAILS=rapyd (decision 017).
import { config } from './config.js';
import { AppError } from './errors.js';

export function requireCardRail() {
  if (config.paymentRails !== 'rapyd') {
    throw new AppError('rail_not_available', 503, 'Card payments are not available. Pay from a test wallet instead.');
  }
}
