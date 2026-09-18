'use strict';

const { db, nextId, logEvent } = require('./store');
const { haversineKm, pointToPolylineKm } = require('./geo');
const { dispatchWebhooks, dispatchToUrl } = require('./webhooks');

/**
 * Capa de IA operativa del TMS.
 *
 * Automatiza el monitoreo y deja el sistema "AI-ready": cada caso,
 * consulta al chofer, notificación e informe de ruta se registra y se
 * reenvía al webservice de IA configurado (company.ai.webserviceUrl),
 * donde un agente LLM puede analizarlo y responder por API.
 *
 * Cubre:
 *  1. Monitoreo activo: desvío de ruta → consulta al chofer → informe final
 *  2. Discrepancia de geolocalización en la entrega → caso para corregir
 *  3. Aviso al cliente cuando su entrega es la siguiente (con ETA)
 *  4. Aviso de retraso respecto de la hora informada
 *  5. Solicitud de feedback (demora alta o cliente cerrado)
 */

function aiConfig() {
  return db.company.ai || {};
}

function pushToAi(kind, payload) {
  const cfg = aiConfig();
  if (cfg.enabled && cfg.webserviceUrl) {
    dispatchToUrl(cfg.webserviceUrl, 'ai.' + kind, payload);
  }
}

// ---------------------------------------------------------------- casos
function createCase(type, data, { title, severity = 'media' } = {}) {
  // evita duplicados abiertos del mismo tipo sobre el mismo objeto
  const dup = db.cases.find(
    (c) => c.type === type && c.status === 'abierto' &&
      c.data.routeId === data.routeId && c.data.orderId === data.orderId
  );
  if (dup) return dup;
  const kase = {
    id: nextId('CASO'),
    type, // geo_discrepancia | desvio_ruta | senal_perdida | emergencia | ...
    title: title || type,
    severity, // baja | media | alta
    status: 'abierto', // abierto | resuelto | descartado
    data,
    resolution: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  db.cases.unshift(kase);
  logEvent('case.created', { caseId: kase.id, type, title: kase.title });
  dispatchWebhooks('case.created', kase);
  pushToAi('case', kase);
  return kase;
}

// -------------------------------------------------------- notificaciones
function notifyCustomer(order, type, message, extra = {}) {
  const notif = {
    id: nextId('NTF'),
    type, // siguiente_entrega | retraso | feedback_solicitado | ...
    orderId: order.id,
    trackingCode: order.trackingCode,
    customer: order.customer,
    channel: order.contact && order.contact.phone ? 'sms/whatsapp' : 'portal',
    to: order.contact ? order.contact.phone || order.contact.email : null,
    message,
    ...extra,
    at: new Date().toISOString(),
  };
  db.notifications.unshift(notif);
  if (db.notifications.length > 500) db.notifications.length = 500;
  logEvent('notify.' + type, { orderId: order.id, code: order.code });
  dispatchWebhooks('customer.notified', notif, { companyId: order.companyId });
  pushToAi('notification', notif);
  return notif;
}

// ------------------------------------------- 1. monitoreo de desvíos
function checkDeviation(route, position) {
  const cfg = aiConfig();
  if (!cfg.enabled || !route.polyline) return;
  const km = pointToPolylineKm(position, route.polyline);
  if (km < (cfg.deviationKm || 0.5)) return;
  route.aiConsultas = route.aiConsultas || [];
  // una consulta pendiente a la vez por ruta
  if (route.aiConsultas.some((c) => c.status === 'pendiente')) return;
  const consulta = {
    id: nextId('AIQ'),
    question: `Detectamos que estás a ${km.toFixed(1)} km de la ruta planificada. ¿Cuál es el motivo?`,
    options: ['Tráfico / vía cerrada', 'Inseguridad en la zona', 'Pedido del cliente', 'Necesidad personal', 'Otro'],
    deviationKm: Math.round(km * 100) / 100,
    at: new Date().toISOString(),
    status: 'pendiente',
    answer: null,
    answeredAt: null,
  };
  route.aiConsultas.push(consulta);
  logEvent('ai.consulta', { routeId: route.id, deviationKm: consulta.deviationKm });
  pushToAi('consulta', { routeId: route.id, consulta });
  return consulta;
}

function answerConsulta(route, consultaId, answer, detail) {
  const consulta = (route.aiConsultas || []).find((c) => c.id === consultaId);
  if (!consulta) return null;
  consulta.status = 'respondida';
  consulta.answer = answer;
  consulta.detail = detail || '';
  consulta.answeredAt = new Date().toISOString();
  route.simulateDeviation = false; // demo: al responder, retoma la ruta
  pushToAi('consulta_respuesta', { routeId: route.id, consulta });
  return consulta;
}

// ------------------------- 2. discrepancia de geolocalización al entregar
function checkGeoDiscrepancy(order, actual) {
  const cfg = aiConfig();
  if (!cfg.enabled || !actual || typeof actual.lat !== 'number') return;
  const km = haversineKm({ lat: order.lat, lng: order.lng }, actual);
  if (km < (cfg.geoDiscrepancyKm || 0.3)) return;
  return createCase(
    'geo_discrepancia',
    {
      orderId: order.id,
      orderCode: order.code,
      customer: order.customer,
      routeId: order.routeId,
      registrado: { lat: order.lat, lng: order.lng },
      real: { lat: actual.lat, lng: actual.lng },
      distanciaKm: Math.round(km * 100) / 100,
    },
    {
      title: `Entrega de ${order.customer} confirmada a ${km.toFixed(2)} km de la dirección registrada`,
      severity: km > 1 ? 'alta' : 'media',
    }
  );
}

// -------------------------------- 3 y 4. avisos de siguiente entrega/retraso
function notifyNextDelivery(route) {
  const next = route.stops.find((s) => s.orderId && !['completada', 'delegada'].includes(s.status));
  if (!next) return;
  const order = db.orders.find((o) => o.id === next.orderId);
  if (!order || order._notifiedNext) return;
  order._notifiedNext = true;
  notifyCustomer(
    order,
    'siguiente_entrega',
    `Hola ${order.customer}: tu entrega es la SIGUIENTE en la ruta. Hora estimada de llegada: ${next.eta}. Sigue el avance con tu código ${order.trackingCode}.`,
    { eta: next.eta }
  );
}

function notifyDelay(route, reason) {
  for (const stop of route.stops) {
    if (!stop.orderId || ['completada', 'delegada'].includes(stop.status)) continue;
    const order = db.orders.find((o) => o.id === stop.orderId);
    if (!order || order._notifiedDelay) continue;
    order._notifiedDelay = true;
    notifyCustomer(
      order,
      'retraso',
      `Hola ${order.customer}: tu entrega (ETA original ${stop.eta}) llegará más tarde de lo previsto${reason ? ' por ' + reason : ''}. Disculpa la demora; puedes seguir el avance con tu código ${order.trackingCode}.`
    );
  }
}

// ------------------------------------------------- 5. feedback del cliente
function requestFeedback(order, motivo) {
  if (order._feedbackRequested) return;
  order._feedbackRequested = true;
  notifyCustomer(
    order,
    'feedback_solicitado',
    `Hola ${order.customer}: queremos mejorar. ${motivo}. Califícanos ingresando tu código ${order.trackingCode} en el portal de seguimiento.`,
    { motivo }
  );
}

// ------------------------------------------------- informe final de ruta
function buildRouteReport(route) {
  const stops = route.stops.filter((s) => s.orderId);
  const orders = stops
    .map((s) => db.orders.find((o) => o.id === s.orderId))
    .filter(Boolean);
  const expenses = db.expenses.filter((e) => e.routeId === route.id);
  const report = {
    routeId: route.id,
    vehicleId: route.vehicleId,
    date: route.date,
    startedAt: route.startedAt,
    completedAt: route.completedAt,
    distanceKm: route.distanceKm,
    plannedDurationMin: route.durationMin,
    stops: stops.map((s) => {
      const o = orders.find((x) => x.id === s.orderId) || {};
      return {
        seq: s.seq,
        orderCode: o.code,
        customer: o.customer,
        etaPlanificada: s.eta,
        llegada: s.arrivedAt,
        resultado: o.status,
        pod: o.pod ? { resultado: o.pod.resultado, notas: o.pod.notes } : null,
      };
    }),
    resultados: {
      entregados: orders.filter((o) => ['entregado', 'recolectado'].includes(o.status)).length,
      parciales: orders.filter((o) => o.status === 'entrega_parcial').length,
      fallidos: orders.filter((o) => ['devuelto', 'rechazado', 'no_entregado'].includes(o.status)).length,
    },
    consultasIA: route.aiConsultas || [],
    casos: db.cases.filter((c) => c.data && c.data.routeId === route.id)
      .map((c) => ({ id: c.id, type: c.type, title: c.title, status: c.status })),
    delegaciones: db.delegations.filter((d) => d.fromRouteId === route.id || d.toRouteId === route.id)
      .map((d) => ({ id: d.id, orderCode: d.orderCode, status: d.status, motivo: d.motivo })),
    gastos: {
      total: Math.round(expenses.reduce((s, e) => s + e.montoUsd, 0) * 100) / 100,
      detalle: expenses.map((e) => ({ tipo: e.tipo, montoUsd: e.montoUsd, notas: e.notas, orderId: e.orderId })),
    },
    notas:
      'Informe para análisis: si las respuestas del chofer son coherentes y ' +
      'aceleran la ruta, alimentan el algoritmo de cálculo (velocidades, ' +
      'tiempos de servicio y zonas a evitar).',
    generatedAt: new Date().toISOString(),
  };
  route.aiReport = report;
  logEvent('ai.report', { routeId: route.id });
  dispatchWebhooks('route.report', { routeId: route.id });
  pushToAi('route_report', report);
  return report;
}

// --------------------------------------------------- telemetría multi-GPS
const SOURCE_PRIORITY = ['celular', 'gps_vehiculo', 'dashcam'];

function recordTelemetry(vehicleId, source, data) {
  db.telemetry[vehicleId] = db.telemetry[vehicleId] || {};
  db.telemetry[vehicleId][source] = { ...data, source, at: new Date().toISOString() };
}

function bestPosition(vehicleId, maxAgeMs = 120000) {
  const t = db.telemetry[vehicleId];
  if (!t) return null;
  const now = Date.now();
  for (const source of SOURCE_PRIORITY) {
    const p = t[source];
    if (p && now - new Date(p.at).getTime() <= maxAgeMs) return p;
  }
  return null;
}

// protocolo: el celular dejó de transmitir pero el GPS del vehículo sigue vivo
function checkSignalLoss(route) {
  const t = db.telemetry[route.vehicleId];
  if (!t || !t.celular) return;
  const phoneAge = Date.now() - new Date(t.celular.at).getTime();
  const backup = t.gps_vehiculo || t.dashcam;
  if (phoneAge > 90000 && backup && Date.now() - new Date(backup.at).getTime() < 60000) {
    createCase(
      'senal_perdida',
      {
        routeId: route.id,
        vehicleId: route.vehicleId,
        ultimaSenalCelular: t.celular.at,
        fuenteRespaldo: backup.source,
        posicionRespaldo: { lat: backup.lat, lng: backup.lng },
      },
      {
        title: `Se perdió la señal del celular en la ruta ${route.id}; siguiendo por ${backup.source}`,
        severity: 'alta',
      }
    );
  }
}

module.exports = {
  createCase,
  notifyCustomer,
  checkDeviation,
  answerConsulta,
  checkGeoDiscrepancy,
  notifyNextDelivery,
  notifyDelay,
  requestFeedback,
  buildRouteReport,
  recordTelemetry,
  bestPosition,
  checkSignalLoss,
  SOURCE_PRIORITY,
};
