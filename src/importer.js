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
 * El CONTAINER ID es el identificador físico del bulto (el que aparece
 * como "Id. Contenedor" en la guía y en la etiqueta de código de
 * barras). Se extrae del campo `code` quitando el prefijo de documento
 * (p. ej. "SO-26040646-") y el sufijo de ruta (p. ej. "-B87"):
 *   "ST-26007565-M0'144553'6.01'1-B87" → "M0'144553'6.01'1"
 */
function extractContainerId(code, fallback) {
  if (!code) return fallback || null;
  let s = String(code).trim();
  s = s.replace(/^[A-Z]{2,3}-\d+-/, '');
  s = s.replace(/-B\d+$/, '');
  return s || fallback || String(code);
}

// Tipos de producto volumétrico reconocidos por el segmento de tipo del
// código (p. ej. TUB/TU3 = tubería, PAL = pallet, TAN = tanques).
const VOL_TYPES = [
  { re: /^TU/i, type: 'tubos', label: 'Tubería' },
  { re: /^PAL/i, type: 'pallet', label: 'Pallet' },
  { re: /^TAN/i, type: 'tanque', label: 'Tanque' },
];

/**
 * Lee la estructura interna del Container ID. Hay dos familias:
 *
 *  - VOLUMÉTRICA (5 segmentos, con marcador `#`):
 *      B87'#A'111838'TU3'1
 *      bodega ' #marcador ' idÚnico(HHMMSS) ' TIPO ' cantidad
 *      TIPO ∈ {PAL=Pallet, TU*=Tubos, TAN=Tanques}
 *
 *  - CAJA / paquetería (4 segmentos, sin `#`):
 *      M0'121151'5.07'9   /   S1'094433'12.83'2
 *      prefijo ' idÚnico(HHMMSS) ' pesoKg ' cantidad
 *
 * @returns {{containerNum:string|null, family:'volumetrica'|'caja',
 *   productType:'tubos'|'pallet'|'tanque'|'caja', productCode:string|null,
 *   codeWeightKg:number|null, qty:number|null}}
 */
function parseContainerCode(containerId) {
  const out = {
    containerNum: null,
    family: 'caja',
    productType: 'caja',
    productCode: null,
    codeWeightKg: null,
    qty: null,
  };
  if (!containerId) return out;
  const tokens = String(containerId).split("'").map((t) => t.trim());
  // ID único = segmento de 6 dígitos (hora de generación HHMMSS)
  const idTok = tokens.find((t) => /^\d{6}$/.test(t));
  if (idTok) out.containerNum = idTok;
  const last = tokens[tokens.length - 1];
  if (/^\d+$/.test(last)) out.qty = Number(last);

  if (tokens.some((t) => t.startsWith('#'))) {
    out.family = 'volumetrica';
    const typeTok = tokens.find((t) => VOL_TYPES.some((v) => v.re.test(t)));
    const match = typeTok ? VOL_TYPES.find((v) => v.re.test(typeTok)) : null;
    out.productType = match ? match.type : 'volumetrica';
    out.productCode = typeTok || null;
  } else {
    out.family = 'caja';
    out.productType = 'caja';
    const wTok = tokens.find((t) => /^\d+\.\d+$/.test(t));
    if (wTok) out.codeWeightKg = Number(wTok);
  }
  return out;
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
      const containerId = extractContainerId(o.code, o.alt_code) || `BULTO-${ci + 1}-${bi + 1}`;
      const parsed = parseContainerCode(containerId);
      const bulto = {
        containerId,
        containerNum: parsed.containerNum, // ID de 6 dígitos, código de barras físico
        barcode: containerId,
        productType: parsed.productType, // 'tubos'|'pallet'|'tanque'|'caja'
        productCode: parsed.productCode, // TU3 / PAL / TAN
        productQty: parsed.qty,
        altCode: o.alt_code || null,
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

module.exports = { mapPlan, extractContainerId, parseContainerCode };
