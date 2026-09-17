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
      name: 'Centro de Distribución Guayaquil',
      address: 'Urb. Santa Leonor Mz. 6 Solar 13, Guayaquil, Ecuador',
      lat: -2.1329,
      lng: -79.8855,
    },
    billing: {
      razonSocial: 'MACOTRANS S.A.',
      ruc: '0999999999001',
      direccion: 'Urb. Santa Leonor Mz. 6 Solar 13, Guayaquil, Ecuador',
      establecimiento: '005',
      puntoEmision: '002',
      ivaPct: 15,
      webserviceUrl: '', // webservice de facturación electrónica (POST)
    },
  },
  billingSeq: 140100, // secuencial de comprobantes (guías y facturas)
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
      name: 'DEMACO CIA. LTDA.',
      type: 'erp',
      contactEmail: 'sistemas@demaco.ec',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'CMP-2',
      name: 'TiendaVeloz.ec',
      type: 'ecommerce',
      contactEmail: 'logistica@tiendaveloz.ec',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'CMP-3',
      name: 'Clientes Portal Web',
      type: 'portal',
      contactEmail: 'contacto@macotrans.ec',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
  ];

  db.drivers = [
    { id: 'DRV-1', name: 'Carlos Rivera Montaño', phone: '+593 99 812 3451', license: 'E', status: 'disponible' },
    { id: 'DRV-2', name: 'Jorge Miranda Vera', phone: '+593 99 812 3452', license: 'C', status: 'disponible' },
    { id: 'DRV-3', name: 'Valentina Rojas Peña', phone: '+593 99 812 3453', license: 'C', status: 'disponible' },
    { id: 'DRV-4', name: 'Matías Herrera Luna', phone: '+593 99 812 3454', license: 'E', status: 'disponible' },
  ];

  // apto: habilitado para salir a ruta (matrícula, revisión, mantenimiento)
  // hasParrilla: puede llevar tubos/perfiles en parrilla o cajón superior
  db.vehicles = [
    { id: 'VEH-1', plate: 'GSM-2347', name: 'Camión Nodriza 01', type: 'camion', capacityKg: 8000, capacityM3: 42, isNodriza: true, hasParrilla: true, apto: true, aptoNotes: '', driverId: 'DRV-4', status: 'disponible' },
    { id: 'VEH-2', plate: 'GBA-1123', name: 'Furgón Reparto 01', type: 'van', capacityKg: 1200, capacityM3: 9, isNodriza: false, hasParrilla: false, apto: true, aptoNotes: '', driverId: 'DRV-1', status: 'disponible' },
    { id: 'VEH-3', plate: 'GCT-8890', name: 'Furgón Reparto 02', type: 'van', capacityKg: 1200, capacityM3: 9, isNodriza: false, hasParrilla: true, apto: true, aptoNotes: '', driverId: 'DRV-2', status: 'disponible' },
    { id: 'VEH-4', plate: 'GRT-4432', name: 'Camión 3.5T 01', type: 'camion', capacityKg: 3500, capacityM3: 18, isNodriza: false, hasParrilla: true, apto: true, aptoNotes: '', driverId: 'DRV-3', status: 'disponible' },
    { id: 'VEH-5', plate: 'GKL-7215', name: 'Camión 3.5T 02', type: 'camion', capacityKg: 3500, capacityM3: 18, isNodriza: false, hasParrilla: true, apto: false, aptoNotes: 'En mantenimiento: cambio de embrague', driverId: null, status: 'no_apto' },
  ];

  const today = new Date().toISOString().slice(0, 10);
  // Sectores de Guayaquil y alrededores con coordenadas aproximadas
  const seedOrders = [
    // [código, tipo, dirección, sector, lat, lng, ventana, cliente, bultos]
    ['PED-0001', 'entrega', 'Cdla. Simón Bolívar Mz. 5', 'Av. de las Américas', -2.1522, -79.8867, ['09:00', '11:00'], 'Ferretería Las Américas',
      [['saco', 'BONDEX STANDARD CERAMICA 25 KG', 4, 100], ['saco', 'EMPASTE INTERIOR BLANCO 20kg', 3, 60], ['caja', 'GRIFERÍA Y REPUESTOS VARIOS', 2, 8]]],
    ['PED-0002', 'entrega', 'Av. Víctor Emilio Estrada 620', 'Urdesa', -2.1681, -79.9053, ['09:00', '18:00'], 'Comercial Urdesa Centro',
      [['tubo', 'TUBO PVC PRESION 32mmx6m (x20)', 1, 28], ['caja', 'ACCESORIOS PVC PRESION', 3, 12]]],
    ['PED-0003', 'entrega', 'Av. Francisco de Orellana', 'Alborada', -2.1349, -79.9042, ['10:00', '14:00'], 'Distribuidora El Sol',
      [['saco', 'CEMENTO ASFALTICO 20KG', 2, 40], ['caja', 'SELLADORES Y SILICONAS', 2, 10]]],
    ['PED-0004', 'recoleccion', 'Av. Juan Tanca Marengo Km 2', 'Kennedy Norte', -2.1512, -79.8935, ['11:00', '17:00'], 'Textiles del Litoral',
      [['caja', 'DEVOLUCIÓN MERCADERÍA', 3, 45]]],
    ['PED-0005', 'entrega', 'Av. del Bombero Km 6.5', 'Los Ceibos', -2.1633, -79.9401, ['09:00', '12:00'], 'Constructora Ceibos Hills',
      [['saco', 'MORTERO MULTIUSO 25 KG (x8)', 1, 200], ['tubo', 'TUBO PVC DESAGUE 110mmx3m (x15)', 1, 42], ['caja', 'CAJAS DE HERRAMIENTAS', 4, 30]]],
    ['PED-0006', 'entrega', 'Av. Quito y Portete', 'Centro', -2.2035, -79.8901, ['08:30', '18:00'], 'Ferretería El Constructor',
      [['caja', 'BROCAS Y DISCOS DEWALT', 2, 9]]],
    ['PED-0007', 'entrega', 'Cdla. La Garzota Mz. 34', 'La Garzota', -2.1417, -79.8942, ['09:00', '18:00'], 'Ferretería La Garzota',
      [['caja', 'CERRADURAS Y CANDADOS', 2, 14], ['caja', 'LIJAS Y ABRASIVOS', 1, 6]]],
    ['PED-0008', 'recoleccion', 'Parque Industrial El Sauce', 'Vía Daule Km 10', -2.1130, -79.9260, ['13:00', '17:00'], 'Bodegas del Pacífico',
      [['saco', 'RETIRO SACOS DEFECTUOSOS', 1, 150], ['caja', 'RETIRO PAQUETERÍA', 4, 60]]],
    ['PED-0009', 'entrega', 'Av. Domingo Comín 135', 'Sur - Centenario', -2.2290, -79.8952, ['10:00', '16:00'], 'Clínica Dental Sur',
      [['caja', 'INSUMOS Y GRIFERÍA BAÑOS', 2, 18]]],
    ['PED-0010', 'entrega', 'Cdla. Sauces 6 Mz. 265', 'Sauces', -2.1207, -79.8969, ['09:00', '18:00'], 'Minimarket Sauces',
      [['caja', 'PAQUETERÍA VARIA', 1, 7]]],
    ['PED-0011', 'entrega', 'Km 4.5 Vía Durán-Tambo', 'Durán', -2.1794, -79.8206, ['08:30', '12:30'], 'Importadora Oriente',
      [['saco', 'CEMENTO CONTACTO GALONES (x12)', 1, 90], ['tubo', 'TUBO PVC PRESION 63mmx6m (x25)', 1, 95], ['caja', 'TEFLONES Y ABASTOS', 5, 24]]],
    ['PED-0012', 'entrega', 'Av. Samborondón Km 1.5', 'Samborondón', -2.1327, -79.8646, ['10:00', '18:00'], 'Edificio Torre Río',
      [['caja', 'INTERRUPTORES LIVING NOW', 2, 6]]],
    ['PED-0013', 'recoleccion', 'Av. Carlos Julio Arosemena Km 2', 'Miraflores', -2.1789, -79.9182, ['14:00', '18:00'], 'Reciclajes del Guayas',
      [['caja', 'RETIRO EQUIPOS', 2, 38]]],
    ['PED-0014', 'entrega', 'Cdla. Kennedy Vieja Mz. 8', 'Kennedy', -2.1687, -79.8973, ['09:00', '13:00'], 'Deco Hogar Kennedy',
      [['caja', 'REJILLAS Y SIFONES', 3, 11]]],
    ['PED-0015', 'entrega', 'Vía a la Costa Km 12', 'Puerto Azul', -2.1901, -79.9885, ['09:00', '18:00'], 'Urbanización Puerto Azul',
      [['saco', 'SIKA IMPERMEABILIZANTE 20kg (x4)', 1, 80], ['caja', 'ESPUMAS Y SELLADORES', 2, 12]]],
    ['PED-0016', 'entrega', 'Av. Benjamín Rosales', 'Terminal Terrestre', -2.1408, -79.8813, ['08:30', '14:00'], 'Comercial La Terminal',
      [['caja', 'PINTURAS SPRAY Y BROCHAS', 3, 20]]],
    ['PED-0017', 'entrega', 'Malecón 2000 local 12', 'Malecón', -2.1946, -79.8794, ['09:00', '18:00'], 'Librería del Malecón',
      [['caja', 'PAPELERÍA Y OFICINA', 2, 9]]],
    ['PED-0018', 'recoleccion', 'Cdla. Guangala Mz. 40', 'Sur - Guasmo', -2.2513, -79.8890, ['12:00', '17:00'], 'Muebles La Fábrica',
      [['caja', 'DEVOLUCIÓN MUEBLES ARMADOS', 3, 85]]],
  ];

  // reparte los pedidos seed entre las empresas cliente para mostrar
  // la planificación consolidada multi-empresa
  db.orders = seedOrders.map((o, i) => {
    const bultos = o[8].map(([kind, desc, count, totalKg], bi) => {
      const perBulto = totalKg / count;
      return Array.from({ length: count }, (_, k) => ({
        containerId: `${o[0]}-B${bi + 1}${count > 1 ? '-' + (k + 1) : ''}`,
        barcode: `${o[0]}-B${bi + 1}${count > 1 ? '-' + (k + 1) : ''}`,
        description: desc,
        itemCount: 1,
        unitCount: 1,
        weightKg: Math.round(perBulto * 100) / 100,
        volumeM3: Math.round((kind === 'tubo' ? 0.2 : perBulto * 0.004) * 10000) / 10000,
        cargoType: kind === 'caja' ? 'paqueteria' : 'volumetrica',
        zone: kind === 'tubo' ? 'parrilla' : kind === 'saco' ? 'delantera-central' : 'cajon',
        items: [],
      }));
    }).flat();
    return {
      id: nextId('ORD'),
      companyId: i < 6 ? 'CMP-1' : i < 12 ? 'CMP-2' : 'CMP-3',
      source: i < 6 ? 'api-erp' : i < 12 ? 'api-ecommerce' : 'portal',
      trackingCode: newTrackingCode(),
      price: null,
      contact: null,
      code: o[0],
      type: o[1],
      address: `${o[2]}, ${o[3]}, Guayaquil`,
      commune: o[3],
      lat: o[4],
      lng: o[5],
      weightKg: Math.round(bultos.reduce((s, b) => s + b.weightKg, 0) * 10) / 10,
      volumeM3: Math.round(bultos.reduce((s, b) => s + b.volumeM3, 0) * 100) / 100,
      timeWindow: { start: o[6][0], end: o[6][1] },
      customer: o[7],
      bultos,
      date: today,
      status: 'pendiente',
      priority: 'normal',
      notes: '',
      pod: null,
      createdAt: new Date().toISOString(),
    };
  });
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
