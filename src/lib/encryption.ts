import { encryptPII, decryptPII } from './crypto.js';

/**
 * Traduccion entre el modelo `Address` (que guarda PII en claro en la
 * `addresses` se escribe YA cifrado desde la capa de servicio (ver
 * shipments/service.ts). Este modulo concentra el cifrado de valores
 * sueltos y el formateo de la respuesta para el cliente.
 */

export interface AddressInput {
  contactName: string;
  contactPhone: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  countryCode: string;
  instructions?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface AddressOutput extends Omit<AddressInput, 'contactPhone'> {
  contactPhone: string;
}

/** Enmascara un telefono para mostrarlo en superficies no autorizadas. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  return `+${digits.slice(0, 3)} •••• ${digits.slice(-4)}`;
}

/** Enmascara una direccion dejando solo el numero de calle. */
export function maskAddressLine(line: string): string {
  const match = /^(\d+)\s+(.*)$/.exec(line.trim());
  if (!match) return '••••••••';
  return `${match[1]} ••••••`;
}

export { encryptPII, decryptPII };