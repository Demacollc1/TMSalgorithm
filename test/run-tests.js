'use strict';

/* Pruebas del motor de optimización y utilidades geográficas. */

// ruteo offline en pruebas: matriz por distancia recta (rápido, determinista)
process.env.ROUTING_DISABLE = '1';

const assert = require('assert');
const { haversineKm, centroid, interpolate } = require('../src/geo');
const { quote, TARIFF } = require('../src/pricing');
const { newTrackingCode, newApiKey } = require('../src/store');
const { classifyBulto, buildLoadingPlan, loadingSummary } = require('../src/loading');
const { mapPlan, extractContainerId, parseContainerCode } = require('../src/importer');
const { claveAcceso, mod11 } = require('../src/billing');
const fs = require('fs');
const path = require('path');
const {
  optimize,
  nearestNeighborOrder,
  twoOpt,
  repairPickupFeasibility,
  sweepAssign,
  kMeansClusters,
  routeDistanceKm,
} = require('../src/optimizer');

let passed = 0;
let failed = 0;
// runner secuencial que soporta pruebas sync y async (await optimize)
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✔ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✘ ${name}\n    ${err.message}`);
    }
  });
}
function section(title) {
  chain = chain.then(() => console.log(title));
}

const DEPOT = { lat: -33.404, lng: -70.6883 };

function makeOrder(id, lat, lng, weightKg = 100, type = 'entrega') {
  return { id, lat, lng, weightKg, volumeM3: 0.5, type, timeWindow: { start: '09:00', end: '18:00' } };
}

section('\nGeo:');

test('haversine: Santiago–Valparaíso ≈ 100 km', () => {
  const stgo = { lat: -33.4489, lng: -70.6693 };
  const valpo = { lat: -33.0472, lng: -71.6127 };
  const d = haversineKm(stgo, valpo);
  assert.ok(d > 90 && d < 110, `distancia fuera de rango: ${d}`);
});

test('haversine: distancia a sí mismo es 0', () => {
  assert.strictEqual(haversineKm(DEPOT, DEPOT), 0);
});

test('centroid: promedio de puntos', () => {
  const c = centroid([{ lat: 0, lng: 0 }, { lat: 2, lng: 4 }]);
  assert.deepStrictEqual(c, { lat: 1, lng: 2 });
});

test('interpolate: punto medio', () => {
  const m = interpolate({ lat: 0, lng: 0 }, { lat: 2, lng: 2 }, 0.5);
  assert.deepStrictEqual(m, { lat: 1, lng: 1 });
});

section('\nConstrucción de rutas:');

test('vecino más cercano visita el punto más próximo primero', () => {
  const near = makeOrder('near', DEPOT.lat + 0.01, DEPOT.lng);
  const far = makeOrder('far', DEPOT.lat + 0.2, DEPOT.lng);
  const seq = nearestNeighborOrder(DEPOT, [far, near]);
  assert.strictEqual(seq[0].id, 'near');
});

test('2-opt no empeora la distancia', () => {
  const orders = [
    makeOrder('a', -33.42, -70.60),
    makeOrder('b', -33.50, -70.65),
    makeOrder('c', -33.44, -70.70),
    makeOrder('d', -33.39, -70.57),
    makeOrder('e', -33.53, -70.58),
  ];
  const nn = nearestNeighborOrder(DEPOT, orders);
  const before = routeDistanceKm([DEPOT, ...nn, DEPOT]);
  const improved = twoOpt(DEPOT, nn, true);
  const after = routeDistanceKm([DEPOT, ...improved, DEPOT]);
  assert.ok(after <= before + 1e-9, `2-opt empeoró: ${before} -> ${after}`);
  assert.strictEqual(improved.length, orders.length);
});

section('\nRecolecciones (carga a bordo):');

test('la carga nunca excede la capacidad con recolecciones', () => {
  // capacidad 300; entregas 250; recolección de 200 al inicio violaría capacidad
  const seq = [
    makeOrder('p1', 0, 0, 200, 'recoleccion'),
    makeOrder('d1', 0, 0, 150, 'entrega'),
    makeOrder('d2', 0, 0, 100, 'entrega'),
  ];
  const repaired = repairPickupFeasibility(seq, 300);
  assert.strictEqual(repaired.length, 3, 'no debe perder paradas');
  let load = repaired.filter((o) => o.type === 'entrega').reduce((s, o) => s + o.weightKg, 0);
  for (const stop of repaired) {
    load += stop.type === 'recoleccion' ? stop.weightKg : -stop.weightKg;
    assert.ok(load <= 300 + 1e-9, `capacidad excedida (${load} kg) en ${stop.id}`);
  }
});

test('recolección factible se mantiene en su posición', () => {
  const seq = [
    makeOrder('d1', 0, 0, 100, 'entrega'),
    makeOrder('p1', 0, 0, 50, 'recoleccion'),
    makeOrder('d2', 0, 0, 100, 'entrega'),
  ];
  const repaired = repairPickupFeasibility(seq, 500);
  assert.deepStrictEqual(repaired.map((o) => o.id), ['d1', 'p1', 'd2']);
});

section('\nAsignación por capacidad:');

test('sweep respeta capacidad y reporta no asignados', () => {
  const vehicles = [
    { id: 'v1', capacityKg: 200, capacityM3: 100 },
    { id: 'v2', capacityKg: 200, capacityM3: 100 },
  ];
  const orders = [
    makeOrder('o1', -33.42, -70.60, 150),
    makeOrder('o2', -33.50, -70.65, 150),
    makeOrder('o3', -33.44, -70.70, 150), // no cabe en ningún vehículo restante
  ];
  const { bags, unassigned } = sweepAssign(DEPOT, orders, vehicles);
  const assigned = bags.flat();
  assert.strictEqual(assigned.length + unassigned.length, 3);
  bags.forEach((bag, i) => {
    const kg = bag.reduce((s, o) => s + o.weightKg, 0);
    assert.ok(kg <= vehicles[i].capacityKg, `vehículo ${i} sobrecargado (${kg} kg)`);
  });
  assert.strictEqual(unassigned.length, 1);
});

section('\nOptimización completa:');

const FLEET = [
  { id: 'nodriza', capacityKg: 8000, capacityM3: 40, isNodriza: true },
  { id: 'van1', capacityKg: 1500, capacityM3: 10, isNodriza: false },
  { id: 'van2', capacityKg: 1500, capacityM3: 10, isNodriza: false },
];
const ORDERS = [
  makeOrder('o1', -33.4172, -70.6015, 180),
  makeOrder('o2', -33.4212, -70.6106, 95),
  makeOrder('o3', -33.4972, -70.6535, 240),
  makeOrder('o4', -33.4907, -70.6011, 120, 'recoleccion'),
  makeOrder('o5', -33.4826, -70.7541, 310),
  makeOrder('o6', -33.4093, -70.664, 75),
  makeOrder('o7', -33.5423, -70.5638, 210),
  makeOrder('o8', -33.3901, -70.5754, 88),
];

test('modo clásico: todos los pedidos quedan en alguna ruta', async () => {
  const { routes, unassigned, summary } = await optimize({
    depot: DEPOT,
    orders: ORDERS,
    vehicles: FLEET,
    options: { useNodriza: false },
  });
  const stops = routes.flatMap((r) => r.stops.filter((s) => s.orderId));
  assert.strictEqual(stops.length + unassigned.length, ORDERS.length);
  assert.strictEqual(unassigned.length, 0);
  assert.ok(summary.totalDistanceKm > 0);
  // ninguna ruta usa la nodriza en modo clásico
  assert.ok(routes.every((r) => r.vehicleId !== 'nodriza'));
});

test('modo clásico: cada pedido aparece exactamente una vez', async () => {
  const { routes } = await optimize({ depot: DEPOT, orders: ORDERS, vehicles: FLEET, options: {} });
  const ids = routes.flatMap((r) => r.stops.filter((s) => s.orderId).map((s) => s.orderId));
  assert.strictEqual(new Set(ids).size, ids.length, 'hay pedidos duplicados entre rutas');
});

test('modo nodriza: genera ruta de transbordo + rutas satélite', async () => {
  const { routes } = await optimize({
    depot: DEPOT,
    orders: ORDERS,
    vehicles: FLEET,
    options: { useNodriza: true },
  });
  const nodriza = routes.find((r) => r.isNodriza);
  assert.ok(nodriza, 'debe existir la ruta de la nodriza');
  assert.ok(nodriza.stops.every((s) => s.type === 'transbordo'));
  const satellites = routes.filter((r) => !r.isNodriza);
  assert.ok(satellites.length >= 1);
  assert.ok(satellites.every((r) => r.fedByNodriza === 'nodriza'));
  // los satélites cubren todos los pedidos
  const ids = satellites.flatMap((r) => r.stops.map((s) => s.orderId));
  assert.strictEqual(new Set(ids).size, ORDERS.length);
  // cada transbordo de la nodriza corresponde a un punto usado por un satélite
  const tpIds = nodriza.stops.map((s) => s.transferPointId);
  assert.ok(satellites.every((r) => tpIds.includes(r.transferPointId)));
});

test('kMeans: particiona sin perder pedidos', () => {
  const clusters = kMeansClusters(ORDERS, 3);
  const total = clusters.reduce((s, c) => s + c.length, 0);
  assert.strictEqual(total, ORDERS.length);
  assert.ok(clusters.length >= 1 && clusters.length <= 3);
});

test('las paradas incluyen ETA con formato HH:MM', async () => {
  const { routes } = await optimize({ depot: DEPOT, orders: ORDERS, vehicles: FLEET, options: {} });
  for (const r of routes) {
    for (const s of r.stops) {
      assert.ok(/^\d{2}:\d{2}$/.test(s.eta), `ETA inválida: ${s.eta}`);
    }
  }
});

section('\nCotizador de fletes:');

const STGO = { lat: -33.4489, lng: -70.6693 };
const LASCONDES = { lat: -33.4172, lng: -70.6015 };

test('quote: estructura y mínimos', () => {
  const q = quote({ origin: STGO, destination: LASCONDES, weightKg: 100 });
  assert.strictEqual(q.currency, 'USD');
  assert.ok(q.priceUsd >= TARIFF.minUsd);
  assert.ok(q.distanceKm > 0);
  assert.ok(q.breakdown.base === TARIFF.baseUsd);
});

test('quote: express cuesta más que normal y programado menos', () => {
  const base = { origin: STGO, destination: LASCONDES, weightKg: 100, volumeM3: 1 };
  const normal = quote({ ...base, service: 'normal' }).priceUsd;
  const express = quote({ ...base, service: 'express' }).priceUsd;
  const prog = quote({ ...base, service: 'programado' }).priceUsd;
  assert.ok(express > normal, `express (${express}) debe superar normal (${normal})`);
  assert.ok(prog <= normal, `programado (${prog}) no debe superar normal (${normal})`);
});

test('quote: más peso nunca abarata', () => {
  const light = quote({ origin: STGO, destination: LASCONDES, weightKg: 10 }).priceUsd;
  const heavy = quote({ origin: STGO, destination: LASCONDES, weightKg: 900 }).priceUsd;
  assert.ok(heavy >= light);
});

test('quote: valida coordenadas', () => {
  assert.throws(() => quote({ origin: STGO, destination: { lat: 'x' }, weightKg: 1 }));
});

section('\nTipos de paquete y peso facturable:');

const { measureItems, measureItem, catalog } = require('../src/packages');
const { quoteItems } = require('../src/pricing');

test('caja: peso volumétrico vs real', () => {
  const liviana = measureItem({ type: 'caja', size: 'A4', qty: 1 });
  assert.ok(liviana.billableKg > 0);
  const pesada = measureItem({ type: 'caja', size: 'A4', qty: 1, heavy: true, weightKg: 80 });
  assert.strictEqual(pesada.weightKg, 80);
  assert.ok(pesada.billableKg >= 80, 'una caja pesada factura por su peso real');
});

test('correspondencia es liviana y barata', () => {
  const m = measureItem({ type: 'correspondencia', qty: 3 });
  assert.ok(m.weightKg <= 2 && m.volumeM3 < 0.01);
});

test('pallet: requiere peso y penaliza no apilable', () => {
  assert.throws(() => measureItem({ type: 'pallet', base: '1x1', qty: 1 }));
  const apila = measureItem({ type: 'pallet', base: '1x1', qty: 1, weightKg: 500, stackable: true });
  const noApila = measureItem({ type: 'pallet', base: '1x1', qty: 1, weightKg: 500, stackable: false });
  assert.ok(noApila.volumeM3 > apila.volumeM3, 'el no apilable ocupa más volumen');
});

test('tuberia marca ítem largo (parrilla)', () => {
  const m = measureItems([{ type: 'tuberia', qty: 10, diameterMm: 50, lengthM: 6 }]);
  assert.ok(m.hasLongItems);
});

test('volumétrico exige dimensiones', () => {
  assert.throws(() => measureItem({ type: 'volumetrico', qty: 1, lengthCm: 0, widthCm: 10, heightCm: 10 }));
  const m = measureItem({ type: 'volumetrico', qty: 1, lengthCm: 100, widthCm: 100, heightCm: 100 });
  assert.ok(m.volumeM3 >= 1);
});

test('catálogo expone cajas A1..A6 con dimensiones', () => {
  const c = catalog();
  assert.strictEqual(c.cajas.length, 6);
  assert.ok(c.cajas.every((b) => b.l && b.w && b.h && b.maxKg === 50));
});

test('quoteItems: multi-parada suma recargo y distancia encadenada', () => {
  const base = { origin: { lat: -2.15, lng: -79.88 }, destination: { lat: -2.20, lng: -79.90 }, items: [{ type: 'caja', size: 'A4', qty: 2 }] };
  const sinParada = quoteItems(base);
  const conParada = quoteItems({ ...base, stops: [{ lat: -2.10, lng: -79.92 }] });
  assert.strictEqual(conParada.stops, 1);
  assert.ok(conParada.breakdown.paradasAdicionales > 0);
  assert.ok(conParada.priceUsd > sinParada.priceUsd);
  assert.strictEqual(conParada.currency, 'USD');
});

test('quoteItems: tubería agrega recargo de carga larga', () => {
  const q = quoteItems({ origin: { lat: -2.15, lng: -79.88 }, destination: { lat: -2.20, lng: -79.90 }, items: [{ type: 'tuberia', qty: 5, diameterMm: 50, lengthM: 6 }] });
  assert.ok(q.breakdown.cargaLarga > 0);
});

section('\nIdentificadores:');

test('trackingCode: formato MAC-XXXXXX y sin colisiones evidentes', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = newTrackingCode();
    assert.ok(/^MAC-[A-Z2-9]{6}$/.test(c), `formato inválido: ${c}`);
    seen.add(c);
  }
  assert.ok(seen.size > 195, 'demasiadas colisiones de códigos');
});

test('apiKey: prefijo mk_ y única', () => {
  const a = newApiKey();
  const b = newApiKey();
  assert.ok(a.startsWith('mk_') && a.length > 20);
  assert.notStrictEqual(a, b);
});

section('\nMódulo de carga:');

test('clasificación: tubos van a la parrilla', () => {
  const c = classifyBulto({ weightKg: 14, description: 'TUBO PVC PRESION 32mmx6m' });
  assert.strictEqual(c.cargoType, 'volumetrica');
  assert.strictEqual(c.zone, 'parrilla');
});

test('clasificación: sacos de cemento/empaste van a delantera-central', () => {
  for (const desc of ['BONDEX STANDARD CERAMICA 25 KG', 'SIKA EMPASTE INTERIOR BLANCO 20kg', 'CEMENTO ASFALTICO 20KG']) {
    const c = classifyBulto({ weightKg: 25, description: desc });
    assert.strictEqual(c.zone, 'delantera-central', desc);
  }
});

test('clasificación: paquetería liviana al cajón', () => {
  const c = classifyBulto({ weightKg: 6, description: 'CAJA GRIFERÍA Y REPUESTOS' });
  assert.strictEqual(c.cargoType, 'paqueteria');
  assert.strictEqual(c.zone, 'cajon');
});

function fakeRoute() {
  const orders = [
    { id: 'o1', code: 'P1', address: 'A1', customer: 'C1', bultos: [
      { containerId: 'b1', barcode: 'b1', description: 'CAJA LIVIANA', weightKg: 5, volumeM3: 0.01 },
      { containerId: 'b2', barcode: 'b2', description: 'SACO CEMENTO 25KG', weightKg: 25, volumeM3: 0.02 },
    ] },
    { id: 'o2', code: 'P2', address: 'A2', customer: 'C2', bultos: [
      { containerId: 'b3', barcode: 'b3', description: 'TUBO PVC 6m', weightKg: 14, volumeM3: 0.2 },
      { containerId: 'b4', barcode: 'b4', description: 'CAJA REPUESTOS', weightKg: 4, volumeM3: 0.01 },
    ] },
    { id: 'o3', code: 'P3', address: 'A3', customer: 'C3', bultos: [
      { containerId: 'b5', barcode: 'b5', description: 'CAJA PAQUETES', weightKg: 6, volumeM3: 0.01 },
    ] },
  ];
  const route = { stops: [
    { seq: 1, orderId: 'o1' }, { seq: 2, orderId: 'o2' }, { seq: 3, orderId: 'o3' },
  ] };
  return { route, orders };
}

test('secuencia: volumétrica primero, paquetería en orden inverso de entrega (LIFO)', () => {
  const { route, orders } = fakeRoute();
  const plan = buildLoadingPlan(route, orders);
  assert.strictEqual(plan.length, 5);
  // fase 1: el saco pesado primero
  assert.strictEqual(plan[0].barcode, 'b2');
  assert.strictEqual(plan[0].zone, 'delantera-central');
  // fase 2: el tubo a la parrilla
  assert.strictEqual(plan[1].barcode, 'b3');
  assert.strictEqual(plan[1].zone, 'parrilla');
  // fase 3: paquetería LIFO → parada 3 antes que parada 2 antes que parada 1
  const parcels = plan.filter((b) => b.phase === 3).map((b) => b.stopSeq);
  assert.deepStrictEqual(parcels, [3, 2, 1]);
});

test('secuencia: pedido sin bultos genera bulto único con su tracking', () => {
  const orders = [{ id: 'o9', code: 'P9', trackingCode: 'MAC-TEST01', address: 'X', customer: 'C', weightKg: 12, volumeM3: 0.1 }];
  const plan = buildLoadingPlan({ stops: [{ seq: 1, orderId: 'o9' }] }, orders);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].barcode, 'MAC-TEST01');
});

test('resumen: detecta carga completa', () => {
  const { route, orders } = fakeRoute();
  const plan = buildLoadingPlan(route, orders);
  assert.strictEqual(loadingSummary(plan).complete, false);
  plan.forEach((b) => (b.loaded = true));
  assert.strictEqual(loadingSummary(plan).complete, true);
});

section('\nImportador de planes (formato Driv.in):');

test('mapPlan: importa el plan de ejemplo del ERP', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'plan-demaco.json'), 'utf8'));
  const { orders, warnings } = mapPlan(raw);
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(orders.length, 1);
  const o = orders[0];
  assert.strictEqual(o.bultos.length, 29);
  assert.ok(o.lat < -2 && o.lat > -3, 'lat de Guayaquil');
  assert.ok(o.weightKg > 0);
  // el código de barras del bulto es el CONTAINER ID (segmento central
  // del code), no el alt_code
  assert.ok(o.bultos.every((b) => b.barcode && !b.barcode.startsWith('ST-')));
  assert.ok(o.bultos.every((b) => b.altCode && b.altCode.startsWith('ST-')));
  // los tubos del plan van a parrilla
  const tubos = o.bultos.filter((b) => /TUBO/i.test(b.description));
  assert.ok(tubos.length >= 1 && tubos.every((b) => b.zone === 'parrilla'));
  // los sacos pesados (BONDEX/EMPASTE) van a delantera-central
  const bondex = o.bultos.find((b) => /BONDEX/i.test(b.description));
  assert.strictEqual(bondex.zone, 'delantera-central');
});

test('mapPlan: rechaza formatos inválidos', () => {
  assert.throws(() => mapPlan({}));
  assert.throws(() => mapPlan(null));
});

test('extractContainerId: obtiene el Id. Contenedor del campo code', () => {
  assert.strictEqual(
    extractContainerId("ST-26007565-M0'144553'6.01'1-B87"),
    "M0'144553'6.01'1"
  );
  assert.strictEqual(
    extractContainerId("SO-26040646-B87'#A'111838'TU3'1-B87"),
    "B87'#A'111838'TU3'1"
  );
  assert.strictEqual(extractContainerId(null, 'ALT-1'), 'ALT-1');
});

test('parseContainerCode: distingue volumétrico (PAL/TU/TAN) de caja', () => {
  const pal = parseContainerCode("B87'#A'102607'PAL'1");
  assert.strictEqual(pal.family, 'volumetrica');
  assert.strictEqual(pal.productType, 'pallet');
  assert.strictEqual(pal.containerNum, '102607');
  assert.strictEqual(pal.qty, 1);

  const tub = parseContainerCode("B87'#A'111838'TU3'1");
  assert.strictEqual(tub.productType, 'tubos');
  assert.strictEqual(tub.productCode, 'TU3');

  const tan = parseContainerCode("B87'#A'090000'TAN'1");
  assert.strictEqual(tan.productType, 'tanque');

  const caja = parseContainerCode("M0'091739'0.20'3");
  assert.strictEqual(caja.family, 'caja');
  assert.strictEqual(caja.productType, 'caja');
  assert.strictEqual(caja.containerNum, '091739');
  assert.strictEqual(caja.codeWeightKg, 0.2);
  assert.strictEqual(caja.qty, 3);
});

test('classifyBulto: usa el tipo del código (tubos→parrilla, pallet→delantera)', () => {
  assert.strictEqual(classifyBulto({ productType: 'tubos', weightKg: 5 }).zone, 'parrilla');
  assert.strictEqual(classifyBulto({ productType: 'pallet', weightKg: 5 }).zone, 'delantera-central');
  assert.strictEqual(classifyBulto({ productType: 'tanque', weightKg: 5 }).zone, 'delantera-central');
  // una caja liviana sin palabras pesadas va al cajón como paquetería
  assert.strictEqual(classifyBulto({ productType: 'caja', weightKg: 3, description: 'Cerámica' }).zone, 'cajon');
});

section('\nRemolques plegables:');

const DEPOT2 = { lat: -2.15, lng: -79.88 };
const YARDS = [
  { id: 'y1', name: 'Acopio Norte', lat: -2.10, lng: -79.90 },
  { id: 'y2', name: 'Acopio Sur', lat: -2.25, lng: -79.89 },
];

function volOrder(id, lat, lng, weightKg, volumeM3) {
  return { id, lat, lng, weightKg, volumeM3, type: 'entrega', timeWindow: { start: '09:00', end: '18:00' } };
}

test('remolque: se acopla cuando falta volumen y el camión tiene bola', async () => {
  const vehicles = [{ id: 'v1', capacityKg: 5000, capacityM3: 20, hasTowHitch: true }];
  const trailers = [{ id: 't1', code: 'RMQ-01', capacityKg: 1500, capacityM3: 28, status: 'disponible' }];
  // 40 m³ de tubos/tanques livianos: no caben en 20 m³ sin remolque
  const orders = [
    volOrder('o1', -2.09, -79.91, 300, 15),
    volOrder('o2', -2.12, -79.92, 300, 15),
    volOrder('o3', -2.20, -79.90, 300, 10),
  ];
  const sin = await optimize({ depot: DEPOT2, orders, vehicles, trailers: [], yards: YARDS, options: {} });
  assert.ok(sin.unassigned.length > 0, 'sin remolque debe sobrar volumen');
  const con = await optimize({ depot: DEPOT2, orders, vehicles, trailers, yards: YARDS, options: {} });
  assert.strictEqual(con.unassigned.length, 0, 'con remolque todo debe caber');
  const route = con.routes[0];
  assert.strictEqual(route.trailerId, 't1');
  // la ruta incluye la parada de soltar y la de retirar el remolque
  const drop = route.stops.find((s) => s.trailerAction === 'drop');
  const pickup = route.stops.find((s) => s.trailerAction === 'pickup');
  assert.ok(drop, 'debe existir parada de soltado en acopio');
  assert.ok(pickup, 'por defecto se retira al final de la ruta');
  // el soltado ocurre cuando el remanente ya cabe en el camión solo
  const orderStops = route.stops.filter((s) => s.orderId);
  const dropIdx = route.stops.indexOf(drop);
  let remaining = route.ordersVolumeM3;
  for (const s of route.stops.slice(0, dropIdx)) if (s.orderId) remaining -= s._volumeM3 || 0;
  assert.ok(remaining <= vehicles[0].capacityM3 + 1e-9, 'al soltar, lo restante cabe en el camión');
  assert.ok(orderStops.length === 3);
});

test('remolque: opción dejar en acopio no agrega parada de retiro', async () => {
  const vehicles = [{ id: 'v1', capacityKg: 5000, capacityM3: 20, hasTowHitch: true }];
  const trailers = [{ id: 't1', code: 'RMQ-01', capacityKg: 1500, capacityM3: 28, status: 'disponible' }];
  const orders = [volOrder('o1', -2.09, -79.91, 300, 25), volOrder('o2', -2.20, -79.90, 300, 10)];
  const r = await optimize({ depot: DEPOT2, orders, vehicles, trailers, yards: YARDS, options: { trailerPickup: 'dejar' } });
  const route = r.routes[0];
  assert.ok(route.stops.some((s) => s.trailerAction === 'drop'));
  assert.ok(!route.stops.some((s) => s.trailerAction === 'pickup'));
  assert.strictEqual(route.trailerPickupAtEnd, false);
});

test('remolque: nunca se acopla a un vehículo sin bola', async () => {
  const vehicles = [{ id: 'v1', capacityKg: 5000, capacityM3: 20, hasTowHitch: false }];
  const trailers = [{ id: 't1', code: 'RMQ-01', capacityKg: 1500, capacityM3: 28, status: 'disponible' }];
  const orders = [volOrder('o1', -2.09, -79.91, 300, 25), volOrder('o2', -2.20, -79.90, 300, 10)];
  const r = await optimize({ depot: DEPOT2, orders, vehicles, trailers, yards: YARDS, options: {} });
  assert.ok(r.routes.every((x) => !x.trailerId));
  assert.ok(r.unassigned.length > 0, 'sin bola, el sobrante de volumen queda sin asignar');
});

test('remolque: la carga volumétrica previa al soltado va en fase 0 (remolque)', async () => {
  const vehicles = [{ id: 'v1', capacityKg: 5000, capacityM3: 20, hasTowHitch: true }];
  const trailers = [{ id: 't1', code: 'RMQ-01', capacityKg: 1500, capacityM3: 28, status: 'disponible' }];
  const orders = [
    { ...volOrder('o1', -2.09, -79.91, 300, 25), bultos: [{ containerId: 'c1', barcode: 'c1', description: 'TANQUE 1000L', weightKg: 300, volumeM3: 25 }] },
    { ...volOrder('o2', -2.20, -79.90, 100, 5), bultos: [{ containerId: 'c2', barcode: 'c2', description: 'CAJA ACCESORIOS', weightKg: 100, volumeM3: 5 }] },
  ];
  const r = await optimize({ depot: DEPOT2, orders, vehicles, trailers, yards: YARDS, options: {} });
  const route = r.routes[0];
  const plan = buildLoadingPlan(route, orders);
  const tanque = plan.find((b) => b.containerId === 'c1');
  assert.strictEqual(tanque.phase, 0, 'el tanque viaja en el remolque');
  assert.strictEqual(tanque.zone, 'remolque');
  assert.strictEqual(plan[0].containerId, 'c1', 'la fase 0 se carga primero');
});

section('\nDatos reales (config driv.in):');

test('buildFromConfig: mapea todas las entidades de DEMACO', () => {
  const { buildFromConfig } = require('../src/realdata');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'demaco-drivin.json'), 'utf8'));
  const data = buildFromConfig(raw);
  assert.strictEqual(data.vehicles.length, 21);
  assert.strictEqual(data.drivers.length, 29);
  assert.strictEqual(data.deposits.length, 6);
  assert.strictEqual(data.fleets.length, 6);
  assert.strictEqual(data.addresses.length, 1000);
  assert.strictEqual(data.schemas.length, 12);
  // el depósito principal es la Matriz
  assert.ok(/matriz/i.test(data.mainDepot.name));
  // capacidades convertidas: capacity_2=kg, capacity_3 cm³→m³
  const gmd = data.vehicles.find((v) => v.plate === 'GMD-0015');
  assert.strictEqual(gmd.capacityKg, 5500);
  assert.ok(Math.abs(gmd.capacityM3 - 23.63) < 0.01);
  // tag VIAJE marca los vehículos aptos para viaje
  assert.ok(data.vehicles.some((v) => v.isViaje));
  // conductores y peonetas separados
  assert.strictEqual(data.drivers.filter((d) => d.role === 'conductor').length, 15);
  assert.strictEqual(data.drivers.filter((d) => d.role === 'peoneta').length, 14);
  // esquemas con depósito y parámetros de ruteo
  const matriz = data.schemas.find((s) => s.name.includes('Matriz asig'));
  assert.strictEqual(matriz.serviceTimeMin, 20);
  assert.strictEqual(matriz.returnToDepot, true);
  assert.strictEqual(matriz.deposit.name, 'Demaco Matriz');
});

section('\nIA operativa y telemetría:');

const { pointToPolylineKm } = require('../src/geo');
const ai = require('../src/ai');
const { db } = require('../src/store');

test('pointToPolylineKm: detecta lejanía respecto de la ruta', () => {
  const poly = [[-2.15, -79.88], [-2.10, -79.90], [-2.05, -79.92]];
  assert.ok(pointToPolylineKm({ lat: -2.10, lng: -79.90 }, poly) < 0.05);
  assert.ok(pointToPolylineKm({ lat: -2.10, lng: -79.80 }, poly) > 5);
});

test('checkDeviation: crea consulta al chofer con un desvío grande', () => {
  const route = { id: 'RUT-T1', polyline: [[-2.15, -79.88], [-2.05, -79.92]], aiConsultas: [] };
  const c = ai.checkDeviation(route, { lat: -2.10, lng: -79.80 });
  assert.ok(c && c.status === 'pendiente');
  assert.ok(c.deviationKm > 0.5);
  // no duplica mientras haya una pendiente
  assert.strictEqual(ai.checkDeviation(route, { lat: -2.10, lng: -79.80 }), undefined);
  const ans = ai.answerConsulta(route, c.id, 'Tráfico / vía cerrada');
  assert.strictEqual(ans.status, 'respondida');
});

test('checkGeoDiscrepancy: crea caso cuando la entrega está lejos de la dirección', () => {
  const order = { id: 'ORD-T1', code: 'P-T1', customer: 'Cliente X', routeId: 'RUT-T1', lat: -2.15, lng: -79.88 };
  const kase = ai.checkGeoDiscrepancy(order, { lat: -2.16, lng: -79.87 });
  assert.ok(kase && kase.type === 'geo_discrepancia');
  // a 50 metros no crea caso
  assert.strictEqual(ai.checkGeoDiscrepancy({ ...order, id: 'ORD-T2' }, { lat: -2.1502, lng: -79.8801 }), undefined);
});

test('bestPosition: prioriza celular y cae a GPS del vehículo', () => {
  ai.recordTelemetry('VEH-T', 'gps_vehiculo', { lat: 1, lng: 2 });
  assert.strictEqual(ai.bestPosition('VEH-T').source, 'gps_vehiculo');
  ai.recordTelemetry('VEH-T', 'celular', { lat: 3, lng: 4 });
  assert.strictEqual(ai.bestPosition('VEH-T').source, 'celular');
  // celular viejo → respaldo
  db.telemetry['VEH-T'].celular.at = new Date(Date.now() - 10 * 60000).toISOString();
  assert.strictEqual(ai.bestPosition('VEH-T').source, 'gps_vehiculo');
});

test('loadingSummary: bulto no cargado con motivo cierra la carga', () => {
  const plan = [
    { seq: 1, loaded: true, weightKg: 10, volumeM3: 0.1, phase: 1 },
    { seq: 2, loaded: false, skipped: true, skipReason: 'faltante en bodega', weightKg: 5, volumeM3: 0.1, phase: 3 },
  ];
  const s = loadingSummary(plan);
  assert.strictEqual(s.skipped, 1);
  assert.strictEqual(s.pending, 0);
  assert.strictEqual(s.complete, true);
});

section('\nRuteo por calles y tráfico:');

const routing = require('../src/routing');

test('roadMatrix: fallback offline usa factor calle (> línea recta)', async () => {
  const pts = [{ lat: -2.15, lng: -79.88 }, { lat: -2.10, lng: -79.90 }];
  const m = await routing.roadMatrix(pts);
  assert.strictEqual(m.source, 'haversine'); // ROUTING_DISABLE=1 en pruebas
  const recta = haversineKm(pts[0], pts[1]);
  assert.ok(m.dist[0][1] > recta, 'la distancia por calle supera la recta');
  assert.ok(m.dur[0][1] > 0);
});

test('trafficMultiplier: hora pico pesa más que madrugada', () => {
  routing.configure({ enabled: false });
  assert.ok(routing.trafficMultiplier('08:00') > routing.trafficMultiplier('03:00'));
  assert.ok(routing.trafficMultiplier('18:00') > routing.trafficMultiplier('11:00'));
});

test('optimize: reporta la fuente de ruteo en el summary', async () => {
  const { summary } = await optimize({ depot: DEPOT, orders: ORDERS, vehicles: FLEET, options: {} });
  assert.ok(['osrm', 'haversine'].includes(summary.routing));
  assert.strictEqual(summary.routing, 'haversine'); // offline en pruebas
});

section('\nFacturación electrónica:');

test('claveAcceso: 49 dígitos numéricos con verificador módulo 11', () => {
  const clave = claveAcceso({ date: new Date(), docType: '01', ruc: '0999999999001', serie: '005002', secuencial: 123 });
  assert.strictEqual(clave.length, 49);
  assert.ok(/^\d{49}$/.test(clave));
  assert.strictEqual(Number(clave[48]), mod11(clave.slice(0, 48)));
});

chain.then(() => {
  console.log(`\n${passed} pruebas OK, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
});
