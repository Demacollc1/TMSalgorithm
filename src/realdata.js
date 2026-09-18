'use strict';

const crypto = require('crypto');

/**
 * Cargador de datos reales desde el export de configuración de driv.in
 * (config/demaco-drivin.json). Mapea las entidades de la organización
 * a las estructuras del TMS:
 *
 *   vehiculos              → db.vehicles   (capacity_2=kg, capacity_3=cm³, tags)
 *   tripulacion_conductores→ db.drivers    (driver | peoneta)
 *   bodegas_deposits       → db.deposits   (+ depósito principal)
 *   flotas                 → db.fleets
 *   direcciones            → db.addresses  (maestro de puntos de entrega)
 *   esquemas               → db.schemas    (parámetros de ruteo por depósito)
 *   empleadores_socios     → db.employers
 */

function hhmm(iso) {
  if (!iso) return null;
  const m = String(iso).match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function mapVehicles(raw, drivers) {
  return (raw || []).map((v) => {
    const tags = (v.tags || []).map((t) => t.tag);
    const driver =
      drivers.find((d) => d.email && v.email && d.email === v.email) ||
      drivers.find((d) => d.userId && v.driver_id && d.userId === v.driver_id);
    return {
      id: 'VEH-' + v.id,
      externalId: v.id,
      plate: v.code,
      name: cleanName(v.description) || v.code,
      type: tags.includes('FURGON') ? 'furgon' : 'camion',
      capacityUn: v.capacity_1 || 0,
      capacityKg: v.capacity_2 || 0,
      capacityM3: v.capacity_3 ? Math.round((v.capacity_3 / 1e6) * 100) / 100 : 0,
      tags,
      isViaje: tags.includes('VIAJE'), // característica: apto para viajes fuera de la ciudad
      isNodriza: false,
      hasParrilla: true, // puede llevar tubos en la parte superior (editable)
      hasTowHitch: !tags.includes('FURGON'), // bola para remolque (editable)
      hasLiftgate: false, // ascensor / montacargas en la cola (editable)
      // token para que los GPS físicos (vehículo / dashcam) transmitan telemetría
      deviceToken: 'vt_' + crypto.randomBytes(12).toString('hex'),
      apto: v.is_active !== false,
      aptoNotes: v.is_active === false ? 'Inactivo en driv.in' : '',
      driverId: driver ? driver.id : null,
      driverName: cleanName(v.driver) || null,
      shift: { start: hhmm(v.shift_start) || '07:00', end: hhmm(v.shift_end) || '19:00' },
      days: v.days || null,
      fleets: (v.fleets || []).map((f) => f.name),
      status: v.is_active === false ? 'no_apto' : 'disponible',
    };
  });
}

function mapDrivers(raw) {
  return (raw || []).map((t) => ({
    id: 'DRV-' + t.id,
    userId: t.user_id,
    name: cleanName(t.full_name || `${t.first_name || ''} ${t.last_name || ''}`),
    email: t.email || '',
    phone: t.phone || '',
    dni: t.dni || '',
    license: t.license_number || '',
    role: t.role_type === 'driver' ? 'conductor' : 'peoneta',
    employer: t.employer_name || '',
    appVersion: t.app_version || null,
    lastActiveAt: t.last_active_at || null,
    status: t.is_active === false ? 'inactivo' : 'disponible',
  }));
}

function mapDeposits(raw) {
  return (raw || []).map((d) => ({
    id: 'DEP-' + d.id,
    externalId: d.id,
    code: d.code || null,
    name: cleanName(d.name),
    address: [d.address_1, d.area_level_3, d.area_level_1].filter(Boolean).join(', '),
    province: d.area_level_1 || '',
    city: d.area_level_3 || d.area_level_2 || '',
    lat: d.lat,
    lng: d.lng,
  }));
}

function mapFleets(raw, vehicles) {
  return (raw || []).map((f) => ({
    id: 'FLT-' + f.id,
    externalId: f.id,
    name: cleanName(f.name),
    vehicleIds: (f.vehicles || [])
      .map((vid) => {
        const v = vehicles.find((x) => x.externalId === vid);
        return v ? v.id : null;
      })
      .filter(Boolean),
    countVehicles: f.count_vehicles || (f.vehicles || []).length,
    capacityKg: f.capacity_2 || 0,
    capacityM3: f.capacity_3 ? Math.round((f.capacity_3 / 1e6) * 100) / 100 : 0,
  }));
}

function mapAddresses(raw) {
  return (raw || []).map((a) => ({
    id: 'ADR-' + a.id,
    externalId: a.id,
    code: a.code || null,
    name: cleanName(a.name),
    client: cleanName(a.client || a.name),
    address: cleanName(a.address_1),
    reference: cleanName(a.address_2 || ''),
    city: a.area_level_3 || a.area_level_2 || '',
    province: a.area_level_1 || '',
    type: a.address_type || '',
    isGeoref: !!a.is_georef,
    lat: typeof a.lat === 'number' ? a.lat : parseFloat(a.lat) || null,
    lng: typeof a.lng === 'number' ? a.lng : parseFloat(a.lng) || null,
    dispatchDate: a.dispatch_date || null,
    contact: a.contact || null,
  }));
}

function mapSchemas(raw) {
  return (raw || []).map((s) => ({
    id: 'SCH-' + s.id,
    externalId: s.id,
    name: cleanName(s.name),
    code: s.code || null,
    serviceTimeMin: s.service_time ?? 15,
    returnToDepot: s.return_trip !== false,
    startsAtDepot: !s.no_deposit,
    maxSpeedKmh: s.max_speed || 60,
    clearanceMin: s.clearence ?? 15,
    twClearanceMin: s.tw_clearence ?? 15,
    multipleTrips: !!s.multiple_trips,
    reloadTimeMin: s.reload_time ?? 0,
    loadConfirmation: !!s.load_confirmation,
    noTimeWindows: !!s.no_time_windows,
    fleetExternalId: s.fleet_id || null,
    deposit: s.deposit
      ? {
          externalId: s.deposit.id,
          name: cleanName(s.deposit.name),
          address: [s.deposit.address_1, s.deposit.area_level_3].filter(Boolean).join(', '),
          lat: s.deposit.lat,
          lng: s.deposit.lng,
        }
      : null,
  }));
}

function mapEmployers(raw) {
  return (raw || [])
    .filter((e) => cleanName(e.name))
    .map((e) => ({ id: 'EMP-' + e.id, externalId: e.id, name: cleanName(e.name), code: e.code || '' }));
}

/**
 * Construye todas las entidades desde el JSON exportado de driv.in.
 * @returns {{vehicles, drivers, deposits, fleets, addresses, schemas, employers, meta, mainDepot}}
 */
function buildFromConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Configuración inválida');
  const drivers = mapDrivers(raw.tripulacion_conductores);
  const vehicles = mapVehicles(raw.vehiculos, drivers);
  const deposits = mapDeposits(raw.bodegas_deposits);
  const fleets = mapFleets(raw.flotas, vehicles);
  const addresses = mapAddresses(raw.direcciones);
  const schemas = mapSchemas(raw.esquemas);
  const employers = mapEmployers(raw.empleadores_socios);
  const mainDepot =
    deposits.find((d) => /matriz/i.test(d.name)) || deposits[0] || null;
  return {
    vehicles,
    drivers,
    deposits,
    fleets,
    addresses,
    schemas,
    employers,
    mainDepot,
    meta: raw._meta || {},
  };
}

module.exports = { buildFromConfig };
