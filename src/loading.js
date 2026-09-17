'use strict';

/**
 * Motor de carga del camión.
 *
 * Clasifica bultos en carga VOLUMÉTRICA o PAQUETERÍA y construye la
 * secuencia física de carga de un vehículo para una ruta:
 *
 *  Fase 1 — Volumétrica pesada (sacos de cemento, empastes, morteros):
 *           parte DELANTERA-CENTRAL del cajón, por seguridad y
 *           estabilidad. Se carga primero, de más a menos pesado.
 *  Fase 2 — Tubos y perfiles largos: PARRILLA o parte superior del cajón.
 *  Fase 3 — Paquetería: en el cajón en orden INVERSO a la entrega (LIFO):
 *           lo del último cliente al fondo, lo del primero junto a la
 *           puerta.
 */

const HEAVY_KG = 20; // desde este peso un bulto se trata como volumétrico
const HEAVY_WORDS = /CEMENTO|EMPASTE|MORTERO|BONDEX|SIKATOP|SIKA TOP|SIKACERAM|SACO|MULTIMIX|PEGAMENTO 20KG/i;
const TUBE_WORDS = /TUBO|PERFIL|VARILLA|CA[ÑN]ER[IÍ]A|RIEL/i;

const ZONES = {
  remolque: 'Remolque (carga volumétrica, se entrega antes de soltarlo)',
  'delantera-central': 'Delantera central (piso del cajón)',
  parrilla: 'Parrilla / parte superior',
  cajon: 'Cajón (por orden de entrega)',
};

/**
 * Clasifica un bulto según su contenido y peso.
 * @param {{weightKg:number, items?:Array<{description:string}>, description?:string}} bulto
 * @returns {{cargoType:'volumetrica'|'paqueteria', zone:keyof typeof ZONES}}
 */
function classifyBulto(bulto) {
  const text = [
    bulto.description || '',
    ...(bulto.items || []).map((i) => i.description || ''),
  ].join(' ');
  if (TUBE_WORDS.test(text)) return { cargoType: 'volumetrica', zone: 'parrilla' };
  if ((bulto.weightKg || 0) >= HEAVY_KG || HEAVY_WORDS.test(text)) {
    return { cargoType: 'volumetrica', zone: 'delantera-central' };
  }
  return { cargoType: 'paqueteria', zone: 'cajon' };
}

/**
 * Construye la lista de carga de una ruta.
 *
 * @param {Object} route ruta con stops [{seq, orderId}]
 * @param {Array} orders pedidos (cada uno puede traer bultos[])
 * @returns {Array} bultos en orden de carga, con seq, fase, zona y estado
 */
function buildLoadingPlan(route, orders) {
  const stops = route.stops.filter((s) => s.orderId);
  const entries = [];

  for (const stop of stops) {
    const order = orders.find((o) => o.id === stop.orderId);
    if (!order) continue;
    const bultos =
      order.bultos && order.bultos.length
        ? order.bultos
        : [
            {
              // pedidos sin desglose (portal / API simple): un bulto único
              containerId: order.trackingCode || order.code,
              barcode: order.trackingCode || order.code,
              description: order.customer
                ? `Pedido ${order.code} · ${order.customer}`
                : `Pedido ${order.code}`,
              weightKg: order.weightKg || 0,
              volumeM3: order.volumeM3 || 0,
              items: [],
            },
          ];
    for (const b of bultos) {
      const cls = classifyBulto(b);
      entries.push({
        orderId: order.id,
        orderCode: order.code,
        stopSeq: stop.seq,
        address: order.address,
        customer: order.customer,
        containerId: b.containerId,
        barcode: b.barcode || b.containerId,
        altCode: b.altCode || null,
        sourceCode: b.sourceCode || null,
        description: b.description || '',
        weightKg: Math.round((b.weightKg || 0) * 100) / 100,
        volumeM3: Math.round((b.volumeM3 || 0) * 10000) / 10000,
        cargoType: cls.cargoType,
        zone: cls.zone,
        zoneLabel: ZONES[cls.zone],
      });
    }
  }

  // Fase 0: si la ruta lleva remolque, la carga volumétrica de las
  // paradas previas al punto de soltado viaja en el remolque (debe
  // quedar vacío antes de dejarlo en el acopio)
  if (route.trailerId && route.trailerDropSeq) {
    for (const e of entries) {
      if (e.cargoType === 'volumetrica' && e.stopSeq < route.trailerDropSeq) {
        e.zone = 'remolque';
        e.zoneLabel = ZONES.remolque;
      }
    }
  }

  const inTrailer = entries
    .filter((e) => e.zone === 'remolque')
    .sort((a, b) => b.stopSeq - a.stopSeq || b.weightKg - a.weightKg);
  // Fase 1: volumétrica pesada (delantera-central), de más a menos pesada
  const heavy = entries
    .filter((e) => e.zone === 'delantera-central')
    .sort((a, b) => b.weightKg - a.weightKg);
  // Fase 2: tubos a la parrilla (agrupados por parada para no mezclarlos)
  const tubes = entries
    .filter((e) => e.zone === 'parrilla')
    .sort((a, b) => b.stopSeq - a.stopSeq);
  // Fase 3: paquetería en orden inverso de entrega (LIFO)
  const parcels = entries
    .filter((e) => e.zone === 'cajon')
    .sort((a, b) => b.stopSeq - a.stopSeq || b.weightKg - a.weightKg);

  const ordered = [...inTrailer, ...heavy, ...tubes, ...parcels];
  return ordered.map((e, i) => ({
    seq: i + 1,
    phase: e.zone === 'remolque' ? 0 : e.zone === 'delantera-central' ? 1 : e.zone === 'parrilla' ? 2 : 3,
    ...e,
    loaded: false,
    loadedAt: null,
    loadMethod: null, // 'scan' | 'manual'
    skipped: false, // no cargado (con motivo en skipReason)
    skipReason: null,
    delivered: false,
    deliveredAt: null,
    deliveryStatus: null, // 'entregado' | 'devuelto' | 'rechazado'
  }));
}

/** Resumen del plan de carga (para tarjetas y validaciones). */
function loadingSummary(plan) {
  const total = plan.length;
  const loaded = plan.filter((b) => b.loaded).length;
  const skipped = plan.filter((b) => b.skipped).length;
  return {
    total,
    loaded,
    skipped,
    pending: total - loaded - skipped,
    // la carga cierra cuando cada bulto fue cargado o marcado no cargado
    complete: total > 0 && loaded + skipped === total,
    weightKg: Math.round(plan.reduce((s, b) => s + b.weightKg, 0) * 10) / 10,
    volumeM3: Math.round(plan.reduce((s, b) => s + b.volumeM3, 0) * 100) / 100,
    byPhase: [0, 1, 2, 3].map((phase) => ({
      phase,
      total: plan.filter((b) => b.phase === phase).length,
      loaded: plan.filter((b) => b.phase === phase && b.loaded).length,
    })),
  };
}

module.exports = { classifyBulto, buildLoadingPlan, loadingSummary, ZONES, HEAVY_KG };
