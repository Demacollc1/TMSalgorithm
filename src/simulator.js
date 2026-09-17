'use strict';

const { haversineKm, interpolate, bearing } = require('./geo');
const { db, save, logEvent } = require('./store');
const { dispatchWebhooks } = require('./webhooks');

/**
 * Simulador GPS: mueve los vehículos de las rutas "en_curso" a lo largo
 * de su polilínea, marca llegadas a paradas, actualiza estados de
 * pedidos y genera prueba de entrega automática si está habilitado.
 */

const TICK_MS = 2000;
const SIM_SPEED_KMH = 400; // velocidad simulada (acelerada para demo)
const DWELL_TICKS = 3; // ticks detenido en cada parada

const state = new Map(); // routeId -> estado de simulación

function startRoute(route) {
  state.set(route.id, {
    legIndex: 0, // tramo actual de la polilínea
    legProgressKm: 0,
    dwell: 0,
    position: { lat: route.polyline[0][0], lng: route.polyline[0][1] },
    heading: 0,
  });
}

function stopRoute(routeId) {
  state.delete(routeId);
}

function orderById(id) {
  return db.orders.find((o) => o.id === id);
}

// estados finales de un pedido (confirmados por el conductor)
const FINAL_STATUSES = ['entregado', 'recolectado', 'no_entregado', 'entrega_parcial', 'devuelto', 'rechazado'];

// ¿la parada exige confirmación manual del conductor (bultos escaneables)?
function isManualStop(route, stop) {
  return !!(
    stop.orderId &&
    route.loadingPlan &&
    route.loadingPlan.some((b) => b.orderId === stop.orderId)
  );
}

function completeStop(route, stop) {
  stop.status = 'completada';
  stop.arrivedAt = new Date().toISOString();
  const order = stop.orderId ? orderById(stop.orderId) : null;
  if (order) {
    const done = order.type === 'recoleccion' ? 'recolectado' : 'entregado';
    order.status = done;
    order.pod = {
      at: stop.arrivedAt,
      receiver: 'Recepción conforme (simulado)',
      method: 'firma_digital',
      lat: stop.lat,
      lng: stop.lng,
    };
    logEvent('order.' + done, { orderId: order.id, code: order.code, routeId: route.id });
    dispatchWebhooks(
      'order.status_changed',
      {
        orderId: order.id,
        code: order.code,
        trackingCode: order.trackingCode,
        status: order.status,
        routeId: route.id,
        pod: order.pod,
      },
      { companyId: order.companyId }
    );
  } else if (stop.transferPointId) {
    logEvent('route.transbordo', { routeId: route.id, transferPointId: stop.transferPointId });
    dispatchWebhooks('route.transfer_completed', {
      routeId: route.id,
      transferPointId: stop.transferPointId,
    });
  }
}

function completeRoute(route) {
  route.status = 'completada';
  route.completedAt = new Date().toISOString();
  const vehicle = db.vehicles.find((v) => v.id === route.vehicleId);
  if (vehicle) vehicle.status = 'disponible';
  stopRoute(route.id);
  logEvent('route.completada', { routeId: route.id, vehicleId: route.vehicleId });
  dispatchWebhooks('route.completed', { routeId: route.id, vehicleId: route.vehicleId });
}

function tick() {
  let changed = false;
  for (const route of db.routes) {
    if (route.status !== 'en_curso') continue;
    const sim = state.get(route.id) || (startRoute(route), state.get(route.id));
    changed = true;

    if (sim.dwell > 0) {
      sim.dwell -= 1;
      continue;
    }

    // detenido en el cliente esperando la confirmación del conductor
    if (sim.holdStopSeq != null) {
      const stop = route.stops.find((s) => s.seq === sim.holdStopSeq);
      const order = stop && stop.orderId ? orderById(stop.orderId) : null;
      if (order && FINAL_STATUSES.includes(order.status)) {
        stop.status = 'completada';
        stop.arrivedAt = stop.arrivedAt || new Date().toISOString();
        sim.holdStopSeq = null;
        sim.dwell = DWELL_TICKS;
        // si era la última parada y no hay regreso, cierra la ruta
        if (sim.legIndex >= route.polyline.length - 1 && !route.stops.some((s) => s.status !== 'completada')) {
          completeRoute(route);
        }
      }
      continue;
    }

    const poly = route.polyline;
    if (sim.legIndex >= poly.length - 1) {
      completeRoute(route);
      continue;
    }

    const from = { lat: poly[sim.legIndex][0], lng: poly[sim.legIndex][1] };
    const to = { lat: poly[sim.legIndex + 1][0], lng: poly[sim.legIndex + 1][1] };
    const legKm = Math.max(haversineKm(from, to), 1e-6);
    sim.legProgressKm += (SIM_SPEED_KMH * TICK_MS) / 3600000;
    sim.heading = bearing(from, to);

    if (sim.legProgressKm >= legKm) {
      // llegó al final del tramo => es una parada (o el regreso al origen)
      sim.legIndex += 1;
      sim.legProgressKm = 0;
      sim.position = to;
      const stop = route.stops[sim.legIndex - 1];
      if (stop && stop.status !== 'completada') {
        const order = stop.orderId ? orderById(stop.orderId) : null;
        if (isManualStop(route, stop) && order && !FINAL_STATUSES.includes(order.status)) {
          // llegó al cliente: espera la confirmación del conductor
          stop.status = 'en_sitio';
          stop.arrivedAt = new Date().toISOString();
          sim.holdStopSeq = stop.seq;
          logEvent('route.en_sitio', { routeId: route.id, orderId: stop.orderId, seq: stop.seq });
        } else {
          completeStop(route, stop);
          sim.dwell = DWELL_TICKS;
        }
      }
      if (sim.legIndex >= poly.length - 1 && sim.holdStopSeq == null) {
        // si no hay regreso a origen, la última parada cierra la ruta
        const pendientes = route.stops.some((s) => s.status !== 'completada');
        if (!pendientes) completeRoute(route);
      }
    } else {
      sim.position = interpolate(from, to, sim.legProgressKm / legKm);
    }
  }
  if (changed) save();
}

function positions() {
  const out = [];
  for (const route of db.routes) {
    if (route.status !== 'en_curso') continue;
    const sim = state.get(route.id);
    if (!sim) continue;
    const vehicle = db.vehicles.find((v) => v.id === route.vehicleId);
    const driver = vehicle && db.drivers.find((d) => d.id === vehicle.driverId);
    const nextStop = route.stops.find((s) => s.status !== 'completada');
    out.push({
      routeId: route.id,
      vehicleId: route.vehicleId,
      plate: vehicle ? vehicle.plate : null,
      vehicleName: vehicle ? vehicle.name : null,
      driverName: driver ? driver.name : null,
      isNodriza: !!route.isNodriza,
      lat: sim.position.lat,
      lng: sim.position.lng,
      heading: Math.round(sim.heading),
      nextStop: nextStop
        ? { seq: nextStop.seq, orderId: nextStop.orderId || nextStop.transferPointId, eta: nextStop.eta }
        : null,
      completedStops: route.stops.filter((s) => s.status === 'completada').length,
      totalStops: route.stops.length,
      at: new Date().toISOString(),
    });
  }
  return out;
}

let timer = null;
function start() {
  if (!timer) timer = setInterval(tick, TICK_MS);
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, positions, startRoute, stopRoute };
