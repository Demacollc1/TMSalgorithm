'use strict';

const crypto = require('crypto');

/**
 * Generador de documentos de facturación electrónica (Ecuador / SRI).
 *
 * Al confirmarse la carga completa de una ruta, se genera por cada
 * parada un payload con la GUÍA DE REMISIÓN y la FACTURA, listo para
 * enviarse al webservice de facturación configurado. Los números de
 * clave de acceso siguen la estructura del SRI (49 dígitos, dígito
 * verificador módulo 11); en producción el webservice autoriza el
 * comprobante real.
 */

function mod11(digits) {
  // dígito verificador módulo 11 (pesos 2..7 de derecha a izquierda)
  let weight = 2;
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const mod = 11 - (sum % 11);
  return mod === 11 ? 0 : mod === 10 ? 1 : mod;
}

function claveAcceso({ date, docType, ruc, serie, secuencial }) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  const ambiente = '1'; // pruebas
  const codigoNumerico = String(crypto.randomInt(10 ** 8)).padStart(8, '0');
  const tipoEmision = '1';
  const base =
    dd + mm + yyyy + docType + ruc + ambiente + serie +
    String(secuencial).padStart(9, '0') + codigoNumerico + tipoEmision;
  return base + String(mod11(base));
}

function fmtSecuencial(estab, punto, seq) {
  return `${estab}-${punto}-${String(seq).padStart(9, '0')}`;
}

/**
 * Genera los documentos (guía + factura) de cada parada de una ruta.
 *
 * @param {Object} params
 * @param {Object} params.route ruta aprobada y cargada
 * @param {Array}  params.orders pedidos de la ruta
 * @param {Object} params.vehicle vehículo asignado
 * @param {Object} params.driver conductor
 * @param {Object} params.billing configuración {razonSocial, ruc, direccion, establecimiento, puntoEmision, ivaPct}
 * @param {Function} params.nextSeq () => número secuencial incremental
 * @returns {Array} documentos por parada
 */
function buildRouteDocuments({ route, orders, vehicle, driver, billing, nextSeq }) {
  const today = new Date();
  const serie = `${billing.establecimiento}${billing.puntoEmision}`;
  const documents = [];

  for (const stop of route.stops.filter((s) => s.orderId)) {
    const order = orders.find((o) => o.id === stop.orderId);
    if (!order) continue;
    const bultos = (route.loadingPlan || []).filter((b) => b.orderId === order.id);

    const guiaSeq = nextSeq();
    const factSeq = nextSeq();
    const subtotal = Math.round((order.price || estimateValue(order)) * 100) / 100;
    const iva = Math.round(subtotal * (billing.ivaPct / 100) * 100) / 100;

    documents.push({
      orderId: order.id,
      orderCode: order.code,
      stopSeq: stop.seq,
      trackingCode: order.trackingCode,
      guia: {
        numero: fmtSecuencial(billing.establecimiento, billing.puntoEmision, guiaSeq),
        claveAcceso: claveAcceso({ date: today, docType: '06', ruc: billing.ruc, serie, secuencial: guiaSeq }),
        fechaEmision: today.toISOString().slice(0, 10),
        motivoTraslado: 'VENTA',
        puntoPartida: billing.direccion,
        destinatario: {
          razonSocial: order.customer,
          direccion: order.address,
          ciudad: order.commune,
          lat: order.lat,
          lng: order.lng,
        },
        transporte: {
          placa: vehicle ? vehicle.plate : null,
          conductor: driver ? driver.name : null,
          rutaId: route.id,
          eta: stop.eta,
        },
        bultos: bultos.map((b) => ({
          containerId: b.containerId,
          barcode: b.barcode,
          descripcion: b.description,
          items: b.itemCount || 1,
          pesoKg: b.weightKg,
          zona: b.zoneLabel,
        })),
      },
      factura: {
        numero: fmtSecuencial(billing.establecimiento, billing.puntoEmision, factSeq),
        claveAcceso: claveAcceso({ date: today, docType: '01', ruc: billing.ruc, serie, secuencial: factSeq }),
        fechaEmision: today.toISOString().slice(0, 10),
        cliente: { razonSocial: order.customer, identificacion: order.externalRef || 'CONSUMIDOR FINAL' },
        subtotal,
        ivaPct: billing.ivaPct,
        iva,
        total: Math.round((subtotal + iva) * 100) / 100,
        moneda: 'USD',
      },
      status: 'generado',
      generatedAt: new Date().toISOString(),
    });
  }
  return documents;
}

// Estimación simple del valor cuando el pedido no trae precio (demo)
function estimateValue(order) {
  return Math.max(10, Math.round(((order.weightKg || 0) * 1.8 + (order.volumeM3 || 0) * 40) * 100) / 100);
}

module.exports = { buildRouteDocuments, claveAcceso, mod11 };
