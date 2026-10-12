import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { courierError } from '../../lib/errors.js';
import { MockCourierAdapter } from './mock.js';
import { ShippingDoAdapter } from './shippingdo.js';
import type { CourierAdapter } from './types.js';

/**
 * Registro de adaptadores de transportista.
 *
 * `COURIER_PROVIDER` en el .env decide cual esta activo. La API y el
 * servicio de envios no saben cual es: siempre hablan el contrato
 * `CourierAdapter`.
 *
 * Por que se instancia de forma perezosa: el adaptador de Shipping-do
 * falla en el constructor si no hay token. Que eso rompa el arranque del
 * servidor seria correcto en produccion, pero en desarrollo (donde el
 * proveedor es el mock) no debe impedir arrancar el sistema.
 */

let cachedAdapter: CourierAdapter | null = null;

export function getCourierAdapter(): CourierAdapter {
  if (cachedAdapter) return cachedAdapter;

  const provider = env.COURIER_PROVIDER;

  try {
    switch (provider) {
      case 'shippingdo':
        cachedAdapter = new ShippingDoAdapter();
        break;

      case 'guia':
      case 'starken':
        // Todavia sin adaptador. Se implementan copiando la estructura
        // de shippingdo.ts; la seleccion falla de forma explicita en
        // lugar de caer al mock en silencio, porque caer al simulado en
        // produccion seria peor que no tener integracion.
        throw new Error(
          `El transportista "${provider}" aun no tiene adaptador implementado. ` +
            'Disponibles: mock, shippingdo. Implementa CourierAdapter en src/modules/couriers/.',
        );

      case 'manual':
      case 'mock':
      default:
        cachedAdapter = new MockCourierAdapter();
        break;
    }
  } catch (error) {
    if (env.isProduction) throw error;
    logger.warn(
      { err: error, provider },
      'Courier: no se pudo inicializar el proveedor configurado, se usa el simulado',
    );
    cachedAdapter = new MockCourierAdapter();
  }

  logger.info(
    { provider: cachedAdapter.code, displayName: cachedAdapter.displayName },
    'Courier: adaptador activo',
  );

  return cachedAdapter;
}

/** Reemplaza el adaptador. Lo usan las pruebas. */
export function setCourierAdapter(adapter: CourierAdapter | null): void {
  cachedAdapter = adapter;
}

export function availableProviders(): Array<{ code: string; active: boolean }> {
  return [
    { code: 'mock', active: env.COURIER_PROVIDER === 'mock' },
    { code: 'shippingdo', active: env.COURIER_PROVIDER === 'shippingdo' },
    { code: 'guia', active: env.COURIER_PROVIDER === 'guia' },
    { code: 'starken', active: env.COURIER_PROVIDER === 'starken' },
  ];
}

export async function safeCreateShipment<T>(
  operation: (adapter: CourierAdapter) => Promise<T>,
): Promise<T> {
  const adapter = getCourierAdapter();
  try {
    return await operation(adapter);
  } catch (error) {
    throw courierError(
      `Fallo la comunicacion con ${adapter.displayName}. El envio queda pendiente de sincronizar.`,
      error,
    );
  }
}

export { MockCourierAdapter, ShippingDoAdapter };
export * from './types.js';