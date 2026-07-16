'use strict';

const { haversineKm, centroid } = require('./geo');

/**
 * Optimizador de rutas (VRP) para última milla.
 *
 * Soporta:
 *  - Capacidad por vehículo (kg y m³)
 *  - Entregas y RECOLECCIONES mezcladas en una misma ruta,
 *    validando que la carga a bordo nunca exceda la capacidad
 *  - Modo MADRE NODRIZA: un vehículo de gran capacidad lleva la carga
 *    hasta puntos de transbordo; vehículos satélite reparten desde allí
 *  - Ventanas horarias blandas (se ordenan las paradas para minimizar
 *    llegadas fuera de ventana como criterio de desempate)
 *
 * Heurística: barrido angular (sweep) para asignar pedidos a vehículos,
 * vecino más cercano para construir cada ruta y mejora 2-opt.
 */

const DEFAULT_SPEED_KMH = 30; // velocidad media urbana
const SERVICE_MIN = 6; // minutos de atención por parada

function angleFrom(depot, p) {
  return Math.atan2(p.lat - depot.lat, p.lng - depot.lng);
}

function routeDistanceKm(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineKm(points[i - 1], points[i]);
  return d;
}

// --- Construcción: vecino más cercano desde un origen ---
function nearestNeighborOrder(origin, orders) {
  const remaining = orders.slice();
  const sequence = [];
  let current = origin;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    sequence.push(next);
    current = next;
  }
  return sequence;
}

// --- Mejora: 2-opt sobre la secuencia de paradas ---
function twoOpt(origin, sequence, returnToOrigin) {
  if (sequence.length < 3) return sequence;
  let best = sequence.slice();
  let improved = true;
  const pathPoints = (seq) => {
    const pts = [origin, ...seq];
    if (returnToOrigin) pts.push(origin);
    return pts;
  };
  let bestDist = routeDistanceKm(pathPoints(best));
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const d = routeDistanceKm(pathPoints(candidate));
        if (d < bestDist - 1e-9) {
          best = candidate;
          bestDist = d;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Verifica y repara la factibilidad de carga de una secuencia con
 * entregas y recolecciones. La carga inicial es la suma de entregas;
 * cada entrega descarga y cada recolección carga. Si en algún punto se
 * excede la capacidad, las recolecciones conflictivas se posponen hacia
 * el final de la ruta (cuando ya se liberó espacio).
 */
function repairPickupFeasibility(sequence, capacityKg) {
  const deliveries = sequence.filter((o) => o.type !== 'recoleccion');
  const initialLoad = deliveries.reduce((s, o) => s + (o.weightKg || 0), 0);
  const result = [];
  const deferred = [];
  let load = initialLoad;
  for (const stop of sequence) {
    if (stop.type === 'recoleccion') {
      if (load + (stop.weightKg || 0) > capacityKg + 1e-9) {
        deferred.push(stop); // aún no hay espacio: se recoge más tarde
        continue;
      }
      load += stop.weightKg || 0;
    } else {
      load -= stop.weightKg || 0;
    }
    result.push(stop);
    // intenta insertar recolecciones pospuestas apenas haya espacio
    for (let i = deferred.length - 1; i >= 0; i--) {
      if (load + (deferred[i].weightKg || 0) <= capacityKg + 1e-9) {
        load += deferred[i].weightKg || 0;
        result.push(deferred[i]);
        deferred.splice(i, 1);
      }
    }
  }
  // lo que siga pendiente va al final (la carga ya solo puede bajar)
  return result.concat(deferred);
}

// Ordena por inicio de ventana horaria como desempate estable
function timeWindowNudge(sequence) {
  return sequence
    .map((o, idx) => ({ o, idx }))
    .sort((a, b) => {
      const wa = a.o.timeWindow && a.o.timeWindow.start ? a.o.timeWindow.start : '';
      const wb = b.o.timeWindow && b.o.timeWindow.start ? b.o.timeWindow.start : '';
      if (wa && wb && wa !== wb) {
        // solo adelanta si además no empeora demasiado el orden espacial
        if (Math.abs(a.idx - b.idx) <= 2) return wa < wb ? -1 : 1;
      }
      return a.idx - b.idx;
    })
    .map((x) => x.o);
}

function buildStops(origin, sequence, startTimeMin, speedKmh) {
  let t = startTimeMin;
  let prev = origin;
  return sequence.map((order, i) => {
    const legKm = haversineKm(prev, order);
    t += (legKm / speedKmh) * 60;
    const eta = minutesToHHMM(t);
    t += SERVICE_MIN;
    prev = order;
    return {
      seq: i + 1,
      orderId: order.id,
      lat: order.lat,
      lng: order.lng,
      type: order.type,
      eta,
      status: 'pendiente',
    };
  });
}

function minutesToHHMM(mins) {
  const m = Math.round(mins) % (24 * 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Asignación por barrido angular respetando capacidad.
 * Devuelve un arreglo de "bolsas" de pedidos, una por vehículo.
 */
function sweepAssign(depot, orders, vehicles) {
  const sorted = orders
    .slice()
    .sort((a, b) => angleFrom(depot, a) - angleFrom(depot, b));
  const bags = vehicles.map(() => []);
  const loads = vehicles.map(() => ({ kg: 0, m3: 0 }));
  const unassigned = [];

  let v = 0;
  for (const order of sorted) {
    let placed = false;
    // intenta el vehículo actual y luego el resto, en orden circular
    for (let k = 0; k < vehicles.length; k++) {
      const idx = (v + k) % vehicles.length;
      const veh = vehicles[idx];
      const kg = loads[idx].kg + (order.weightKg || 0);
      const m3 = loads[idx].m3 + (order.volumeM3 || 0);
      if (kg <= veh.capacityKg && m3 <= (veh.capacityM3 || Infinity)) {
        bags[idx].push(order);
        loads[idx].kg = kg;
        loads[idx].m3 = m3;
        // avanza de vehículo cuando el actual supera el 85% de uso
        if (kg > veh.capacityKg * 0.85) v = (idx + 1) % vehicles.length;
        placed = true;
        break;
      }
    }
    if (!placed) unassigned.push(order);
  }
  return { bags, unassigned };
}

function buildRoute({ vehicle, orders, origin, returnToOrigin, startHHMM, meta }) {
  if (!orders.length) return null;
  let seq = nearestNeighborOrder(origin, orders);
  seq = twoOpt(origin, seq, returnToOrigin);
  seq = repairPickupFeasibility(seq, vehicle.capacityKg);
  seq = timeWindowNudge(seq);

  const points = [origin, ...seq];
  if (returnToOrigin) points.push(origin);
  const distanceKm = routeDistanceKm(points);
  const stops = buildStops(origin, seq, hhmmToMinutes(startHHMM), DEFAULT_SPEED_KMH);
  const durationMin =
    (distanceKm / DEFAULT_SPEED_KMH) * 60 + seq.length * SERVICE_MIN;
  const loadKg = orders
    .filter((o) => o.type !== 'recoleccion')
    .reduce((s, o) => s + (o.weightKg || 0), 0);
  const pickupKg = orders
    .filter((o) => o.type === 'recoleccion')
    .reduce((s, o) => s + (o.weightKg || 0), 0);

  return {
    vehicleId: vehicle.id,
    stops,
    origin,
    returnToOrigin,
    polyline: points.map((p) => [p.lat, p.lng]),
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMin: Math.round(durationMin),
    loadKg: Math.round(loadKg * 10) / 10,
    pickupKg: Math.round(pickupKg * 10) / 10,
    utilizationPct: Math.min(
      100,
      Math.round((Math.max(loadKg, pickupKg) / vehicle.capacityKg) * 100)
    ),
    ...meta,
  };
}

/**
 * Agrupación k-means simple para el modo nodriza (clusters geográficos).
 */
function kMeansClusters(orders, k, iterations = 12) {
  if (orders.length <= k) return orders.map((o) => [o]);
  // semillas: pedidos equiespaciados tras ordenar por ángulo desde el centroide
  const c = centroid(orders);
  const sorted = orders.slice().sort((a, b) => angleFrom(c, a) - angleFrom(c, b));
  let centers = [];
  for (let i = 0; i < k; i++) {
    centers.push(sorted[Math.floor((i * sorted.length) / k)]);
  }
  let clusters = [];
  for (let it = 0; it < iterations; it++) {
    clusters = centers.map(() => []);
    for (const o of orders) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = haversineKm(o, centers[i]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      clusters[best].push(o);
    }
    centers = clusters.map((cl, i) => (cl.length ? centroid(cl) : centers[i]));
  }
  return clusters.filter((cl) => cl.length);
}

/**
 * Punto de entrada del optimizador.
 *
 * @param {Object} params
 * @param {{lat:number,lng:number,name?:string}} params.depot
 * @param {Array} params.orders  pedidos con {id, lat, lng, type, weightKg, volumeM3, timeWindow}
 * @param {Array} params.vehicles vehículos con {id, capacityKg, capacityM3, isNodriza}
 * @param {Object} params.options {useNodriza, startTime, returnToDepot}
 * @returns {{routes: Array, unassigned: Array, summary: Object}}
 */
function optimize({ depot, orders, vehicles, options = {} }) {
  const startHHMM = options.startTime || '08:30';
  const returnToDepot = options.returnToDepot !== false;
  const useNodriza = !!options.useNodriza;

  const motherships = vehicles.filter((v) => v.isNodriza);
  const satellites = vehicles.filter((v) => !v.isNodriza);
  const routes = [];
  let unassigned = [];

  if (useNodriza && motherships.length && satellites.length) {
    // 1) agrupa pedidos en tantos clusters como vehículos satélite
    const clusters = kMeansClusters(orders, satellites.length);
    // 2) el punto de transbordo de cada cluster es su centroide
    const transferPoints = clusters.map((cl, i) => ({
      id: `TP-${i + 1}`,
      name: `Punto de transbordo ${i + 1}`,
      ...centroid(cl),
    }));
    // 3) la nodriza visita los puntos de transbordo (NN + 2-opt)
    const nodriza = motherships[0];
    const totalKg = orders.reduce((s, o) => s + (o.weightKg || 0), 0);
    let tpSeq = nearestNeighborOrder(depot, transferPoints);
    tpSeq = twoOpt(depot, tpSeq, returnToDepot);
    const nodrizaPoints = [depot, ...tpSeq];
    if (returnToDepot) nodrizaPoints.push(depot);
    routes.push({
      vehicleId: nodriza.id,
      isNodriza: true,
      stops: tpSeq.map((tp, i) => ({
        seq: i + 1,
        transferPointId: tp.id,
        name: tp.name,
        lat: tp.lat,
        lng: tp.lng,
        type: 'transbordo',
        eta: minutesToHHMM(
          hhmmToMinutes(startHHMM) +
            (routeDistanceKm(nodrizaPoints.slice(0, i + 2)) / DEFAULT_SPEED_KMH) * 60 +
            i * SERVICE_MIN * 2
        ),
        status: 'pendiente',
      })),
      origin: depot,
      returnToOrigin: returnToDepot,
      polyline: nodrizaPoints.map((p) => [p.lat, p.lng]),
      distanceKm: Math.round(routeDistanceKm(nodrizaPoints) * 100) / 100,
      durationMin: Math.round(
        (routeDistanceKm(nodrizaPoints) / DEFAULT_SPEED_KMH) * 60 +
          tpSeq.length * SERVICE_MIN * 2
      ),
      loadKg: Math.round(totalKg * 10) / 10,
      pickupKg: 0,
      utilizationPct: Math.min(100, Math.round((totalKg / nodriza.capacityKg) * 100)),
      transferPoints: tpSeq,
    });
    // 4) cada satélite reparte su cluster desde el punto de transbordo
    const tpByCluster = transferPoints;
    clusters.forEach((cluster, i) => {
      const vehicle = satellites[i % satellites.length];
      const tp = tpByCluster[i];
      const route = buildRoute({
        vehicle,
        orders: cluster,
        origin: { lat: tp.lat, lng: tp.lng, name: tp.name },
        returnToOrigin: false,
        startHHMM: minutesToHHMM(hhmmToMinutes(startHHMM) + 45),
        meta: { fedByNodriza: nodriza.id, transferPointId: tp.id },
      });
      if (route) routes.push(route);
    });
  } else {
    // VRP clásico: barrido + NN + 2-opt por vehículo
    const fleet = satellites.length ? satellites : vehicles;
    const { bags, unassigned: rest } = sweepAssign(depot, orders, fleet);
    unassigned = rest;
    bags.forEach((bag, i) => {
      const route = buildRoute({
        vehicle: fleet[i],
        orders: bag,
        origin: depot,
        returnToOrigin: returnToDepot,
        startHHMM,
        meta: {},
      });
      if (route) routes.push(route);
    });
  }

  const summary = {
    totalRoutes: routes.length,
    totalStops: routes.reduce(
      (s, r) => s + r.stops.filter((st) => st.orderId).length,
      0
    ),
    totalDistanceKm:
      Math.round(routes.reduce((s, r) => s + r.distanceKm, 0) * 100) / 100,
    totalDurationMin: routes.reduce((s, r) => s + r.durationMin, 0),
    unassignedCount: unassigned.length,
  };

  return { routes, unassigned, summary };
}

module.exports = {
  optimize,
  // expuestos para pruebas unitarias
  nearestNeighborOrder,
  twoOpt,
  repairPickupFeasibility,
  sweepAssign,
  kMeansClusters,
  routeDistanceKm,
};
