'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Almacén de datos en memoria con persistencia opcional a JSON.
 * Suficiente para la réplica; en producción se reemplazaría por una BD.
 */

const DATA_FILE = path.join(__dirname, '..', 'data', 'db.json');

let seq = 1000;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

const db = {
  company: {
    name: 'Macotrans TMS',
    depot: {
      name: 'Centro de Distribución Santiago',
      address: 'Av. Presidente Eduardo Frei Montalva 1200, Renca, Santiago',
      lat: -33.404,
      lng: -70.6883,
    },
  },
  companies: [], // empresas cliente (tenants): ERPs, e-commerce, portal público
  orders: [],
  vehicles: [],
  drivers: [],
  routes: [],
  webhooks: [],
  integrationLogs: [], // auditoría de llamadas al API de integración
  events: [], // registro de eventos (feed de actividad y webhooks)
};

function newApiKey() {
  return 'mk_' + crypto.randomBytes(18).toString('hex');
}

function newTrackingCode() {
  // código corto y legible para seguimiento público (sin caracteres ambiguos)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return 'MAC-' + code;
}

// ---------------------------------------------------------------- seed
function seedData() {
  db.companies = [
    {
      id: 'CMP-1',
      name: 'Comercial Andina SpA',
      type: 'erp',
      contactEmail: 'operaciones@comercialandina.cl',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'CMP-2',
      name: 'TiendaVeloz.cl',
      type: 'ecommerce',
      contactEmail: 'logistica@tiendaveloz.cl',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'CMP-3',
      name: 'Clientes Portal Web',
      type: 'portal',
      contactEmail: 'contacto@macotrans.cl',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
  ];

  db.drivers = [
    { id: 'DRV-1', name: 'Carolina Fuentes', phone: '+56 9 8123 4501', license: 'A2', status: 'disponible' },
    { id: 'DRV-2', name: 'Jorge Miranda', phone: '+56 9 8123 4502', license: 'A4', status: 'disponible' },
    { id: 'DRV-3', name: 'Valentina Rojas', phone: '+56 9 8123 4503', license: 'B', status: 'disponible' },
    { id: 'DRV-4', name: 'Matías Herrera', phone: '+56 9 8123 4504', license: 'A5', status: 'disponible' },
  ];

  db.vehicles = [
    { id: 'VEH-1', plate: 'LKRD-23', name: 'Camión Nodriza 01', type: 'camion', capacityKg: 8000, capacityM3: 42, isNodriza: true, driverId: 'DRV-4', status: 'disponible' },
    { id: 'VEH-2', plate: 'HTXS-91', name: 'Van Reparto 01', type: 'van', capacityKg: 1200, capacityM3: 9, isNodriza: false, driverId: 'DRV-1', status: 'disponible' },
    { id: 'VEH-3', plate: 'JPWK-55', name: 'Van Reparto 02', type: 'van', capacityKg: 1200, capacityM3: 9, isNodriza: false, driverId: 'DRV-2', status: 'disponible' },
    { id: 'VEH-4', plate: 'KZBF-08', name: 'Camión 3/4 01', type: 'camion', capacityKg: 3000, capacityM3: 18, isNodriza: false, driverId: 'DRV-3', status: 'disponible' },
  ];

  const today = new Date().toISOString().slice(0, 10);
  const seedOrders = [
    // [código, tipo, dirección, comuna, lat, lng, kg, m3, ventana, cliente]
    ['PED-0001', 'entrega', 'Av. Apoquindo 4501', 'Las Condes', -33.4172, -70.6015, 180, 1.2, ['09:00', '13:00'], 'Comercial Andina SpA'],
    ['PED-0002', 'entrega', 'Av. Providencia 2124', 'Providencia', -33.4212, -70.6106, 95, 0.8, ['09:00', '18:00'], 'Farmacias Vital'],
    ['PED-0003', 'entrega', 'Gran Avenida 5822', 'San Miguel', -33.4972, -70.6535, 240, 2.1, ['10:00', '14:00'], 'Distribuidora El Sol'],
    ['PED-0004', 'recoleccion', 'Av. Vicuña Mackenna 4917', 'Macul', -33.4907, -70.6011, 120, 1.0, ['11:00', '17:00'], 'Textil Ñuñoa Ltda.'],
    ['PED-0005', 'entrega', 'Av. Pajaritos 3030', 'Maipú', -33.4826, -70.7541, 310, 2.6, ['09:00', '12:00'], 'Supermercados Cordillera'],
    ['PED-0006', 'entrega', 'Av. Independencia 2870', 'Independencia', -33.4093, -70.6640, 75, 0.5, ['08:30', '18:00'], 'Botillería Central'],
    ['PED-0007', 'entrega', 'Av. Recoleta 2050', 'Recoleta', -33.4059, -70.6408, 130, 1.1, ['09:00', '18:00'], 'Ferretería El Clavo'],
    ['PED-0008', 'recoleccion', 'Camino a Melipilla 9600', 'Cerrillos', -33.5169, -70.7204, 400, 3.2, ['13:00', '17:00'], 'Bodegas del Pacífico'],
    ['PED-0009', 'entrega', 'Av. La Florida 9343', 'La Florida', -33.5423, -70.5638, 210, 1.8, ['10:00', '16:00'], 'Clínica Dental Sur'],
    ['PED-0010', 'entrega', 'Av. Irarrázaval 3050', 'Ñuñoa', -33.4548, -70.6072, 60, 0.4, ['09:00', '18:00'], 'Café Ñuñoa'],
    ['PED-0011', 'entrega', 'Av. San Pablo 8444', 'Pudahuel', -33.4419, -70.7583, 520, 4.0, ['08:30', '12:30'], 'Importadora Oeste'],
    ['PED-0012', 'entrega', 'Av. El Bosque Norte 0177', 'Las Condes', -33.4136, -70.5990, 45, 0.3, ['10:00', '18:00'], 'Oficinas Torre Norte'],
    ['PED-0013', 'recoleccion', 'Av. Departamental 4800', 'San Joaquín', -33.5089, -70.6284, 150, 1.4, ['14:00', '18:00'], 'Reciclajes Metropolitana'],
    ['PED-0014', 'entrega', 'Av. Vitacura 6255', 'Vitacura', -33.3901, -70.5754, 88, 0.7, ['09:00', '13:00'], 'Deco Hogar Vitacura'],
    ['PED-0015', 'entrega', 'Av. Quilín 3750', 'Peñalolén', -33.4903, -70.5741, 175, 1.5, ['09:00', '18:00'], 'Vivero Los Aromos'],
    ['PED-0016', 'entrega', 'Av. Domingo Santa María 3800', 'Conchalí', -33.3949, -70.6791, 230, 2.0, ['08:30', '14:00'], 'Panadería San Camilo'],
    ['PED-0017', 'entrega', 'Av. Manuel Antonio Matta 950', 'Santiago Centro', -33.4599, -70.6432, 110, 0.9, ['09:00', '18:00'], 'Librería Matta'],
    ['PED-0018', 'recoleccion', 'Av. Lo Espejo 0341', 'Lo Espejo', -33.5230, -70.6899, 260, 2.2, ['12:00', '17:00'], 'Muebles La Fábrica'],
  ];

  // reparte los pedidos seed entre las empresas cliente para mostrar
  // la planificación consolidada multi-empresa
  db.orders = seedOrders.map((o, i) => ({
    id: nextId('ORD'),
    companyId: i < 6 ? 'CMP-1' : i < 12 ? 'CMP-2' : 'CMP-3',
    source: i < 6 ? 'api-erp' : i < 12 ? 'api-ecommerce' : 'portal',
    trackingCode: newTrackingCode(),
    price: null,
    contact: null,
    code: o[0],
    type: o[1],
    address: `${o[2]}, ${o[3]}`,
    commune: o[3],
    lat: o[4],
    lng: o[5],
    weightKg: o[6],
    volumeM3: o[7],
    timeWindow: { start: o[8][0], end: o[8][1] },
    customer: o[9],
    date: today,
    status: 'pendiente',
    priority: 'normal',
    notes: '',
    pod: null,
    createdAt: new Date().toISOString(),
  }));
}

// ------------------------------------------------------- persistencia
function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ seq, db }, null, 2));
  } catch (err) {
    console.error('No se pudo persistir la base de datos:', err.message);
  }
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      seq = raw.seq || seq;
      Object.assign(db, raw.db);
      return true;
    }
  } catch (err) {
    console.error('No se pudo cargar la base de datos, se usa seed:', err.message);
  }
  return false;
}

function init() {
  if (!load()) {
    seedData();
    save();
  }
}

function reset() {
  db.orders = [];
  db.routes = [];
  db.events = [];
  db.integrationLogs = [];
  seq = 1000;
  seedData();
  db.vehicles.forEach((v) => (v.status = 'disponible'));
  save();
}

function logIntegration(companyId, method, pathName, status) {
  db.integrationLogs.unshift({
    id: nextId('LOG'),
    companyId,
    method,
    path: pathName,
    status,
    at: new Date().toISOString(),
  });
  if (db.integrationLogs.length > 500) db.integrationLogs.length = 500;
}

function logEvent(type, payload) {
  const event = {
    id: nextId('EVT'),
    type,
    payload,
    at: new Date().toISOString(),
  };
  db.events.unshift(event);
  if (db.events.length > 300) db.events.length = 300;
  return event;
}

module.exports = { db, nextId, init, save, reset, logEvent, logIntegration, newApiKey, newTrackingCode };
