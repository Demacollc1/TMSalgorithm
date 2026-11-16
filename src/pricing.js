'use strict';

const { haversineKm } = require('./geo');
const { measureItems } = require('./packages');

/**
 * Motor de cotización de fletes Macotrans.
 * Tarifa = base + km + peso facturable + volumen, con multiplicador por
 * servicio, recargo por parada adicional y por ítems largos (tubería).
 * Valores en USD (Ecuador).
 */

const TARIFF = {
  baseUsd: 8,
  perKm: 0.85,
  perKg: 0.05, // sobre el peso facturable (mayor entre real y volumétrico)
  perM3: 6,
  perStop: 3, // recargo por cada parada adicional (multi-parada)
  longItemUsd: 5, // recargo si hay tubería / carga larga (parrilla)
  minUsd: 10,
  serviceMultiplier: {
    normal: 1,
    express: 1.35, // entrega el mismo día
    programado: 0.9, // agendado con 48h o más de anticipación
  },
};

// Distancia encadenada por una lista de puntos [{lat,lng}], factor calle 1.3
function chainedKm(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineKm(points[i - 1], points[i]);
  return Math.round(d * 1.3 * 10) / 10;
}

/**
 * Cotización por tipos de paquete y múltiples paradas.
 * @param {Object} p
 * @param {{lat,lng}} p.origin
 * @param {{lat,lng}} p.destination
 * @param {Array} [p.stops] paradas intermedias [{lat,lng}] (multi-parada)
 * @param {Array} p.items   paquetes del catálogo (packages.js)
 * @param {string} [p.service]
 */
function quoteItems({ origin, destination, stops = [], items, service = 'normal' }) {
  if (!origin || !destination || typeof origin.lat !== 'number' || typeof destination.lat !== 'number') {
    throw new Error('origin y destination requieren lat y lng numéricos');
  }
  const measured = measureItems(items);
  const mult = TARIFF.serviceMultiplier[service] || 1;
  const path = [origin, ...stops.filter((s) => s && typeof s.lat === 'number'), destination];
  const distanceKm = chainedKm(path);
  const extraStops = Math.max(0, path.length - 2); // paradas más allá de origen y destino final
  const r2 = (v) => Math.round(v * 100) / 100;

  const breakdown = {
    base: TARIFF.baseUsd,
    distancia: r2(distanceKm * TARIFF.perKm),
    pesoFacturable: r2(measured.billableKg * TARIFF.perKg),
    volumen: r2(measured.volumeM3 * TARIFF.perM3),
    paradasAdicionales: r2(extraStops * TARIFF.perStop),
    cargaLarga: measured.hasLongItems ? TARIFF.longItemUsd : 0,
    servicio: service,
    multiplicador: mult,
  };
  const subtotal =
    breakdown.base + breakdown.distancia + breakdown.pesoFacturable +
    breakdown.volumen + breakdown.paradasAdicionales + breakdown.cargaLarga;

  return {
    distanceKm,
    stops: extraStops,
    weightKg: measured.weightKg,
    billableKg: measured.billableKg,
    volumeM3: measured.volumeM3,
    items: measured.items,
    priceUsd: roundUsd(subtotal * mult),
    currency: 'USD',
    breakdown,
  };
}

function roundUsd(v) {
  return Math.max(TARIFF.minUsd, Math.round(v * 100) / 100);
}

/**
 * @param {Object} params
 * @param {{lat:number,lng:number}} params.origin
 * @param {{lat:number,lng:number}} params.destination
 * @param {number} params.weightKg
 * @param {number} [params.volumeM3]
 * @param {string} [params.service] normal | express | programado
 * @returns {{distanceKm:number, priceUsd:number, currency:string, breakdown:Object}}
 */
function quote({ origin, destination, weightKg = 0, volumeM3 = 0, service = 'normal' }) {
  if (
    !origin || !destination ||
    typeof origin.lat !== 'number' || typeof origin.lng !== 'number' ||
    typeof destination.lat !== 'number' || typeof destination.lng !== 'number'
  ) {
    throw new Error('origin y destination requieren lat y lng numéricos');
  }
  const mult = TARIFF.serviceMultiplier[service] || 1;
  // factor 1.3: aproxima la distancia por calles a partir de la línea recta
  const distanceKm = Math.round(haversineKm(origin, destination) * 1.3 * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const breakdown = {
    base: TARIFF.baseUsd,
    distancia: r2(distanceKm * TARIFF.perKm),
    peso: r2((Number(weightKg) || 0) * TARIFF.perKg),
    volumen: r2((Number(volumeM3) || 0) * TARIFF.perM3),
    servicio: service,
    multiplicador: mult,
  };
  const subtotal = breakdown.base + breakdown.distancia + breakdown.peso + breakdown.volumen;
  return {
    distanceKm,
    priceUsd: roundUsd(subtotal * mult),
    currency: 'USD',
    breakdown,
  };
}

module.exports = { quote, quoteItems, TARIFF };
