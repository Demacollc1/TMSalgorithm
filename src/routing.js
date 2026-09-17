'use strict';

const http = require('http');
const https = require('https');
const { haversineKm } = require('./geo');

/**
 * Motor de ruteo por calles reales.
 *
 * Provee distancias y tiempos por la RED VIAL (no en línea recta) y el
 * trazado real de la ruta, con un modelo de TRÁFICO por hora del día.
 *
 * Proveedores:
 *  - 'osrm'   (por defecto): OSRM público o self-hosted. Gratuito, calles
 *             reales, sin tráfico en vivo → se le aplica el modelo horario.
 *  - 'google' / 'mapbox' (si se configura apiKey): tráfico en vivo.
 *  - fallback 'haversine': línea recta × factor calle, si no hay red.
 *
 * Config en company.routing:
 *  { enabled, provider, osrmUrl, apiKey, streetFactor, avgSpeedKmh,
 *    trafficByHour: { "7": 1.6, ... } }
 */

const DEFAULTS = {
  enabled: true,
  provider: 'osrm',
  osrmUrl: 'https://router.project-osrm.org',
  apiKey: '',
  streetFactor: 1.3, // recta → calle, solo para el fallback
  avgSpeedKmh: 30, // velocidad media urbana para el fallback
  // multiplicador de tiempo por hora del día (tráfico típico Guayaquil)
  trafficByHour: {
    0: 0.85, 1: 0.85, 2: 0.85, 3: 0.85, 4: 0.9, 5: 1.0, 6: 1.25,
    7: 1.6, 8: 1.55, 9: 1.25, 10: 1.1, 11: 1.15, 12: 1.35, 13: 1.4,
    14: 1.15, 15: 1.1, 16: 1.2, 17: 1.6, 18: 1.65, 19: 1.35, 20: 1.1,
    21: 1.0, 22: 0.9, 23: 0.85,
  },
};

let CONFIG = { ...DEFAULTS };
let LAST = { source: null, error: null, at: null }; // diagnóstico de la última llamada
function configure(cfg) {
  CONFIG = { ...DEFAULTS, ...(cfg || {}), trafficByHour: { ...DEFAULTS.trafficByHour, ...((cfg || {}).trafficByHour || {}) } };
}
function getConfig() {
  return CONFIG;
}
function getStatus() {
  return { provider: CONFIG.provider, osrmUrl: CONFIG.osrmUrl, enabled: CONFIG.enabled, last: LAST };
}
function noteResult(source, error) {
  LAST = { source, error: error ? String(error.message || error) : null, at: new Date().toISOString() };
}

// prueba en vivo del ruteo (2 puntos) para diagnosticar conectividad
async function probe() {
  const a = { lat: -2.1522, lng: -79.8779 };
  const b = { lat: -2.0882, lng: -79.904 };
  const g = await routeGeometry([a, b]);
  return { ok: g.source === 'osrm', source: g.source, distanceKm: g.distanceKm, error: LAST.error, osrmUrl: CONFIG.osrmUrl, provider: CONFIG.provider };
}

function trafficMultiplier(hhmm) {
  const h = Number(String(hhmm || '09:00').split(':')[0]) || 9;
  const m = CONFIG.trafficByHour[h];
  return typeof m === 'number' ? m : 1;
}

// ------------------------------------------------------------- HTTP
function getJsonOnce(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'MacotransTMS/1.0' } }, (res) => {
      // sigue una redirección simple si la hubiera
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return getJsonOnce(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('respuesta no-JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout (' + timeoutMs + 'ms)')));
  });
}

// con un reintento ante fallos transitorios (red / límite del servidor)
async function getJson(url, timeoutMs = 12000) {
  try {
    return await getJsonOnce(url, timeoutMs);
  } catch (err) {
    await new Promise((r) => setTimeout(r, 400));
    return getJsonOnce(url, timeoutMs);
  }
}

function offline() {
  return process.env.ROUTING_DISABLE === '1' || CONFIG.enabled === false;
}

// ------------------------------------------------- matriz de distancias
/**
 * Matriz por calles reales entre puntos [{lat,lng}].
 * @returns {{dist:number[][], dur:number[][], source:string}}
 *   dist en km, dur en minutos (sin ajuste de tráfico; se aplica aparte).
 */
async function roadMatrix(points) {
  const n = points.length;
  if (!offline() && CONFIG.provider === 'osrm' && n <= 100) {
    try {
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const url = `${CONFIG.osrmUrl}/table/v1/driving/${coords}?annotations=distance,duration`;
      const json = await getJson(url);
      if (json.code === 'Ok' && json.distances && json.durations) {
        const dist = json.distances.map((row) => row.map((m) => (m == null ? Infinity : m / 1000)));
        const dur = json.durations.map((row) => row.map((s) => (s == null ? Infinity : s / 60)));
        noteResult('osrm', null);
        return { dist, dur, source: 'osrm' };
      }
      noteResult('haversine', new Error('OSRM code=' + json.code));
    } catch (err) {
      noteResult('haversine', err);
    }
  }
  return haversineMatrix(points);
}

function haversineMatrix(points) {
  const n = points.length;
  const dist = Array.from({ length: n }, () => new Array(n).fill(0));
  const dur = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const km = haversineKm(points[i], points[j]) * CONFIG.streetFactor;
      dist[i][j] = km;
      dur[i][j] = (km / CONFIG.avgSpeedKmh) * 60;
    }
  }
  return { dist, dur, source: 'haversine' };
}

// ------------------------------------------------- trazado real de ruta
/**
 * Geometría por calles de una secuencia de puntos.
 * @returns {{polyline:[number,number][], distanceKm:number, durationMin:number, source:string}}
 */
async function routeGeometry(points) {
  if (points.length < 2) {
    return { polyline: points.map((p) => [p.lat, p.lng]), distanceKm: 0, durationMin: 0, source: 'none' };
  }
  if (!offline() && CONFIG.provider === 'osrm') {
    try {
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const url = `${CONFIG.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      const json = await getJson(url);
      if (json.code === 'Ok' && json.routes && json.routes[0]) {
        const r = json.routes[0];
        noteResult('osrm', null);
        return {
          polyline: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
          distanceKm: Math.round((r.distance / 1000) * 100) / 100,
          durationMin: Math.round(r.duration / 60),
          source: 'osrm',
        };
      }
      noteResult('haversine', new Error('OSRM code=' + json.code));
    } catch (err) {
      noteResult('haversine', err);
    }
  }
  // fallback: segmentos rectos y distancia haversine × factor
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]) * CONFIG.streetFactor;
  return {
    polyline: points.map((p) => [p.lat, p.lng]),
    distanceKm: Math.round(km * 100) / 100,
    durationMin: Math.round((km / CONFIG.avgSpeedKmh) * 60),
    source: 'haversine',
  };
}

module.exports = { configure, getConfig, getStatus, probe, roadMatrix, routeGeometry, trafficMultiplier, haversineMatrix };
