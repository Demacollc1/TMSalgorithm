'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { db, nextId, init, save, reset, logEvent, logIntegration, newApiKey, newTrackingCode } = require('./src/store');
const { optimize } = require('./src/optimizer');
const routing = require('./src/routing');
const { quote, quoteItems } = require('./src/pricing');
const packages = require('./src/packages');
const { mapPlan } = require('./src/importer');
const { buildLoadingPlan, loadingSummary } = require('./src/loading');
const { buildRouteDocuments } = require('./src/billing');
const { renderRoutePrint } = require('./src/printview');
const simulator = require('./src/simulator');
const ai = require('./src/ai');
const { dispatchWebhooks } = require('./src/webhooks');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------ helpers
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('payload demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function notFound(res, msg = 'Recurso no encontrado') {
  sendJSON(res, 404, { error: msg });
}

function badRequest(res, msg) {
  sendJSON(res, 400, { error: msg });
}

// Crea un pedido a partir de datos externos (TMS, portal público o API
// de integración). Lanza Error con mensaje legible si los datos no sirven.
function createOrder(it, { companyId = null, source = 'tms' } = {}) {
  if (typeof it.lat !== 'number' || typeof it.lng !== 'number') {
    throw new Error('Cada pedido requiere lat y lng numéricos');
  }
  const order = {
    id: nextId('ORD'),
    companyId,
    source,
    trackingCode: newTrackingCode(),
    price: typeof it.price === 'number' ? it.price : null,
    contact: it.contact || null,
    externalRef: it.externalRef || null,
    code: it.code || nextId('PED'),
    type: it.type === 'recoleccion' ? 'recoleccion' : 'entrega',
    address: it.address || '',
    commune: it.commune || '',
    lat: it.lat,
    lng: it.lng,
    weightKg: Number(it.weightKg) || 0,
    volumeM3: Number(it.volumeM3) || 0,
    timeWindow: it.timeWindow || { start: '09:00', end: '18:00' },
    customer: it.customer || '',
    date: it.date || new Date().toISOString().slice(0, 10),
    status: 'pendiente',
    priority: it.priority || 'normal',
    notes: it.notes || '',
    bultos: Array.isArray(it.bultos) ? it.bultos : [],
    pod: null,
    createdAt: new Date().toISOString(),
  };
  db.orders.push(order);
  return order;
}

// Vista pública de un pedido: solo lo que un cliente final debe ver
function publicTracking(order) {
  const route = order.routeId ? db.routes.find((r) => r.id === order.routeId) : null;
  const stop = route ? route.stops.find((s) => s.orderId === order.id) : null;
  const position =
    route && route.status === 'en_curso'
      ? simulator.positions().find((p) => p.routeId === route.id) || null
      : null;
  return {
    trackingCode: order.trackingCode,
    status: order.status,
    type: order.type,
    date: order.date,
    commune: order.commune,
    eta: stop ? stop.eta : null,
    createdAt: order.createdAt,
    vehiclePosition: position ? { lat: position.lat, lng: position.lng, at: position.at } : null,
    pod: order.pod
      ? { at: order.pod.at, receiver: order.pod.receiver, method: order.pod.method }
      : null,
    // ¿es la siguiente entrega de su ruta?
    nextUp: !!(route && route.status === 'en_curso' &&
      route.stops.find((s) => s.orderId && !['completada', 'delegada'].includes(s.status)) === stop),
    hasFeedback: !!order.feedback,
  };
}

// ------------------------------------------------------------ KPIs
function computeKpis() {
  const orders = db.orders;
  const total = orders.length;
  const done = orders.filter((o) => ['entregado', 'recolectado', 'entrega_parcial'].includes(o.status)).length;
  const failed = orders.filter((o) => ['no_entregado', 'devuelto', 'rechazado'].includes(o.status)).length;
  const inRoute = orders.filter((o) => o.status === 'en_ruta').length;
  const pending = orders.filter((o) => ['pendiente', 'asignado'].includes(o.status)).length;
  const activeRoutes = db.routes.filter((r) => r.status === 'en_curso').length;
  const plannedRoutes = db.routes.filter((r) => ['planificada', 'propuesta'].includes(r.status)).length;
  const completedRoutes = db.routes.filter((r) => r.status === 'completada').length;
  const totalKm = Math.round(db.routes.reduce((s, r) => s + (r.distanceKm || 0), 0) * 10) / 10;
  const byCommune = {};
  for (const o of orders) byCommune[o.commune || 'Otra'] = (byCommune[o.commune || 'Otra'] || 0) + 1;
  return {
    orders: { total, done, failed, inRoute, pending },
    compliancePct: total ? Math.round((done / Math.max(1, done + failed)) * 100) : 0,
    routes: { active: activeRoutes, planned: plannedRoutes, completed: completedRoutes },
    fleet: {
      total: db.vehicles.length,
      enRuta: db.vehicles.filter((v) => v.status === 'en_ruta').length,
    },
    totalKm,
    byCommune,
  };
}

// ------------------------------------------------------------ router
async function handleApi(req, res, pathname, query) {
  const parts = pathname.split('/').filter(Boolean); // ['api','v1',resource,id?,action?]
  const resource = parts[2];
  const id = parts[3];
  const action = parts[4];
  const method = req.method;

  // ---- pedidos -----------------------------------------------------
  if (resource === 'orders') {
    if (method === 'GET' && !id) {
      let list = db.orders;
      if (query.get('status')) list = list.filter((o) => o.status === query.get('status'));
      if (query.get('type')) list = list.filter((o) => o.type === query.get('type'));
      return sendJSON(res, 200, { data: list, count: list.length });
    }
    if (method === 'GET' && id) {
      const order = db.orders.find((o) => o.id === id || o.code === id);
      return order ? sendJSON(res, 200, { data: order }) : notFound(res);
    }
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      const items = Array.isArray(body) ? body : [body];
      const created = [];
      try {
        for (const it of items) {
          created.push(createOrder(it, { companyId: it.companyId || null, source: 'tms' }));
        }
      } catch (err) {
        return badRequest(res, err.message);
      }
      save();
      logEvent('order.created', { count: created.length });
      dispatchWebhooks('order.created', { orders: created.map((o) => o.id) });
      return sendJSON(res, 201, { data: Array.isArray(body) ? created : created[0] });
    }
    if (method === 'PUT' && id) {
      const order = db.orders.find((o) => o.id === id);
      if (!order) return notFound(res);
      const body = await readBody(req);
      const editable = ['address', 'commune', 'lat', 'lng', 'weightKg', 'volumeM3', 'timeWindow', 'customer', 'priority', 'notes', 'status', 'type', 'date'];
      for (const k of editable) if (k in body) order[k] = body[k];
      save();
      return sendJSON(res, 200, { data: order });
    }
    if (method === 'DELETE' && id) {
      const idx = db.orders.findIndex((o) => o.id === id);
      if (idx === -1) return notFound(res);
      const [removed] = db.orders.splice(idx, 1);
      save();
      return sendJSON(res, 200, { data: removed });
    }
    if (method === 'POST' && id && action === 'pod') {
      const order = db.orders.find((o) => o.id === id);
      if (!order) return notFound(res);
      const body = await readBody(req);
      order.pod = {
        at: new Date().toISOString(),
        receiver: body.receiver || 'Sin nombre',
        method: body.method || 'firma_digital',
        notes: body.notes || '',
        lat: order.lat,
        lng: order.lng,
      };
      order.status = body.failed
        ? 'no_entregado'
        : order.type === 'recoleccion'
          ? 'recolectado'
          : 'entregado';
      save();
      dispatchWebhooks(
        'order.status_changed',
        { orderId: order.id, trackingCode: order.trackingCode, status: order.status, pod: order.pod },
        { companyId: order.companyId }
      );
      return sendJSON(res, 200, { data: order });
    }
  }

  // ---- vehículos ---------------------------------------------------
  if (resource === 'vehicles') {
    if (method === 'GET' && !id) return sendJSON(res, 200, { data: db.vehicles, count: db.vehicles.length });
    if (method === 'GET' && id) {
      const v = db.vehicles.find((x) => x.id === id);
      return v ? sendJSON(res, 200, { data: v }) : notFound(res);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.plate) return badRequest(res, 'La patente (plate) es obligatoria');
      const vehicle = {
        id: nextId('VEH'),
        plate: body.plate,
        name: body.name || body.plate,
        type: body.type || 'van',
        capacityKg: Number(body.capacityKg) || 1000,
        capacityM3: Number(body.capacityM3) || 8,
        isNodriza: !!body.isNodriza,
        hasParrilla: !!body.hasParrilla,
        apto: body.apto !== false,
        aptoNotes: body.aptoNotes || '',
        driverId: body.driverId || null,
        status: body.apto === false ? 'no_apto' : 'disponible',
      };
      db.vehicles.push(vehicle);
      save();
      return sendJSON(res, 201, { data: vehicle });
    }
    if (method === 'PUT' && id) {
      const v = db.vehicles.find((x) => x.id === id);
      if (!v) return notFound(res);
      const body = await readBody(req);
      for (const k of ['plate', 'name', 'type', 'capacityKg', 'capacityM3', 'isNodriza', 'hasParrilla', 'apto', 'aptoNotes', 'driverId', 'status']) {
        if (k in body) v[k] = body[k];
      }
      // la aptitud manda sobre el estado operativo
      if ('apto' in body) {
        if (body.apto === false && v.status === 'disponible') v.status = 'no_apto';
        if (body.apto === true && v.status === 'no_apto') v.status = 'disponible';
      }
      save();
      return sendJSON(res, 200, { data: v });
    }
    if (method === 'DELETE' && id) {
      const idx = db.vehicles.findIndex((x) => x.id === id);
      if (idx === -1) return notFound(res);
      const [removed] = db.vehicles.splice(idx, 1);
      save();
      return sendJSON(res, 200, { data: removed });
    }
  }

  // ---- conductores -------------------------------------------------
  if (resource === 'drivers') {
    if (method === 'GET' && !id) return sendJSON(res, 200, { data: db.drivers, count: db.drivers.length });
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return badRequest(res, 'El nombre es obligatorio');
      const driver = {
        id: nextId('DRV'),
        name: body.name,
        phone: body.phone || '',
        license: body.license || 'B',
        status: 'disponible',
      };
      db.drivers.push(driver);
      save();
      return sendJSON(res, 201, { data: driver });
    }
    if (method === 'PUT' && id) {
      const d = db.drivers.find((x) => x.id === id);
      if (!d) return notFound(res);
      const body = await readBody(req);
      for (const k of ['name', 'phone', 'license', 'status']) if (k in body) d[k] = body[k];
      save();
      return sendJSON(res, 200, { data: d });
    }
    if (method === 'DELETE' && id) {
      const idx = db.drivers.findIndex((x) => x.id === id);
      if (idx === -1) return notFound(res);
      const [removed] = db.drivers.splice(idx, 1);
      save();
      return sendJSON(res, 200, { data: removed });
    }
  }

  // ---- optimización ------------------------------------------------
  if (resource === 'optimize' && method === 'POST') {
    const body = await readBody(req);
    const orderIds = body.orderIds && body.orderIds.length ? body.orderIds : null;
    const vehicleIds = body.vehicleIds && body.vehicleIds.length ? body.vehicleIds : null;
    const orders = db.orders.filter(
      (o) =>
        ['pendiente'].includes(o.status) && (!orderIds || orderIds.includes(o.id))
    );
    // solo vehículos aptos para viajar (matrícula/revisión/mantenimiento al día)
    const vehicles = db.vehicles.filter(
      (v) => v.status === 'disponible' && v.apto !== false && (!vehicleIds || vehicleIds.includes(v.id))
    );
    if (!orders.length) return badRequest(res, 'No hay pedidos pendientes para planificar');
    if (!vehicles.length) return badRequest(res, 'No hay vehículos disponibles y aptos para viajar');

    // esquema de ruteo: aporta depósito, tiempo de servicio, velocidad y retorno
    const options = { ...(body.options || {}) };
    let depot = db.company.depot;
    let schema = null;
    if (options.schemaId) {
      schema = db.schemas.find((s) => s.id === options.schemaId);
      if (!schema) return badRequest(res, 'Esquema no encontrado');
      if (schema.deposit) {
        depot = {
          name: schema.deposit.name,
          address: schema.deposit.address,
          lat: schema.deposit.lat,
          lng: schema.deposit.lng,
        };
      }
      if (options.returnToDepot === undefined) options.returnToDepot = schema.returnToDepot;
      if (!options.serviceTimeMin) options.serviceTimeMin = schema.serviceTimeMin;
      if (!options.speedKmh) options.speedKmh = Math.min(schema.maxSpeedKmh, 60);
    }
    if (options.depotId) {
      const dep = db.deposits.find((d) => d.id === options.depotId);
      if (!dep) return badRequest(res, 'Depósito no encontrado');
      depot = { name: dep.name, address: dep.address, lat: dep.lat, lng: dep.lng };
    }

    const result = await optimize({
      depot,
      orders,
      vehicles,
      trailers: db.trailers,
      yards: db.yards,
      options,
    });

    // materializa las rutas
    // las rutas nacen como PROPUESTA del planificador; el usuario las aprueba
    const created = result.routes.map((r) => {
      const route = {
        id: nextId('RUT'),
        date: body.date || new Date().toISOString().slice(0, 10),
        status: 'propuesta',
        schemaId: schema ? schema.id : null,
        schemaName: schema ? schema.name : null,
        depotName: depot.name,
        loadStatus: null,
        loadingPlan: null,
        documents: null,
        createdAt: new Date().toISOString(),
        ...r,
      };
      db.routes.push(route);
      for (const stop of route.stops) {
        if (!stop.orderId) continue;
        const order = db.orders.find((o) => o.id === stop.orderId);
        if (order) {
          order.status = 'asignado';
          order.routeId = route.id;
        }
      }
      // reserva el remolque acoplado por el planificador
      if (route.trailerId) {
        const trailer = db.trailers.find((t) => t.id === route.trailerId);
        if (trailer) {
          trailer.status = 'reservado';
          trailer.attachedToVehicleId = route.vehicleId;
        }
      }
      return route;
    });
    save();
    logEvent('routes.planned', { count: created.length, summary: result.summary });
    dispatchWebhooks('route.planned', { routeIds: created.map((r) => r.id), summary: result.summary });
    return sendJSON(res, 201, {
      data: { routes: created, unassigned: result.unassigned, summary: result.summary },
    });
  }

  // ---- rutas -------------------------------------------------------
  if (resource === 'routes') {
    if (method === 'GET' && !id) {
      let list = db.routes;
      if (query.get('status')) list = list.filter((r) => r.status === query.get('status'));
      return sendJSON(res, 200, { data: list, count: list.length });
    }
    if (method === 'GET' && id && !action) {
      const r = db.routes.find((x) => x.id === id);
      return r ? sendJSON(res, 200, { data: r }) : notFound(res);
    }
    // Aprobación de la ruta propuesta por el planificador
    if (method === 'POST' && id && action === 'approve') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (route.status !== 'propuesta') return badRequest(res, 'La ruta no está en estado propuesta');
      route.status = 'planificada';
      route.approvedAt = new Date().toISOString();
      route.loadingPlan = buildLoadingPlan(route, db.orders);
      route.loadStatus = 'pendiente';
      save();
      logEvent('route.aprobada', { routeId: route.id, bultos: route.loadingPlan.length });
      dispatchWebhooks('route.approved', { routeId: route.id });
      return sendJSON(res, 200, { data: route });
    }

    // Lista de carga (checklist de bultos en orden físico de carga)
    if (method === 'GET' && id && action === 'loading') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (!route.loadingPlan) return badRequest(res, 'La ruta aún no está aprobada');
      return sendJSON(res, 200, {
        data: { routeId: route.id, loadStatus: route.loadStatus, plan: route.loadingPlan, summary: loadingSummary(route.loadingPlan) },
      });
    }

    // Confirmación de carga de un bulto: por escáner ({barcode}) o por
    // botón ({seq, method:'manual'})
    if (method === 'POST' && id && action === 'load') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (!route.loadingPlan) return badRequest(res, 'La ruta aún no está aprobada');
      if (route.loadStatus === 'cargada') return badRequest(res, 'La carga ya fue confirmada por completo');
      const body = await readBody(req);
      let bulto = null;
      if (body.barcode) {
        const code = String(body.barcode).trim();
        // acepta container ID (etiqueta física), alt_code o código completo
        const matches = (b) =>
          b.barcode === code || b.containerId === code || b.containerNum === code ||
          b.altCode === code || b.sourceCode === code;
        bulto = route.loadingPlan.find((b) => !b.loaded && matches(b));
        if (!bulto) {
          const yaCargado = route.loadingPlan.find(matches);
          return sendJSON(res, 409, {
            error: yaCargado ? `El bulto ${code} ya fue cargado` : `Código ${code} no pertenece a esta ruta`,
          });
        }
      } else if (body.seq) {
        bulto = route.loadingPlan.find((b) => b.seq === Number(body.seq));
        if (!bulto) return notFound(res, 'Bulto no encontrado');
        if (bulto.loaded) return sendJSON(res, 409, { error: 'El bulto ya fue cargado' });
      } else {
        return badRequest(res, 'Envía barcode (escáner) o seq (confirmación manual)');
      }
      if (body.skip) {
        // marcar NO CARGADO con motivo (faltante, dañado, no cabe, etc.)
        if (!body.motivo) return badRequest(res, 'Indica el motivo del no cargado');
        bulto.skipped = true;
        bulto.skipReason = body.motivo;
        bulto.loaded = false;
        bulto.loadedAt = new Date().toISOString();
        const order = db.orders.find((o) => o.id === bulto.orderId);
        logEvent('load.no_cargado', { routeId: route.id, containerId: bulto.containerId, motivo: body.motivo });
        dispatchWebhooks(
          'load.skipped',
          { routeId: route.id, containerId: bulto.containerId, orderId: bulto.orderId, motivo: body.motivo },
          { companyId: order ? order.companyId : null }
        );
      } else {
        bulto.skipped = false;
        bulto.skipReason = null;
        bulto.loaded = true;
        bulto.loadedAt = new Date().toISOString();
        bulto.loadMethod = body.barcode ? 'scan' : 'manual';
      }
      route.loadStatus = 'en_carga';

      const summary = loadingSummary(route.loadingPlan);
      let documentsGenerated = false;
      if (summary.complete) {
        // carga completa: generar guías + facturas y notificar al webservice
        route.loadStatus = 'cargada';
        route.loadedAt = new Date().toISOString();
        const vehicle = db.vehicles.find((v) => v.id === route.vehicleId);
        const driver = vehicle && db.drivers.find((d) => d.id === vehicle.driverId);
        route.documents = buildRouteDocuments({
          route,
          orders: db.orders,
          vehicle,
          driver,
          billing: db.company.billing,
          nextSeq: () => ++db.billingSeq,
        });
        documentsGenerated = true;
        logEvent('route.cargada', { routeId: route.id, documentos: route.documents.length });
        dispatchWebhooks('route.loaded', { routeId: route.id, documents: route.documents.length });
        // envío del payload al webservice de facturación electrónica
        if (db.company.billing.webserviceUrl) {
          const { dispatchToUrl } = require('./src/webhooks');
          dispatchToUrl(db.company.billing.webserviceUrl, 'billing.route_loaded', {
            routeId: route.id,
            documents: route.documents,
          });
        }
      }
      save();
      return sendJSON(res, 200, {
        data: { bulto, summary, loadStatus: route.loadStatus, documentsGenerated },
      });
    }

    // Documentos (guías + facturas) generados al completar la carga
    if (method === 'GET' && id && action === 'documents') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (!route.documents) return badRequest(res, 'La carga aún no está completa; no hay documentos');
      return sendJSON(res, 200, { data: route.documents });
    }

    // Confirmación de entrega del conductor (por bulto, con novedades)
    if (method === 'POST' && id && action === 'deliver') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (route.status !== 'en_curso') return badRequest(res, 'La ruta no está en curso');
      const body = await readBody(req);
      const order = db.orders.find((o) => o.id === body.orderId && o.routeId === route.id);
      if (!order) return notFound(res, 'Pedido no encontrado en esta ruta');
      const resultado = ['entregado', 'entrega_parcial', 'devolucion', 'rechazado'].includes(body.resultado)
        ? body.resultado
        : 'entregado';
      const confirmed = new Set((body.bultoBarcodes || []).map((c) => String(c).trim()));
      const bultos = (route.loadingPlan || []).filter((b) => b.orderId === order.id);
      for (const b of bultos) {
        if (b.skipped) {
          // nunca subió al camión: queda como no cargado, no como fallo de entrega
          b.delivered = false;
          b.deliveryStatus = 'no_cargado';
          continue;
        }
        const wasConfirmed =
          confirmed.has(b.barcode) || confirmed.has(b.containerId) ||
          confirmed.has(b.altCode) || confirmed.has(b.sourceCode) ||
          resultado === 'entregado';
        b.delivered = wasConfirmed && resultado !== 'rechazado' && resultado !== 'devolucion';
        b.deliveredAt = new Date().toISOString();
        b.deliveryStatus =
          resultado === 'rechazado' ? 'rechazado'
          : resultado === 'devolucion' ? 'devuelto'
          : wasConfirmed ? 'entregado' : 'no_entregado';
      }
      order.status =
        resultado === 'entregado' ? (order.type === 'recoleccion' ? 'recolectado' : 'entregado')
        : resultado === 'entrega_parcial' ? 'entrega_parcial'
        : resultado === 'devolucion' ? 'devuelto'
        : 'rechazado';
      order.pod = {
        at: new Date().toISOString(),
        receiver: body.receptor || 'Sin nombre',
        method: body.bultoBarcodes && body.bultoBarcodes.length ? 'escaner' : 'boton',
        notes: body.motivo || '',
        resultado,
        bultosEntregados: bultos.filter((b) => b.deliveryStatus === 'entregado').length,
        bultosTotales: bultos.length,
        lat: order.lat,
        lng: order.lng,
      };
      // IA: discrepancia de geolocalización (posición real vs registrada)
      if (typeof body.lat === 'number' && typeof body.lng === 'number') {
        order.pod.actualLat = body.lat;
        order.pod.actualLng = body.lng;
        ai.checkGeoDiscrepancy(order, { lat: body.lat, lng: body.lng });
      }
      // IA: feedback si hubo demora alta o el cliente estaba cerrado
      const cerrado = /cerrad/i.test(body.motivo || '');
      if (order._delayFlag) {
        ai.requestFeedback(order, 'Tu entrega tomó más tiempo del planificado');
      } else if (cerrado || resultado === 'rechazado' || resultado === 'devolucion') {
        ai.requestFeedback(order, cerrado ? 'No pudimos entregarte porque el local estaba cerrado' : 'Tu entrega tuvo una novedad');
      }
      save();
      logEvent('order.' + order.status, { orderId: order.id, code: order.code, routeId: route.id, resultado });
      dispatchWebhooks(
        'order.status_changed',
        { orderId: order.id, trackingCode: order.trackingCode, status: order.status, resultado, pod: order.pod },
        { companyId: order.companyId }
      );
      return sendJSON(res, 200, { data: order });
    }

    // Delegación de un paquete (pedido) a otra ruta
    if (method === 'POST' && id && action === 'delegate') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      const body = await readBody(req);
      const order = db.orders.find((o) => o.id === body.orderId && o.routeId === route.id);
      if (!order) return notFound(res, 'Pedido no encontrado en esta ruta');
      const target = db.routes.find((x) => x.id === body.toRouteId);
      if (!target) return notFound(res, 'Ruta destino no encontrada');
      if (target.status !== 'planificada') {
        return badRequest(res, 'La ruta destino debe estar planificada (aprobada y aún no despachada)');
      }
      if (target.id === route.id) return badRequest(res, 'La ruta destino es la misma');
      const delegation = {
        id: nextId('DLG'),
        orderId: order.id,
        orderCode: order.code,
        customer: order.customer,
        fromRouteId: route.id,
        toRouteId: target.id,
        motivo: body.motivo || '',
        status: 'solicitada', // solicitada | aceptada | rechazada
        requestedAt: new Date().toISOString(),
        respondedAt: null,
      };
      db.delegations.unshift(delegation);
      save();
      logEvent('delegation.solicitada', { delegationId: delegation.id, orderCode: order.code, to: target.id });
      dispatchWebhooks('delegation.requested', delegation, { companyId: order.companyId });
      return sendJSON(res, 201, { data: delegation });
    }

    // Respuesta del chofer a una consulta de la IA (desvío de ruta)
    if (method === 'POST' && id && action === 'answer-consulta') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      const body = await readBody(req);
      const consulta = ai.answerConsulta(route, body.consultaId, body.answer, body.detail);
      if (!consulta) return notFound(res, 'Consulta no encontrada');
      save();
      return sendJSON(res, 200, { data: consulta });
    }

    // Informe final de ruta (IA)
    if (method === 'GET' && id && action === 'report') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      const report = route.aiReport || ai.buildRouteReport(route);
      return sendJSON(res, 200, { data: report });
    }

    // Gastos de ruta del chofer (vinculados a la ruta y opcionalmente a una parada)
    if (id && action === 'expenses') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (method === 'GET') {
        const list = db.expenses.filter((e) => e.routeId === route.id);
        return sendJSON(res, 200, {
          data: list,
          total: Math.round(list.reduce((s, e) => s + e.montoUsd, 0) * 100) / 100,
        });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const monto = Number(body.montoUsd);
        if (!body.tipo || !(monto > 0)) return badRequest(res, 'Se requieren tipo y montoUsd > 0');
        const expense = {
          id: nextId('GTO'),
          routeId: route.id,
          vehicleId: route.vehicleId,
          orderId: body.orderId || null, // parada vinculada
          tipo: body.tipo, // combustible | peaje | parqueo | alimentacion | viatico | reparacion | otro
          montoUsd: Math.round(monto * 100) / 100,
          notas: body.notas || '',
          lat: typeof body.lat === 'number' ? body.lat : null,
          lng: typeof body.lng === 'number' ? body.lng : null,
          at: new Date().toISOString(),
        };
        db.expenses.unshift(expense);
        save();
        logEvent('expense.registrado', { routeId: route.id, tipo: expense.tipo, montoUsd: expense.montoUsd });
        return sendJSON(res, 201, { data: expense });
      }
    }

    // Botón SOS / protocolo de emergencia (pantalla de cabina)
    if (method === 'POST' && id && action === 'sos') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      const body = await readBody(req);
      const kase = ai.createCase(
        'emergencia',
        { routeId: route.id, vehicleId: route.vehicleId, motivo: body.motivo || 'SOS activado', lat: body.lat, lng: body.lng },
        { title: `🚨 EMERGENCIA en ruta ${route.id}: ${body.motivo || 'SOS activado'}`, severity: 'alta' }
      );
      save();
      return sendJSON(res, 201, { data: kase });
    }

    // Simulación de escenarios para probar la IA (demo)
    if (method === 'POST' && id && action === 'simulate') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      const body = await readBody(req);
      if ('deviation' in body) route.simulateDeviation = !!body.deviation;
      if ('signalLoss' in body) route.simulateSignalLoss = !!body.signalLoss;
      save();
      return sendJSON(res, 200, {
        data: { simulateDeviation: !!route.simulateDeviation, simulateSignalLoss: !!route.simulateSignalLoss },
      });
    }

    if (method === 'POST' && id && action === 'start') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (route.status !== 'planificada') return badRequest(res, 'La ruta no está en estado planificada (¿falta aprobarla?)');
      if (route.loadingPlan && route.loadStatus !== 'cargada') {
        return badRequest(res, 'La carga no está confirmada: completa la lista de carga antes de despachar');
      }
      route.status = 'en_curso';
      route.startedAt = new Date().toISOString();
      const vehicle = db.vehicles.find((v) => v.id === route.vehicleId);
      if (vehicle) vehicle.status = 'en_ruta';
      if (route.trailerId) {
        const trailer = db.trailers.find((t) => t.id === route.trailerId);
        if (trailer) trailer.status = 'acoplado';
      }
      for (const stop of route.stops) {
        const order = stop.orderId && db.orders.find((o) => o.id === stop.orderId);
        if (order) order.status = 'en_ruta';
      }
      simulator.startRoute(route);
      save();
      logEvent('route.iniciada', { routeId: route.id, vehicleId: route.vehicleId });
      dispatchWebhooks('route.started', { routeId: route.id, vehicleId: route.vehicleId });
      return sendJSON(res, 200, { data: route });
    }
    if (method === 'DELETE' && id) {
      const idx = db.routes.findIndex((x) => x.id === id);
      if (idx === -1) return notFound(res);
      const [route] = db.routes.splice(idx, 1);
      simulator.stopRoute(route.id);
      for (const stop of route.stops) {
        const order = stop.orderId && db.orders.find((o) => o.id === stop.orderId);
        if (order && !['entregado', 'recolectado', 'no_entregado'].includes(order.status)) {
          order.status = 'pendiente';
          delete order.routeId;
        }
      }
      const vehicle = db.vehicles.find((v) => v.id === route.vehicleId);
      if (vehicle && vehicle.status === 'en_ruta') vehicle.status = 'disponible';
      // libera el remolque si la ruta lo tenía reservado o acoplado
      if (route.trailerId) {
        const trailer = db.trailers.find((t) => t.id === route.trailerId);
        if (trailer && ['reservado', 'acoplado'].includes(trailer.status)) {
          trailer.status = 'disponible';
          trailer.attachedToVehicleId = null;
        }
      }
      save();
      return sendJSON(res, 200, { data: route });
    }
  }

  // ---- monitoreo ---------------------------------------------------
  if (resource === 'tracking' && method === 'GET') {
    return sendJSON(res, 200, { data: simulator.positions() });
  }

  // ---- KPIs y eventos ---------------------------------------------
  if (resource === 'kpis' && method === 'GET') {
    return sendJSON(res, 200, { data: computeKpis() });
  }
  if (resource === 'events' && method === 'GET') {
    return sendJSON(res, 200, { data: db.events.slice(0, 50) });
  }

  // ---- webhooks ----------------------------------------------------
  if (resource === 'webhooks') {
    if (method === 'GET') return sendJSON(res, 200, { data: db.webhooks });
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      if (!body.url) return badRequest(res, 'La URL es obligatoria');
      const hook = {
        id: nextId('WHK'),
        url: body.url,
        events: Array.isArray(body.events) && body.events.length ? body.events : ['*'],
        active: true,
        createdAt: new Date().toISOString(),
      };
      db.webhooks.push(hook);
      save();
      return sendJSON(res, 201, { data: hook });
    }
    if (method === 'DELETE' && id) {
      const idx = db.webhooks.findIndex((w) => w.id === id);
      if (idx === -1) return notFound(res);
      const [removed] = db.webhooks.splice(idx, 1);
      save();
      return sendJSON(res, 200, { data: removed });
    }
  }

  // ---- catálogos de configuración (datos reales) ------------------
  if (resource === 'deposits' && method === 'GET') {
    return sendJSON(res, 200, { data: db.deposits, count: db.deposits.length });
  }
  if (resource === 'fleets' && method === 'GET') {
    return sendJSON(res, 200, { data: db.fleets, count: db.fleets.length });
  }
  if (resource === 'schemas' && method === 'GET') {
    return sendJSON(res, 200, { data: db.schemas, count: db.schemas.length });
  }
  if (resource === 'employers' && method === 'GET') {
    return sendJSON(res, 200, { data: db.employers, count: db.employers.length });
  }

  // ---- remolques y puntos de acopio -------------------------------
  if (resource === 'trailers') {
    if (method === 'GET') return sendJSON(res, 200, { data: db.trailers, count: db.trailers.length });
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      if (!body.code) return badRequest(res, 'El código del remolque es obligatorio');
      const trailer = {
        id: nextId('TRL'),
        code: body.code,
        name: body.name || body.code,
        capacityKg: Number(body.capacityKg) || 1000,
        capacityM3: Number(body.capacityM3) || 20,
        foldable: body.foldable !== false,
        status: 'disponible',
        locationName: db.company.depot.name,
        lat: db.company.depot.lat,
        lng: db.company.depot.lng,
        attachedToVehicleId: null,
      };
      db.trailers.push(trailer);
      save();
      return sendJSON(res, 201, { data: trailer });
    }
    if (method === 'PUT' && id) {
      const t = db.trailers.find((x) => x.id === id);
      if (!t) return notFound(res);
      const body = await readBody(req);
      for (const k of ['code', 'name', 'capacityKg', 'capacityM3', 'foldable', 'status', 'locationName', 'lat', 'lng']) {
        if (k in body) t[k] = body[k];
      }
      if (body.status === 'disponible') t.attachedToVehicleId = null;
      save();
      return sendJSON(res, 200, { data: t });
    }
    if (method === 'DELETE' && id) {
      const idx = db.trailers.findIndex((x) => x.id === id);
      if (idx === -1) return notFound(res);
      if (db.trailers[idx].status === 'acoplado' || db.trailers[idx].status === 'reservado') {
        return badRequest(res, 'El remolque está asignado a una ruta; libéralo primero');
      }
      const [removed] = db.trailers.splice(idx, 1);
      save();
      return sendJSON(res, 200, { data: removed });
    }
  }
  if (resource === 'yards') {
    if (method === 'GET') return sendJSON(res, 200, { data: db.yards, count: db.yards.length });
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      if (!body.name || typeof body.lat !== 'number' || typeof body.lng !== 'number') {
        return badRequest(res, 'Se requieren name, lat y lng');
      }
      const yard = { id: nextId('YRD'), name: body.name, city: body.city || '', lat: body.lat, lng: body.lng };
      db.yards.push(yard);
      save();
      return sendJSON(res, 201, { data: yard });
    }
    if (method === 'DELETE' && id) {
      const idx = db.yards.findIndex((x) => x.id === id);
      if (idx === -1) return notFound(res);
      const [removed] = db.yards.splice(idx, 1);
      save();
      return sendJSON(res, 200, { data: removed });
    }
  }

  // ---- maestro de direcciones -------------------------------------
  if (resource === 'addresses') {
    if (method === 'GET' && id === 'kpis') {
      const total = db.addresses.length;
      const georef = db.addresses.filter((a) => a.isGeoref).length;
      const clients = new Set(db.addresses.map((a) => a.client).filter(Boolean)).size;
      return sendJSON(res, 200, {
        data: { total, clients, georef, noGeoref: total - georef },
      });
    }
    if (method === 'GET' && !id) {
      let list = db.addresses;
      const q = (query.get('q') || '').toLowerCase();
      if (q) {
        list = list.filter(
          (a) =>
            (a.name || '').toLowerCase().includes(q) ||
            (a.client || '').toLowerCase().includes(q) ||
            (a.address || '').toLowerCase().includes(q) ||
            (a.code || '').toLowerCase().includes(q) ||
            (a.city || '').toLowerCase().includes(q)
        );
      }
      if (query.get('georef') === 'true') list = list.filter((a) => a.isGeoref);
      if (query.get('georef') === 'false') list = list.filter((a) => !a.isGeoref);
      const limit = Math.min(Number(query.get('limit')) || 100, 500);
      return sendJSON(res, 200, { data: list.slice(0, limit), count: list.length });
    }
    if (method === 'PUT' && id) {
      const a = db.addresses.find((x) => x.id === id);
      if (!a) return notFound(res);
      const body = await readBody(req);
      for (const k of ['name', 'client', 'address', 'reference', 'city', 'province', 'type', 'lat', 'lng', 'contact']) {
        if (k in body) a[k] = body[k];
      }
      if (typeof a.lat === 'number' && typeof a.lng === 'number') a.isGeoref = true;
      save();
      return sendJSON(res, 200, { data: a });
    }
  }

  // ---- importación de planes (formato Driv.in del ERP) ------------
  if (resource === 'import' && method === 'POST') {
    const body = await readBody(req);
    let mapped;
    try {
      mapped = mapPlan(body.plan || body);
    } catch (err) {
      return badRequest(res, err.message);
    }
    const companyId = body.companyId || (db.companies.find((c) => c.type === 'erp') || {}).id || null;
    const created = [];
    try {
      for (const o of mapped.orders) {
        created.push(createOrder(o, { companyId, source: 'plan-import' }));
      }
    } catch (err) {
      return badRequest(res, err.message);
    }
    save();
    logEvent('plan.imported', {
      orders: created.length,
      bultos: created.reduce((s, o) => s + o.bultos.length, 0),
    });
    dispatchWebhooks('order.created', { orders: created.map((o) => o.id), source: 'plan-import' });
    return sendJSON(res, 201, {
      data: {
        orders: created.map((o) => ({ id: o.id, code: o.code, trackingCode: o.trackingCode, customer: o.customer, bultos: o.bultos.length })),
        warnings: mapped.warnings,
      },
    });
  }

  // ---- delegaciones de paquetes entre rutas -----------------------
  if (resource === 'delegations') {
    if (method === 'GET' && !id) {
      let list = db.delegations;
      if (query.get('toRouteId')) list = list.filter((d) => d.toRouteId === query.get('toRouteId'));
      if (query.get('status')) list = list.filter((d) => d.status === query.get('status'));
      return sendJSON(res, 200, { data: list, count: list.length });
    }
    if (method === 'POST' && id && (action === 'accept' || action === 'reject')) {
      const delegation = db.delegations.find((d) => d.id === id);
      if (!delegation) return notFound(res);
      if (delegation.status !== 'solicitada') return badRequest(res, 'La solicitud ya fue respondida');
      const body = await readBody(req);
      delegation.respondedAt = new Date().toISOString();
      if (action === 'reject') {
        delegation.status = 'rechazada';
        delegation.responseNotes = body.motivo || '';
        save();
        return sendJSON(res, 200, { data: delegation });
      }
      // aceptar: mueve el pedido (y sus bultos) de una ruta a la otra
      const from = db.routes.find((r) => r.id === delegation.fromRouteId);
      const to = db.routes.find((r) => r.id === delegation.toRouteId);
      const order = db.orders.find((o) => o.id === delegation.orderId);
      if (!from || !to || !order) return badRequest(res, 'Ruta u orden ya no existen');
      if (to.status !== 'planificada') return badRequest(res, 'La ruta destino ya no está planificada');
      // 1) en la ruta origen la parada queda como delegada
      const stop = from.stops.find((s) => s.orderId === order.id);
      if (stop) stop.status = 'delegada';
      // 2) se agrega la parada al final de la ruta destino
      const lastEta = (to.stops.filter((s) => s.eta).slice(-1)[0] || {}).eta || '17:00';
      to.stops.push({
        seq: to.stops.length + 1,
        orderId: order.id,
        lat: order.lat,
        lng: order.lng,
        type: order.type,
        _volumeM3: order.volumeM3 || 0,
        eta: lastEta,
        status: 'pendiente',
        delegatedFrom: from.id,
      });
      const pts = [to.origin, ...to.stops.filter((s) => s.status !== 'delegada').map((s) => ({ lat: s.lat, lng: s.lng }))];
      if (to.returnToOrigin) pts.push(to.origin);
      to.polyline = pts.map((p) => [p.lat, p.lng]);
      // 3) los bultos pasan a la lista de carga destino (deben re-escanearse)
      const moved = (from.loadingPlan || []).filter((b) => b.orderId === order.id);
      from.loadingPlan = (from.loadingPlan || []).filter((b) => b.orderId !== order.id);
      if (to.loadingPlan) {
        let seq = to.loadingPlan.length;
        for (const b of moved) {
          to.loadingPlan.push({ ...b, seq: ++seq, loaded: false, loadedAt: null, loadMethod: null, skipped: false, skipReason: null });
        }
        if (to.loadStatus === 'cargada') to.loadStatus = 'en_carga';
      }
      order.routeId = to.id;
      delegation.status = 'aceptada';
      save();
      logEvent('delegation.aceptada', { delegationId: delegation.id, orderCode: order.code, from: from.id, to: to.id });
      dispatchWebhooks('delegation.accepted', delegation, { companyId: order.companyId });
      return sendJSON(res, 200, { data: delegation });
    }
  }

  // ---- casos, notificaciones e IA ---------------------------------
  if (resource === 'cases') {
    if (method === 'GET' && !id) {
      let list = db.cases;
      if (query.get('status')) list = list.filter((c) => c.status === query.get('status'));
      return sendJSON(res, 200, { data: list.slice(0, 100), count: list.length });
    }
    if (method === 'PUT' && id) {
      const kase = db.cases.find((c) => c.id === id);
      if (!kase) return notFound(res);
      const body = await readBody(req);
      if (body.action === 'corregir_geo' && kase.type === 'geo_discrepancia') {
        // corrige la geolocalización registrada con la posición real
        const order = db.orders.find((o) => o.id === kase.data.orderId);
        if (order && kase.data.real) {
          order.lat = kase.data.real.lat;
          order.lng = kase.data.real.lng;
          const addr = db.addresses.find(
            (a) => a.client === order.customer || (order.externalRef && a.externalId === Number(order.externalRef))
          );
          if (addr) {
            addr.lat = kase.data.real.lat;
            addr.lng = kase.data.real.lng;
            addr.isGeoref = true;
          }
        }
        kase.status = 'resuelto';
        kase.resolution = 'geolocalización corregida con la posición real de la entrega';
      } else if (body.action === 'descartar') {
        kase.status = 'descartado';
        kase.resolution = body.notes || 'descartado';
      } else {
        kase.status = 'resuelto';
        kase.resolution = body.notes || 'resuelto';
      }
      kase.resolvedAt = new Date().toISOString();
      save();
      return sendJSON(res, 200, { data: kase });
    }
  }
  if (resource === 'notifications' && method === 'GET') {
    return sendJSON(res, 200, { data: db.notifications.slice(0, 100) });
  }
  if (resource === 'expenses' && method === 'GET') {
    return sendJSON(res, 200, {
      data: db.expenses.slice(0, 200),
      total: Math.round(db.expenses.reduce((s, e) => s + e.montoUsd, 0) * 100) / 100,
    });
  }
  if (resource === 'ai-config') {
    if (method === 'GET') return sendJSON(res, 200, { data: db.company.ai });
    if (method === 'PUT') {
      const body = await readBody(req);
      for (const k of ['enabled', 'webserviceUrl', 'deviationKm', 'geoDiscrepancyKm', 'delayHoldTicks']) {
        if (k in body) db.company.ai[k] = body[k];
      }
      save();
      return sendJSON(res, 200, { data: db.company.ai });
    }
  }
  if (resource === 'routing-config') {
    // diagnóstico en vivo: prueba una llamada real a OSRM y reporta el error
    if (method === 'GET' && id === 'diag') {
      routing.configure(db.company.routing);
      const result = await routing.probe();
      return sendJSON(res, 200, { data: { ...result, status: routing.getStatus() } });
    }
    if (method === 'GET') return sendJSON(res, 200, { data: db.company.routing });
    if (method === 'PUT') {
      const body = await readBody(req);
      for (const k of ['enabled', 'provider', 'osrmUrl', 'apiKey', 'streetFactor', 'avgSpeedKmh']) {
        if (k in body) db.company.routing[k] = body[k];
      }
      routing.configure(db.company.routing);
      save();
      return sendJSON(res, 200, { data: db.company.routing });
    }
  }

  // ---- telemetría multi-fuente (GPS del vehículo / dashcam) -------
  if (resource === 'telemetry') {
    if (method === 'POST') {
      const body = await readBody(req);
      const vehicle = db.vehicles.find(
        (v) => v.deviceToken === body.token || v.plate === body.plate
      );
      if (!vehicle || (body.token && vehicle.deviceToken !== body.token)) {
        return sendJSON(res, 401, { error: 'Token de dispositivo inválido' });
      }
      const source = ['celular', 'gps_vehiculo', 'dashcam'].includes(body.source) ? body.source : 'gps_vehiculo';
      if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
        return badRequest(res, 'lat y lng numéricos son obligatorios');
      }
      ai.recordTelemetry(vehicle.id, source, {
        lat: body.lat,
        lng: body.lng,
        speedKmh: body.speedKmh || null,
        heading: body.heading || null,
        event: body.event || null,
      });
      // eventos de pánico desde el GPS físico o la dashcam
      if (['sos', 'panic', 'boton_panico'].includes(String(body.event || '').toLowerCase())) {
        const route = db.routes.find((r) => r.vehicleId === vehicle.id && r.status === 'en_curso');
        ai.createCase(
          'emergencia',
          { vehicleId: vehicle.id, routeId: route ? route.id : null, fuente: source, lat: body.lat, lng: body.lng },
          { title: `🚨 Botón de pánico (${source}) en ${vehicle.plate}`, severity: 'alta' }
        );
      }
      save();
      return sendJSON(res, 200, { data: { ok: true, vehicleId: vehicle.id, source } });
    }
    if (method === 'GET') {
      const out = db.vehicles.map((v) => ({
        vehicleId: v.id,
        plate: v.plate,
        sources: db.telemetry[v.id] || {},
        best: ai.bestPosition(v.id),
      }));
      return sendJSON(res, 200, { data: out });
    }
  }

  // ---- configuración de facturación electrónica -------------------
  if (resource === 'billing-config') {
    if (method === 'GET') return sendJSON(res, 200, { data: db.company.billing });
    if (method === 'PUT') {
      const body = await readBody(req);
      for (const k of ['razonSocial', 'ruc', 'direccion', 'establecimiento', 'puntoEmision', 'ivaPct', 'webserviceUrl']) {
        if (k in body) db.company.billing[k] = body[k];
      }
      save();
      return sendJSON(res, 200, { data: db.company.billing });
    }
  }

  // ---- empresas cliente (tenants) ---------------------------------
  if (resource === 'companies') {
    if (method === 'GET' && !id) return sendJSON(res, 200, { data: db.companies, count: db.companies.length });
    if (method === 'GET' && id) {
      const c = db.companies.find((x) => x.id === id);
      return c ? sendJSON(res, 200, { data: c }) : notFound(res);
    }
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      if (!body.name) return badRequest(res, 'El nombre es obligatorio');
      const company = {
        id: nextId('CMP'),
        name: body.name,
        type: ['erp', 'ecommerce', 'portal'].includes(body.type) ? body.type : 'erp',
        contactEmail: body.contactEmail || '',
        apiKey: newApiKey(),
        webhookUrl: body.webhookUrl || '',
        active: true,
        createdAt: new Date().toISOString(),
      };
      db.companies.push(company);
      save();
      logEvent('company.created', { companyId: company.id, name: company.name });
      return sendJSON(res, 201, { data: company });
    }
    if (method === 'PUT' && id && action === 'regenerate-key') {
      const c = db.companies.find((x) => x.id === id);
      if (!c) return notFound(res);
      c.apiKey = newApiKey();
      save();
      return sendJSON(res, 200, { data: c });
    }
    if (method === 'PUT' && id) {
      const c = db.companies.find((x) => x.id === id);
      if (!c) return notFound(res);
      const body = await readBody(req);
      for (const k of ['name', 'type', 'contactEmail', 'webhookUrl', 'active']) {
        if (k in body) c[k] = body[k];
      }
      save();
      return sendJSON(res, 200, { data: c });
    }
    if (method === 'DELETE' && id) {
      const idx = db.companies.findIndex((x) => x.id === id);
      if (idx === -1) return notFound(res);
      if (db.orders.some((o) => o.companyId === id && !['entregado', 'recolectado', 'no_entregado'].includes(o.status))) {
        return badRequest(res, 'La empresa tiene pedidos activos; complétalos o elimínalos primero');
      }
      const [removed] = db.companies.splice(idx, 1);
      save();
      return sendJSON(res, 200, { data: removed });
    }
  }

  if (resource === 'integration-logs' && method === 'GET') {
    let list = db.integrationLogs;
    if (query.get('companyId')) list = list.filter((l) => l.companyId === query.get('companyId'));
    return sendJSON(res, 200, { data: list.slice(0, 100) });
  }

  // ---- empresa / configuración ------------------------------------
  if (resource === 'company' && method === 'GET') {
    return sendJSON(res, 200, { data: db.company });
  }
  if (resource === 'reset' && method === 'POST') {
    reset();
    return sendJSON(res, 200, { data: { ok: true, message: 'Configuración real recargada; pedidos y rutas limpiados' } });
  }

  return notFound(res, `Ruta de API no encontrada: ${method} ${pathname}`);
}

// ================================================================
// API PÚBLICA (/api/public/v1) — sin autenticación, para el portal web
// de contratación de fletes y el seguimiento por código.
// ================================================================
async function handlePublicApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api','public','v1',resource,arg?]
  const resource = parts[3];
  const arg = parts[4];
  const method = req.method;

  // GET /api/public/v1/catalog — tipos de paquete y dimensiones
  if (resource === 'catalog' && method === 'GET') {
    return sendJSON(res, 200, { data: packages.catalog() });
  }

  // GET /api/public/v1/points — puntos Macotrans donde dejar/retirar
  if (resource === 'points' && method === 'GET') {
    const pts = db.deposits.map((d) => ({ id: d.id, name: d.name, city: d.city, lat: d.lat, lng: d.lng }));
    return sendJSON(res, 200, { data: pts });
  }

  // POST /api/public/v1/quote — cotiza un flete (por peso/vol o por ítems)
  if (resource === 'quote' && method === 'POST') {
    const body = await readBody(req);
    try {
      const data = Array.isArray(body.items) && body.items.length ? quoteItems(body) : quote(body);
      return sendJSON(res, 200, { data });
    } catch (err) {
      return badRequest(res, err.message);
    }
  }

  // POST /api/public/v1/freights — contrata un flete desde el portal
  if (resource === 'freights' && method === 'POST') {
    const body = await readBody(req);
    if (!body.contact || !body.contact.name || !body.contact.phone) {
      return badRequest(res, 'Se requiere contacto con nombre y teléfono');
    }
    if (!body.destination) return badRequest(res, 'Falta el destino del flete');
    const origin = body.origin || db.company.depot;
    const stops = Array.isArray(body.stops) ? body.stops : [];
    const byItems = Array.isArray(body.items) && body.items.length;
    let quoted;
    try {
      quoted = byItems
        ? quoteItems({ origin, destination: body.destination, stops, items: body.items, service: body.service })
        : quote({ origin, destination: body.destination, weightKg: body.weightKg, volumeM3: body.volumeM3, service: body.service });
    } catch (err) {
      return badRequest(res, err.message);
    }
    // convierte cada ítem cotizado en un bulto con su container ID
    const bultos = byItems
      ? quoted.items.flatMap((m, mi) =>
          Array.from({ length: m.qty }, (_, k) => ({
            containerId: `PORTAL-${Date.now().toString(36).toUpperCase()}-${mi + 1}-${k + 1}`,
            barcode: `PORTAL-${Date.now().toString(36).toUpperCase()}-${mi + 1}-${k + 1}`,
            description: m.label,
            weightKg: Math.round((m.weightKg / m.qty) * 100) / 100,
            volumeM3: Math.round((m.volumeM3 / m.qty) * 10000) / 10000,
            cargoType: ['pallet', 'volumetrico', 'tuberia'].includes(m.type) ? 'volumetrica' : 'paqueteria',
            zone: m.type === 'tuberia' ? 'parrilla' : m.type === 'pallet' ? 'delantera-central' : 'cajon',
            items: [],
          }))
        )
      : [];
    const portalCompany = db.companies.find((c) => c.type === 'portal');
    let order;
    try {
      order = createOrder(
        {
          type: body.type,
          customer: body.contact.name,
          contact: {
            name: body.contact.name,
            phone: body.contact.phone,
            email: body.contact.email || '',
          },
          address: body.destination.address || '',
          commune: body.destination.commune || '',
          lat: body.destination.lat,
          lng: body.destination.lng,
          weightKg: quoted.weightKg != null ? quoted.weightKg : body.weightKg,
          volumeM3: quoted.volumeM3 != null ? quoted.volumeM3 : body.volumeM3,
          date: body.date,
          notes: (body.notes || '') + (stops.length ? ` · ${stops.length} parada(s) adicional(es)` : ''),
          price: quoted.priceUsd,
          bultos,
          extraStops: stops,
        },
        { companyId: portalCompany ? portalCompany.id : null, source: 'portal' }
      );
    } catch (err) {
      return badRequest(res, err.message);
    }
    save();
    logEvent('freight.contracted', { orderId: order.id, trackingCode: order.trackingCode, priceUsd: quoted.priceUsd });
    dispatchWebhooks('order.created', { orders: [order.id], source: 'portal' });
    return sendJSON(res, 201, {
      data: {
        trackingCode: order.trackingCode,
        status: order.status,
        priceUsd: quoted.priceUsd,
        currency: 'USD',
        billableKg: quoted.billableKg,
        distanceKm: quoted.distanceKm,
        date: order.date,
      },
    });
  }

  // GET /api/public/v1/tracking/{code} — seguimiento público
  if (resource === 'tracking' && method === 'GET' && arg) {
    const order = db.orders.find((o) => o.trackingCode === arg.toUpperCase());
    if (!order) return notFound(res, 'Código de seguimiento no encontrado');
    return sendJSON(res, 200, { data: publicTracking(order) });
  }

  // POST /api/public/v1/feedback — calificación del cliente
  if (resource === 'feedback' && method === 'POST') {
    const body = await readBody(req);
    const order = db.orders.find(
      (o) => o.trackingCode === String(body.trackingCode || '').toUpperCase()
    );
    if (!order) return notFound(res, 'Código de seguimiento no encontrado');
    const rating = Number(body.rating);
    if (!(rating >= 1 && rating <= 5)) return badRequest(res, 'rating debe ser de 1 a 5');
    order.feedback = {
      rating,
      comment: String(body.comment || '').slice(0, 500),
      at: new Date().toISOString(),
    };
    save();
    logEvent('feedback.recibido', { orderId: order.id, rating });
    dispatchWebhooks('customer.feedback', { orderId: order.id, trackingCode: order.trackingCode, ...order.feedback }, { companyId: order.companyId });
    return sendJSON(res, 201, { data: { ok: true } });
  }

  return notFound(res, `Ruta de API pública no encontrada: ${method} ${pathname}`);
}

// ================================================================
// API DE INTEGRACIÓN (/api/integration/v1) — para ERPs, sistemas de
// facturación electrónica y e-commerce. Autenticación por API key
// (encabezado X-API-Key) y alcance limitado a los datos de la empresa.
// ================================================================
async function handleIntegrationApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api','integration','v1',resource,arg?]
  const resource = parts[3];
  const arg = parts[4];
  const method = req.method;

  const apiKey = req.headers['x-api-key'];
  const company = apiKey && db.companies.find((c) => c.apiKey === apiKey && c.active !== false);
  if (!company) {
    logIntegration(null, method, pathname, 401);
    return sendJSON(res, 401, { error: 'API key inválida o ausente (encabezado X-API-Key)' });
  }
  const log = (status) => logIntegration(company.id, method, pathname, status);

  // GET /me — datos de la cuenta de integración
  if (resource === 'me' && method === 'GET') {
    log(200);
    return sendJSON(res, 200, {
      data: {
        companyId: company.id,
        name: company.name,
        type: company.type,
        webhookUrl: company.webhookUrl || null,
      },
    });
  }

  // POST /quote — cotización (mismo motor que el portal)
  if (resource === 'quote' && method === 'POST') {
    const body = await readBody(req);
    try {
      const q = quote({ ...body, origin: body.origin || db.company.depot });
      log(200);
      return sendJSON(res, 200, { data: q });
    } catch (err) {
      log(400);
      return badRequest(res, err.message);
    }
  }

  // POST /orders — crea pedidos (uno o lote); GET /orders — lista propios
  if (resource === 'orders') {
    if (method === 'POST' && !arg) {
      const body = await readBody(req);
      const items = Array.isArray(body) ? body : [body];
      const created = [];
      try {
        for (const it of items) {
          created.push(createOrder(it, { companyId: company.id, source: 'api-' + company.type }));
        }
      } catch (err) {
        log(400);
        return badRequest(res, err.message);
      }
      save();
      log(201);
      logEvent('order.created', { count: created.length, companyId: company.id });
      dispatchWebhooks('order.created', { orders: created.map((o) => o.id), companyId: company.id });
      const view = created.map((o) => ({
        id: o.id,
        code: o.code,
        trackingCode: o.trackingCode,
        status: o.status,
        externalRef: o.externalRef,
      }));
      return sendJSON(res, 201, { data: Array.isArray(body) ? view : view[0] });
    }
    if (method === 'GET' && !arg) {
      const list = db.orders.filter((o) => o.companyId === company.id);
      log(200);
      return sendJSON(res, 200, { data: list, count: list.length });
    }
    if (method === 'GET' && arg) {
      const order = db.orders.find(
        (o) => o.companyId === company.id && (o.id === arg || o.code === arg || o.externalRef === arg)
      );
      if (!order) {
        log(404);
        return notFound(res);
      }
      log(200);
      return sendJSON(res, 200, { data: order });
    }
    if (method === 'DELETE' && arg) {
      const idx = db.orders.findIndex((o) => o.companyId === company.id && (o.id === arg || o.code === arg));
      if (idx === -1) {
        log(404);
        return notFound(res);
      }
      if (db.orders[idx].status !== 'pendiente') {
        log(409);
        return sendJSON(res, 409, { error: 'Solo se pueden anular pedidos en estado pendiente' });
      }
      const [removed] = db.orders.splice(idx, 1);
      save();
      log(200);
      return sendJSON(res, 200, { data: { id: removed.id, status: 'anulado' } });
    }
  }

  // GET /tracking/{code} — seguimiento de un pedido propio
  if (resource === 'tracking' && method === 'GET' && arg) {
    const order = db.orders.find(
      (o) => o.companyId === company.id && (o.trackingCode === arg.toUpperCase() || o.id === arg || o.externalRef === arg)
    );
    if (!order) {
      log(404);
      return notFound(res, 'Pedido no encontrado para esta empresa');
    }
    log(200);
    return sendJSON(res, 200, { data: publicTracking(order) });
  }

  // PUT /webhook — configura la URL de notificaciones de la empresa
  if (resource === 'webhook' && method === 'PUT') {
    const body = await readBody(req);
    company.webhookUrl = body.url || '';
    save();
    log(200);
    return sendJSON(res, 200, { data: { webhookUrl: company.webhookUrl } });
  }

  log(404);
  return notFound(res, `Ruta de API de integración no encontrada: ${method} ${pathname}`);
}

function serveStatic(res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  if (file === '/docs') file = '/docs.html';
  if (file === '/portal' || file === '/portal/') file = '/portal.html';
  if (file === '/conductor' || file === '/conductor/') file = '/conductor.html';
  if (file === '/cabina' || file === '/cabina/') file = '/cabina.html';
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) return notFound(res);
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) return notFound(res);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    return res.end();
  }

  try {
    if (pathname.startsWith('/api/public/')) {
      await handlePublicApi(req, res, pathname);
    } else if (pathname.startsWith('/api/integration/')) {
      await handleIntegrationApi(req, res, pathname);
    } else if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url.searchParams);
    } else if (pathname.startsWith('/print/route/')) {
      const route = db.routes.find((r) => r.id === pathname.split('/')[3]);
      if (!route || !route.documents) return notFound(res, 'Ruta sin documentos generados');
      const vehicle = db.vehicles.find((v) => v.id === route.vehicleId);
      const driver = vehicle && db.drivers.find((d) => d.id === vehicle.driverId);
      const html = renderRoutePrint({
        route,
        orders: db.orders,
        vehicle,
        driver,
        billing: db.company.billing,
        companyName: db.company.name,
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

if (require.main === module) {
  init();
  if (db.company.routing) routing.configure(db.company.routing);
  simulator.start();
  server.listen(PORT, () => {
    console.log(`Macotrans TMS escuchando en http://localhost:${PORT}`);
    console.log(`  · Portal TMS (operaciones):   http://localhost:${PORT}/`);
    console.log(`  · Portal público de fletes:   http://localhost:${PORT}/portal`);
    console.log(`  · Documentación de APIs:      http://localhost:${PORT}/docs`);
    console.log(`  · API interna:                http://localhost:${PORT}/api/v1/`);
    console.log(`  · API pública (portal):       http://localhost:${PORT}/api/public/v1/`);
    console.log(`  · API integración (X-API-Key): http://localhost:${PORT}/api/integration/v1/`);
  });
}

module.exports = { server, handleApi, computeKpis };
