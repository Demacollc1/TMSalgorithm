'use strict';

const { haversineKm } = require('./geo');

/**
 * Motor de cotización de fletes Macotrans.
 * Tarifa = base + km + peso + volumen, con multiplicador por servicio.
 * Valores en CLP, redondeados a la centena.
 */

const TARIFF = {
  baseClp: 12000,
  perKm: 950,
  perKg: 60,
  perM3: 7500,
  minClp: 15000,
  serviceMultiplier: {
    normal: 1,
    express: 1.35, // entrega el mismo día
    programado: 0.9, // agendado con 48h o más de anticipación
  },
};

function roundClp(v) {
  return Math.max(TARIFF.minClp, Math.round(v / 100) * 100);
}

/**
 * @param {Object} params
 * @param {{lat:number,lng:number}} params.origin
 * @param {{lat:number,lng:number}} params.destination
 * @param {number} params.weightKg
 * @param {number} [params.volumeM3]
 * @param {string} [params.service] normal | express | programado
 * @returns {{distanceKm:number, priceClp:number, currency:string, breakdown:Object}}
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
  const breakdown = {
    base: TARIFF.baseClp,
    distancia: Math.round(distanceKm * TARIFF.perKm),
    peso: Math.round((Number(weightKg) || 0) * TARIFF.perKg),
    volumen: Math.round((Number(volumeM3) || 0) * TARIFF.perM3),
    servicio: service,
    multiplicador: mult,
  };
  const subtotal = breakdown.base + breakdown.distancia + breakdown.peso + breakdown.volumen;
  return {
    distanceKm,
    priceClp: roundClp(subtotal * mult),
    currency: 'CLP',
    breakdown,
  };
}

module.exports = { quote, TARIFF };
