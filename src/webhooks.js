'use strict';

const https = require('https');
const http = require('http');
const { db, logEvent } = require('./store');

function postJson(targetUrl, event, body, onError) {
  try {
    const url = new URL(targetUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Macotrans-Event': event,
        },
        timeout: 5000,
      },
      (res) => res.resume()
    );
    req.on('error', onError);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
    return true;
  } catch (err) {
    onError(err);
    return false;
  }
}

/**
 * Despacho de webhooks: envía un POST JSON a cada suscripción global cuyo
 * listado de eventos incluya el evento emitido (o '*'). Si se indica
 * `companyId`, también notifica al webhook configurado por esa empresa
 * cliente (integración ERP / e-commerce). Los fallos se registran pero
 * no interrumpen la operación.
 */
function dispatchWebhooks(event, payload, { companyId } = {}) {
  const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });

  const subs = db.webhooks.filter(
    (w) => w.active !== false && (w.events.includes('*') || w.events.includes(event))
  );
  for (const sub of subs) {
    const ok = postJson(sub.url, event, body, (err) => {
      logEvent('webhook.error', { webhookId: sub.id, event, error: err.message });
    });
    if (ok) sub.lastDeliveryAt = new Date().toISOString();
  }

  if (companyId) {
    const company = db.companies.find((c) => c.id === companyId);
    if (company && company.active !== false && company.webhookUrl) {
      const ok = postJson(company.webhookUrl, event, body, (err) => {
        logEvent('webhook.error', { companyId, event, error: err.message });
      });
      if (ok) company.lastWebhookAt = new Date().toISOString();
    }
  }
}

module.exports = { dispatchWebhooks };
