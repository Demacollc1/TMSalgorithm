'use strict';

/**
 * Catálogo de tipos de paquete y cálculo de peso/volumen facturable.
 *
 * Tipos:
 *  - correspondencia: sobres y paquetes extra livianos, planos
 *  - caja: tamaños estándar A1..A6 (dimensiones fijas, tope 50 kg;
 *          el cliente marca si pesa más y da el peso real)
 *  - pallet: base 1x1 / 1.20x0.80 / 1.20x1, con peso y si apila
 *  - tuberia: cantidad, diámetro y largo
 *  - volumetrico: irregular (largo x ancho x alto), si apila
 *
 * El peso FACTURABLE es el mayor entre el peso real y el peso
 * volumétrico (divisor courier 5000 cm³/kg). Los no apilables ocupan
 * volumen de piso "muerto" en el camión: se penaliza con un factor.
 */

const VOLUMETRIC_DIVISOR = 5000; // cm³ por kg
const NON_STACK_FACTOR = 1.35; // recargo de volumen para no apilables
const PALLET_HEIGHT_CM = 150; // altura estándar asumida de un pallet armado

// Cajas estándar (dimensiones internas aproximadas, en cm) y tope de peso
const BOX_SIZES = {
  A6: { l: 20, w: 15, h: 10 },
  A5: { l: 30, w: 20, h: 15 },
  A4: { l: 40, w: 30, h: 20 },
  A3: { l: 50, w: 40, h: 30 },
  A2: { l: 60, w: 50, h: 40 },
  A1: { l: 80, w: 60, h: 50 },
};
const BOX_MAX_KG = 50;

const PALLET_BASES = {
  '1x1': { l: 100, w: 100 },
  '1.20x0.80': { l: 120, w: 80 },
  '1.20x1': { l: 120, w: 100 },
};

const CORRESPONDENCIA_KG = 0.5;
const CORRESPONDENCIA_M3 = 0.002;

function volFromCm(l, w, h) {
  return (l * w * h) / 1e6; // m³
}
function volumetricKg(l, w, h) {
  return (l * w * h) / VOLUMETRIC_DIVISOR;
}

/**
 * Normaliza un ítem del catálogo a { qty, weightKg, volumeM3, billableKg, label }.
 * Lanza Error si faltan datos obligatorios.
 */
function measureItem(it) {
  const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
  const type = it.type;

  if (type === 'correspondencia') {
    return {
      qty, type,
      weightKg: round(CORRESPONDENCIA_KG * qty),
      volumeM3: round4(CORRESPONDENCIA_M3 * qty),
      billableKg: round(CORRESPONDENCIA_KG * qty),
      label: `Correspondencia x${qty}`,
    };
  }

  if (type === 'caja') {
    const dim = BOX_SIZES[it.size];
    if (!dim) throw new Error(`Tamaño de caja inválido: ${it.size}`);
    const volKgUnit = volumetricKg(dim.l, dim.w, dim.h);
    const realUnit = it.heavy
      ? Math.max(BOX_MAX_KG, Number(it.weightKg) || 0)
      : Math.min(BOX_MAX_KG, volKgUnit);
    const billUnit = Math.max(realUnit, volKgUnit);
    return {
      qty, type, size: it.size,
      weightKg: round(realUnit * qty),
      volumeM3: round4(volFromCm(dim.l, dim.w, dim.h) * qty),
      billableKg: round(billUnit * qty),
      label: `Caja ${it.size} (${dim.l}×${dim.w}×${dim.h} cm) x${qty}${it.heavy ? ' · pesada' : ''}`,
    };
  }

  if (type === 'pallet') {
    const base = PALLET_BASES[it.base];
    if (!base) throw new Error(`Base de pallet inválida: ${it.base}`);
    const weight = Number(it.weightKg) || 0;
    if (weight <= 0) throw new Error('El pallet requiere peso (kg)');
    let vol = volFromCm(base.l, base.w, PALLET_HEIGHT_CM);
    if (it.stackable === false) vol *= NON_STACK_FACTOR;
    const volKg = volumetricKg(base.l, base.w, PALLET_HEIGHT_CM);
    return {
      qty, type, base: it.base, stackable: it.stackable !== false,
      weightKg: round(weight * qty),
      volumeM3: round4(vol * qty),
      billableKg: round(Math.max(weight, volKg) * qty),
      label: `Pallet ${it.base} · ${weight} kg${it.stackable === false ? ' · NO apila' : ''} x${qty}`,
    };
  }

  if (type === 'tuberia') {
    const d = Number(it.diameterMm) || 0;
    const lenM = Number(it.lengthM) || 0;
    if (d <= 0 || lenM <= 0) throw new Error('La tubería requiere diámetro (mm) y largo (m)');
    // volumen del cilindro envolvente; billable por volumétrico
    const rCm = d / 20; // mm→cm radio
    const lenCm = lenM * 100;
    const volUnit = volFromCm(Math.PI * rCm * rCm, 1, lenCm); // área*largo
    const volKgUnit = volumetricKg(Math.PI * rCm * rCm, 1, lenCm);
    return {
      qty, type, diameterMm: d, lengthM: lenM, longItem: true,
      weightKg: round(volKgUnit * qty), // sin peso real: usa volumétrico
      volumeM3: round4(volUnit * qty),
      billableKg: round(volKgUnit * qty),
      label: `Tubería Ø${d}mm × ${lenM}m x${qty}`,
    };
  }

  if (type === 'volumetrico') {
    const l = Number(it.lengthCm) || 0;
    const w = Number(it.widthCm) || 0;
    const h = Number(it.heightCm) || 0;
    if (l <= 0 || w <= 0 || h <= 0) throw new Error('El volumétrico requiere largo, ancho y alto (cm)');
    let vol = volFromCm(l, w, h);
    if (it.stackable === false) vol *= NON_STACK_FACTOR;
    const volKg = volumetricKg(l, w, h);
    const real = Number(it.weightKg) || volKg;
    return {
      qty, type, lengthCm: l, widthCm: w, heightCm: h, stackable: it.stackable !== false,
      weightKg: round(real * qty),
      volumeM3: round4(vol * qty),
      billableKg: round(Math.max(real, volKg) * qty),
      label: `Volumétrico ${l}×${w}×${h} cm${it.stackable === false ? ' · NO apila' : ''} x${qty}`,
    };
  }

  throw new Error(`Tipo de paquete desconocido: ${type}`);
}

/** Suma una lista de ítems a totales de peso, volumen y facturable. */
function measureItems(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('Indica al menos un paquete');
  }
  const measured = items.map(measureItem);
  return {
    items: measured,
    weightKg: round(measured.reduce((s, m) => s + m.weightKg, 0)),
    volumeM3: round4(measured.reduce((s, m) => s + m.volumeM3, 0)),
    billableKg: round(measured.reduce((s, m) => s + m.billableKg, 0)),
    hasLongItems: measured.some((m) => m.longItem),
  };
}

// Catálogo para mostrar al cliente en el portal (dimensiones visibles)
function catalog() {
  return {
    correspondencia: { label: 'Correspondencia', desc: 'Sobres y paquetes extra livianos, planos' },
    cajas: Object.entries(BOX_SIZES).map(([code, d]) => ({
      code, l: d.l, w: d.w, h: d.h, maxKg: BOX_MAX_KG,
      desc: `${d.l} × ${d.w} × ${d.h} cm · hasta ${BOX_MAX_KG} kg`,
    })),
    pallets: Object.keys(PALLET_BASES).map((base) => ({ base, desc: PALLET_BASES[base].l + '×' + PALLET_BASES[base].w + ' cm' })),
    volumetricDivisor: VOLUMETRIC_DIVISOR,
  };
}

function round(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function round4(v) { return Math.round((Number(v) || 0) * 10000) / 10000; }

module.exports = { measureItem, measureItems, catalog, BOX_SIZES, PALLET_BASES };
