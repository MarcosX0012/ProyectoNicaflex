import QRCode from 'qrcode';
import { env } from '../../config/env.js';

/**
 * Generacion de codigos QR por paquete.
 *
 * El QR apunta a la vista publica con un token firmado. Decisiones:
 *
 *  - El QR NO contiene el codigo de rastreo en texto plano dentro de la
 *    URL publica. Contiene un token firmado, que es el mismo mecanismo
 *    de los enlaces de verificacion por correo: el usuario no puede
 *    alterar el destino del QR.
 *
 *  - El token lleva `issuedAt`. Si en el futuro se necesita revocar
 *    una tanda de QR (por ejemplo, se reimprimen tras una mudanza),
 *    basta con rechazar tokens anteriores a una fecha, sin tocar los
 *    codigos de los envios.
 *
 *  - Se genera tambien la version imprimible en SVG: una etiqueta de
 *    10x6 cm se imprime mucho mejor en vector que en PNG, y pesа
 *    menos en la base si se guarda.
 */

export interface QrPayload {
  /** Token firmado que va dentro de la URL. */
  token: string;
  /** URL completa lista para el QR y para el enlace de la etiqueta. */
  trackingUrl: string;
  /** Codigo en texto plano, para imprimir debajo del QR. */
  humanReadableCode: string;
}

export function buildTrackingUrl(qrToken: string): string {
  return `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/track/${qrToken}`;
}

export function buildQrPayload(trackingCode: string, qrToken: string): QrPayload {
  return {
    token: qrToken,
    trackingUrl: buildTrackingUrl(qrToken),
    humanReadableCode: trackingCode,
  };
}

export async function generateQrDataUrl(qrToken: string): Promise<string> {
  return QRCode.toDataURL(buildTrackingUrl(qrToken), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#0F172A', light: '#FFFFFF' },
  });
}

export async function generateQrSvg(qrToken: string): Promise<string> {
  return QRCode.toString(buildTrackingUrl(qrToken), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#0F172A', light: '#FFFFFF' },
  });
}

/**
 * Etiqueta imprimible en SVG con QR, codigo legible, destino y fecha.
 *
 * Va como SVG y no como HTML porque el transportista la imprime tal
 * cual, y un HTML depende de las fuentes del navegador. El SVG es
 * autocontenido.
 */
export function buildShippingLabelSvg(params: {
  qrToken: string;
  trackingCode: string;
  senderName: string;
  recipientName: string;
  destinationCity: string;
  destinationLine1: string;
  itemCount: number;
  weightGrams: number | null;
}): Promise<string> {
  return generateQrSvg(params.qrToken).then((qrSvg) => {
    const escape = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // El QR se inserta como grupo escalado: 512x512 a 150x150.
    const qrGroup = qrSvg
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<svg([^>]*)>/, '<g transform="translate(40,150) scale(0.293)">')
      .replace(/<\/svg>\s*$/, '</g>');

    const weight =
      params.weightGrams !== null ? `${(params.weightGrams / 1000).toFixed(2)} kg` : '-';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260">
  <rect width="400" height="260" fill="#FFFFFF"/>
  <rect x="4" y="4" width="392" height="252" fill="none" stroke="#0F172A" stroke-width="2"/>

  <text x="20" y="34" font-family="monospace" font-size="19" font-weight="bold" fill="#0F172A">
    ${escape(params.trackingCode)}
  </text>
  <text x="20" y="54" font-family="sans-serif" font-size="11" fill="#475569">
    HOSSANA · Rastreo en linea
  </text>

  ${qrGroup}

  <text x="212" y="168" font-family="sans-serif" font-size="11" font-weight="bold" fill="#0F172A">
    DESTINO
  </text>
  <text x="212" y="186" font-family="sans-serif" font-size="12" fill="#0F172A">
    ${escape(params.recipientName)}
  </text>
  <text x="212" y="204" font-family="sans-serif" font-size="11" fill="#334155">
    ${escape(params.destinationLine1.slice(0, 30))}
  </text>
  <text x="212" y="220" font-family="sans-serif" font-size="11" fill="#334155">
    ${escape(params.destinationCity)}
  </text>
  <text x="212" y="242" font-family="sans-serif" font-size="10" fill="#64748B">
    ${escape(params.senderName.slice(0, 34))}
  </text>

  <line x1="20" y1="72" x2="380" y2="72" stroke="#CBD5E1" stroke-width="1"/>
  <text x="20" y="242" font-family="sans-serif" font-size="10" fill="#64748B">
    ${params.itemCount} art. · ${escape(weight)}
  </text>
</svg>`;
  });
}