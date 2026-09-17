'use strict';

/**
 * Importador de planes de entrega.
 *
 * Acepta el mismo formato que el API de planes estilo Driv.in que ya
 * genera el ERP: { clients: [ { code, address, lat, lng, name,
 * time_windows, orders: [ { code, alt_code, items: [ { code,
 * description, units, units_2 (kg totales), units_3 (cm³ totales) } ] } ] } ] }
 *
 * Cada "order" del JSON es un BULTO/CONTENEDOR (su alt_code es único y
 * sirve de código de barras). En el TMS, cada cliente se convierte en
 * un pedido (parada de entrega) con su lista de bultos.
 */

const { classifyBulto } = require('./loading');

function toNumber(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convierte el plan externo en pedidos listos para insertar.
 * No toca la base: devuelve los pedidos mapeados y advertencias.
 */
function mapPlan(plan) {
  if (!plan || !Array.isArray(plan.clients)) {
    throw new Error('El plan debe tener la forma { clients: [...] }');
  }
  const warnings = [];
  const orders = [];

  plan.clients.forEach((client, ci) => {
    const lat = toNumber(client.lat);
    const lng = toNumber(client.lng);
    if (!lat || !lng) {
      warnings.push(`Cliente ${client.code || ci}: sin coordenadas válidas, omitido`);
      return;
    }
    const tw = Array.isArray(client.time_windows) && client.time_windows[0]
      ? { start: client.time_windows[0].start || '09:00', end: client.time_windows[0].end || '18:00' }
      : { start: '09:00', end: '18:00' };

    const bultos = (client.orders || []).map((o, bi) => {
      const items = (o.items || []).map((it) => ({
        code: it.code,
        description: it.description || '',
        units: toNumber(it.units),
        weightKg: toNumber(it.units_2),
        volumeCm3: toNumber(it.units_3),
      }));
      const weightKg = items.reduce((s, it) => s + it.weightKg, 0);
      const volumeM3 = items.reduce((s, it) => s + it.volumeCm3, 0) / 1e6;
      const bulto = {
        containerId: o.alt_code || o.code || `BULTO-${ci + 1}-${bi + 1}`,
        barcode: o.alt_code || o.code || `BULTO-${ci + 1}-${bi + 1}`,
        sourceCode: o.code || null,
        description:
          items.length === 1
            ? items[0].description
            : `${items[0] ? items[0].description : 'Mercadería'} (+${items.length - 1} ítems)`,
        itemCount: items.length,
        unitCount: items.reduce((s, it) => s + it.units, 0),
        weightKg: Math.round(weightKg * 100) / 100,
        volumeM3: Math.round(volumeM3 * 10000) / 10000,
        items,
      };
      const cls = classifyBulto(bulto);
      bulto.cargoType = cls.cargoType;
      bulto.zone = cls.zone;
      return bulto;
    });

    if (!bultos.length) {
      warnings.push(`Cliente ${client.code || ci}: sin bultos, omitido`);
      return;
    }

    orders.push({
      code: `PLAN-${client.code || ci + 1}`,
      type: 'entrega',
      customer: client.client_name || client.name || `Cliente ${client.code}`,
      contact: client.contact_name
        ? { name: client.contact_name, phone: client.phone || '', email: '' }
        : null,
      address: [client.address, client.reference].filter(Boolean).join(', '),
      commune: client.city || '',
      lat,
      lng,
      timeWindow: tw,
      weightKg: Math.round(bultos.reduce((s, b) => s + b.weightKg, 0) * 100) / 100,
      volumeM3: Math.round(bultos.reduce((s, b) => s + b.volumeM3, 0) * 10000) / 10000,
      externalRef: String(client.code ?? ''),
      notes: `Importado de plan (${bultos.length} bultos)`,
      bultos,
    });
  });

  return { orders, warnings };
}

module.exports = { mapPlan };
