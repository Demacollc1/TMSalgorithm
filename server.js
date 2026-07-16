'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { db, nextId, init, save, reset, logEvent } = require('./src/store');
const { optimize } = require('./src/optimizer');
const simulator = require('./src/simulator');
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

// ------------------------------------------------------------ KPIs
function computeKpis() {
  const orders = db.orders;
  const total = orders.length;
  const done = orders.filter((o) => ['entregado', 'recolectado'].includes(o.status)).length;
  const failed = orders.filter((o) => o.status === 'no_entregado').length;
  const inRoute = orders.filter((o) => o.status === 'en_ruta').length;
  const pending = orders.filter((o) => ['pendiente', 'asignado'].includes(o.status)).length;
  const activeRoutes = db.routes.filter((r) => r.status === 'en_curso').length;
  const plannedRoutes = db.routes.filter((r) => r.status === 'planificada').length;
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
      for (const it of items) {
        if (typeof it.lat !== 'number' || typeof it.lng !== 'number') {
          return badRequest(res, 'Cada pedido requiere lat y lng numéricos');
        }
        const order = {
          id: nextId('ORD'),
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
          pod: null,
          createdAt: new Date().toISOString(),
        };
        db.orders.push(order);
        created.push(order);
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
      dispatchWebhooks('order.status_changed', { orderId: order.id, status: order.status, pod: order.pod });
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
        driverId: body.driverId || null,
        status: 'disponible',
      };
      db.vehicles.push(vehicle);
      save();
      return sendJSON(res, 201, { data: vehicle });
    }
    if (method === 'PUT' && id) {
      const v = db.vehicles.find((x) => x.id === id);
      if (!v) return notFound(res);
      const body = await readBody(req);
      for (const k of ['plate', 'name', 'type', 'capacityKg', 'capacityM3', 'isNodriza', 'driverId', 'status']) {
        if (k in body) v[k] = body[k];
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
    const vehicles = db.vehicles.filter(
      (v) => v.status === 'disponible' && (!vehicleIds || vehicleIds.includes(v.id))
    );
    if (!orders.length) return badRequest(res, 'No hay pedidos pendientes para planificar');
    if (!vehicles.length) return badRequest(res, 'No hay vehículos disponibles');

    const result = optimize({
      depot: db.company.depot,
      orders,
      vehicles,
      options: body.options || {},
    });

    // materializa las rutas
    const created = result.routes.map((r) => {
      const route = {
        id: nextId('RUT'),
        date: body.date || new Date().toISOString().slice(0, 10),
        status: 'planificada',
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
    if (method === 'GET' && id) {
      const r = db.routes.find((x) => x.id === id);
      return r ? sendJSON(res, 200, { data: r }) : notFound(res);
    }
    if (method === 'POST' && id && action === 'start') {
      const route = db.routes.find((x) => x.id === id);
      if (!route) return notFound(res);
      if (route.status !== 'planificada') return badRequest(res, 'La ruta no está en estado planificada');
      route.status = 'en_curso';
      route.startedAt = new Date().toISOString();
      const vehicle = db.vehicles.find((v) => v.id === route.vehicleId);
      if (vehicle) vehicle.status = 'en_ruta';
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

  // ---- empresa / configuración ------------------------------------
  if (resource === 'company' && method === 'GET') {
    return sendJSON(res, 200, { data: db.company });
  }
  if (resource === 'reset' && method === 'POST') {
    reset();
    return sendJSON(res, 200, { data: { ok: true, message: 'Datos reiniciados con seed de demostración' } });
  }

  return notFound(res, `Ruta de API no encontrada: ${method} ${pathname}`);
}

function serveStatic(res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  if (file === '/docs') file = '/docs.html';
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
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url.searchParams);
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

if (require.main === module) {
  init();
  simulator.start();
  server.listen(PORT, () => {
    console.log(`RutaFleet TMS escuchando en http://localhost:${PORT}`);
    console.log(`  · Aplicación web:  http://localhost:${PORT}/`);
    console.log(`  · Documentación:   http://localhost:${PORT}/docs`);
    console.log(`  · API REST:        http://localhost:${PORT}/api/v1/`);
  });
}

module.exports = { server, handleApi, computeKpis };
