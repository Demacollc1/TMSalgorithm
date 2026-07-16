'use strict';

/* Pruebas del motor de optimización y utilidades geográficas. */

const assert = require('assert');
const { haversineKm, centroid, interpolate } = require('../src/geo');
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

console.log(`\n${passed} pruebas OK, ${failed} fallidas\n`);
process.exit(failed ? 1 : 0);
