'use strict';

const https = require('https');
const http = require('http');
const { db, logEvent } = require('./store');

/**
 * Despacho de webhooks: envía un POST JSON a cada suscripción cuyo
 * listado de eventos incluya el evento emitido (o '*').
 * Los fallos se registran pero no interrumpen la operación.
 */
function dispatchWebhooks(event, payload) {
  const subs = db.webhooks.filter(
    (w) => w.active !== false && (w.events.includes('*') || w.events.includes(event))
  );
  const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });
  for (const sub of subs) {
    try {
      const url = new URL(sub.url);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-RutaFleet-Event': event,
          },
          timeout: 5000,
        },
        (res) => res.resume()
      );
      req.on('error', (err) => {
        logEvent('webhook.error', { webhookId: sub.id, event, error: err.message });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
      sub.lastDeliveryAt = new Date().toISOString();
    } catch (err) {
      logEvent('webhook.error', { webhookId: sub.id, event, error: err.message });
    }
  }
}

module.exports = { dispatchWebhooks };
