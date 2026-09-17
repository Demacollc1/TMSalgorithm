'use strict';

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Distancia haversine en kilómetros entre dos puntos {lat, lng}
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Punto intermedio por interpolación lineal (suficiente a escala urbana)
function interpolate(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

// Rumbo aproximado del vector a→b, en grados (0 = norte)
function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Distancia mínima (km) de un punto a una polilínea [[lat,lng],...]
function pointToPolylineKm(p, polyline) {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const a = { lat: polyline[i - 1][0], lng: polyline[i - 1][1] };
    const b = { lat: polyline[i][0], lng: polyline[i][1] };
    // proyección aproximada en coordenadas planas (válida a escala urbana)
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const proj = { lat: a.lat + dy * t, lng: a.lng + dx * t };
    const d = haversineKm(p, proj);
    if (d < best) best = d;
  }
  return best;
}

function centroid(points) {
  if (!points.length) return null;
  const sum = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

module.exports = { haversineKm, interpolate, bearing, centroid, pointToPolylineKm };
