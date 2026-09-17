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
    ai: {
      enabled: true,
      webserviceUrl: '', // endpoint LLM/agente: recibe casos, consultas e informes
      deviationKm: 0.5, // desvío de ruta que dispara la consulta al chofer
      geoDiscrepancyKm: 0.3, // distancia entre entrega real y dirección registrada
      delayHoldTicks: 45, // espera en cliente que dispara aviso de retraso (~90 s sim)
    },
  },
  billingSeq: 140100, // secuencial de comprobantes (guías y facturas)
  companies: [], // empresas cliente (tenants): ERPs, e-commerce, portal público
  orders: [],
  vehicles: [],
  drivers: [],
  deposits: [], // bodegas / depósitos
  trailers: [], // remolques plegables (aumentan volumen sin sobrecargar peso)
  yards: [], // puntos de acopio para estacionar remolques por ciudad
  fleets: [], // agrupaciones de vehículos
  addresses: [], // maestro de direcciones / puntos de entrega
  schemas: [], // esquemas de ruteo (parámetros del optimizador por depósito)
  employers: [], // empleadores / socios de negocio
  routes: [],
  webhooks: [],
  integrationLogs: [], // auditoría de llamadas al API de integración
  events: [], // registro de eventos (feed de actividad y webhooks)
  cases: [], // casos operativos creados por la IA (desvíos, geolocalización, emergencias)
  notifications: [], // notificaciones enviadas a clientes (siguiente entrega, retraso, feedback)
  expenses: [], // gastos de ruta registrados por los choferes
  delegations: [], // solicitudes de delegación de paquetes entre rutas
  telemetry: {}, // última posición por vehículo y por fuente (celular / gps_vehiculo / dashcam)
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
// Datos reales de la organización, exportados desde driv.in
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'demaco-drivin.json');

function seedData() {
  db.companies = [
    {
      id: 'CMP-1',
      name: 'DEMACO CIA. LTDA',
      type: 'erp',
      contactEmail: 'sistemas@demaco.ec',
      taxId: '0990621691001',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'CMP-2',
      name: 'Clientes Portal Web',
      type: 'portal',
      contactEmail: 'contacto@macotrans.ec',
      apiKey: newApiKey(),
      webhookUrl: '',
      active: true,
      createdAt: new Date().toISOString(),
    },
  ];

  db.orders = [];
  db.vehicles = [];
  db.drivers = [];
  db.deposits = [];
  db.fleets = [];
  db.addresses = [];
  db.schemas = [];
  db.employers = [];

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const { buildFromConfig } = require('./realdata');
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const data = buildFromConfig(raw);
      db.vehicles = data.vehicles;
      db.drivers = data.drivers;
      db.deposits = data.deposits;
      db.fleets = data.fleets;
      db.addresses = data.addresses;
      db.schemas = data.schemas;
      db.employers = data.employers;
      if (data.mainDepot) {
        db.company.depot = {
          name: data.mainDepot.name,
          address: data.mainDepot.address,
          lat: data.mainDepot.lat,
          lng: data.mainDepot.lng,
          depositId: data.mainDepot.id,
        };
        db.company.billing.direccion = data.mainDepot.address;
      }
      // puntos de acopio: cada bodega sirve para estacionar remolques
      db.yards = db.deposits.map((d) => ({
        id: 'YRD-' + d.externalId,
        name: `Acopio ${d.name}`,
        city: d.city,
        lat: d.lat,
        lng: d.lng,
        depositId: d.id,
      }));
      // remolques plegables de la flota (editables en Flota → Remolques)
      db.trailers = [
        { id: 'TRL-1', code: 'RMQ-01', name: 'Remolque plegable 01', capacityKg: 1500, capacityM3: 28, foldable: true, status: 'disponible', locationName: db.company.depot.name, lat: db.company.depot.lat, lng: db.company.depot.lng, attachedToVehicleId: null },
        { id: 'TRL-2', code: 'RMQ-02', name: 'Remolque plegable 02', capacityKg: 1500, capacityM3: 28, foldable: true, status: 'disponible', locationName: db.company.depot.name, lat: db.company.depot.lat, lng: db.company.depot.lng, attachedToVehicleId: null },
        { id: 'TRL-3', code: 'RMQ-03', name: 'Remolque tubero 03', capacityKg: 2000, capacityM3: 35, foldable: false, status: 'disponible', locationName: db.company.depot.name, lat: db.company.depot.lat, lng: db.company.depot.lng, attachedToVehicleId: null },
      ];
      console.log(
        `Datos reales cargados desde config: ${db.vehicles.length} vehículos, ` +
          `${db.drivers.length} tripulantes, ${db.deposits.length} bodegas, ` +
          `${db.fleets.length} flotas, ${db.addresses.length} direcciones, ` +
          `${db.schemas.length} esquemas`
      );
    } else {
      console.warn('No existe config/demaco-drivin.json: arranque con base vacía');
    }
  } catch (err) {
    console.error('Error cargando la configuración real:', err.message);
  }
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
  const loaded = load();
  // Auto-reparación: si no había base, o si la base guardada quedó sin la
  // configuración real (vehículos/bodegas vacíos, típico de una base vieja),
  // recarga los datos reales desde config/ sin que el usuario tenga que
  // borrar data/db.json a mano.
  const sinConfig = !db.vehicles || db.vehicles.length === 0 || !db.deposits || db.deposits.length === 0;
  if (!loaded || sinConfig) {
    if (loaded && sinConfig) {
      console.log('Base local sin configuración real detectada: recargando datos desde config…');
    }
    // conserva pedidos/rutas si por alguna razón existían
    const prevOrders = Array.isArray(db.orders) ? db.orders : [];
    const prevRoutes = Array.isArray(db.routes) ? db.routes : [];
    seedData();
    if (loaded && prevOrders.length) db.orders = prevOrders;
    if (loaded && prevRoutes.length) db.routes = prevRoutes;
    save();
  }
}

function reset() {
  db.orders = [];
  db.routes = [];
  db.events = [];
  db.integrationLogs = [];
  db.cases = [];
  db.notifications = [];
  db.expenses = [];
  db.delegations = [];
  db.telemetry = {};
  seq = 1000;
  seedData();
  db.vehicles.forEach((v) => {
    if (v.apto !== false) v.status = 'disponible';
  });
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
