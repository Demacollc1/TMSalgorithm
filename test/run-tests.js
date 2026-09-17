'use strict';

/* Pruebas del motor de optimización y utilidades geográficas. */

const assert = require('assert');
const { haversineKm, centroid, interpolate } = require('../src/geo');
const { quote, TARIFF } = require('../src/pricing');
const { newTrackingCode, newApiKey } = require('../src/store');
const { classifyBulto, buildLoadingPlan, loadingSummary } = require('../src/loading');
const { mapPlan } = require('../src/importer');
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
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✘ ${name}\n    ${err.message}`);
  }
}

const DEPOT = { lat: -33.404, lng: -70.6883 };

function makeOrder(id, lat, lng, weightKg = 100, type = 'entrega') {
  return { id, lat, lng, weightKg, volumeM3: 0.5, type, timeWindow: { start: '09:00', end: '18:00' } };
}

console.log('\nGeo:');

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

console.log('\nConstrucción de rutas:');

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

console.log('\nRecolecciones (carga a bordo):');

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

console.log('\nAsignación por capacidad:');

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

console.log('\nOptimización completa:');

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

test('modo clásico: todos los pedidos quedan en alguna ruta', () => {
  const { routes, unassigned, summary } = optimize({
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

test('modo clásico: cada pedido aparece exactamente una vez', () => {
  const { routes } = optimize({ depot: DEPOT, orders: ORDERS, vehicles: FLEET, options: {} });
  const ids = routes.flatMap((r) => r.stops.filter((s) => s.orderId).map((s) => s.orderId));
  assert.strictEqual(new Set(ids).size, ids.length, 'hay pedidos duplicados entre rutas');
});

test('modo nodriza: genera ruta de transbordo + rutas satélite', () => {
  const { routes } = optimize({
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

test('las paradas incluyen ETA con formato HH:MM', () => {
  const { routes } = optimize({ depot: DEPOT, orders: ORDERS, vehicles: FLEET, options: {} });
  for (const r of routes) {
    for (const s of r.stops) {
      assert.ok(/^\d{2}:\d{2}$/.test(s.eta), `ETA inválida: ${s.eta}`);
    }
  }
});

console.log('\nCotizador de fletes:');

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

console.log('\nIdentificadores:');

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

console.log('\nMódulo de carga:');

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

console.log('\nImportador de planes (formato Driv.in):');

test('mapPlan: importa el plan de ejemplo del ERP', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'plan-demaco.json'), 'utf8'));
  const { orders, warnings } = mapPlan(raw);
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(orders.length, 1);
  const o = orders[0];
  assert.strictEqual(o.bultos.length, 29);
  assert.ok(o.lat < -2 && o.lat > -3, 'lat de Guayaquil');
  assert.ok(o.weightKg > 0);
  // el alt_code del ERP es el código de barras del bulto
  assert.ok(o.bultos.every((b) => b.barcode && b.barcode.startsWith('ST-')));
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

console.log('\nDatos reales (config driv.in):');

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

console.log('\nFacturación electrónica:');

test('claveAcceso: 49 dígitos numéricos con verificador módulo 11', () => {
  const clave = claveAcceso({ date: new Date(), docType: '01', ruc: '0999999999001', serie: '005002', secuencial: 123 });
  assert.strictEqual(clave.length, 49);
  assert.ok(/^\d{49}$/.test(clave));
  assert.strictEqual(Number(clave[48]), mod11(clave.slice(0, 48)));
});

console.log(`\n${passed} pruebas OK, ${failed} fallidas\n`);
process.exit(failed ? 1 : 0);
