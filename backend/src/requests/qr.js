// The QR code for a request link, as a PNG data URL. Only the owner receives it, once, when the request is created:
// the token is stored as a hash, so the link (and its QR) cannot be produced again later.
import QRCode from 'qrcode';

export function requestQrPng(link) {
  return QRCode.toDataURL(link, { type: 'image/png', errorCorrectionLevel: 'M', margin: 2, width: 256 });
}
