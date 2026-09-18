'use strict';

/**
 * Formato de impresión de ruta: por cada parada, la guía de remisión y
 * el resumen de factura, con la tabla de contenedores/bultos y el campo
 * "Recibí conforme". Pensado para imprimirse y viajar con el conductor.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "QR" ilustrativo: patrón determinístico a partir del texto (el QR real
// lo emite el webservice de facturación autorizado)
function pseudoQr(text, size = 21) {
  let h = 2166136261;
  const cells = [];
  for (let i = 0; i < size * size; i++) {
    const ch = text.charCodeAt(i % text.length);
    h = Math.imul(h ^ ch ^ i, 16777619) >>> 0;
    cells.push(h % 3 === 0);
  }
  const px = 3;
  const rects = cells
    .map((on, i) => {
      if (!on) return '';
      const x = (i % size) * px;
      const y = Math.floor(i / size) * px;
      return `<rect x="${x}" y="${y}" width="${px}" height="${px}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${size * px} ${size * px}" width="64" height="64" fill="#111">${rects}</svg>`;
}

function renderRoutePrint({ route, orders, vehicle, driver, billing, companyName }) {
  const docs = route.documents || [];
  const pages = docs
    .map((doc) => {
      const order = orders.find((o) => o.id === doc.orderId) || {};
      const bultoRows = doc.guia.bultos
        .map(
          (b) => `
        <tr>
          <td class="mono">${esc(b.containerId)}</td>
          <td>${esc(b.descripcion)}</td>
          <td class="num">${b.items}</td>
          <td class="num">${b.pesoKg}</td>
          <td>${esc(b.zona || '')}</td>
        </tr>`
        )
        .join('');
      return `
  <section class="page">
    <div class="topbar">
      <div><span class="lbl">Ruta/Stop:</span> <strong>${esc(route.id)} / ${doc.stopSeq}</strong></div>
      <div><span class="lbl">Seguimiento:</span> <strong class="mono">${esc(doc.trackingCode || '')}</strong></div>
      <div class="qr">${pseudoQr(doc.guia.claveAcceso)}</div>
    </div>
    <header>
      <div class="emisor">
        <div class="brand"><b>MACO</b>TRANS</div>
        <div>${esc(billing.razonSocial)} · RUC ${esc(billing.ruc)}</div>
        <div>${esc(billing.direccion)}</div>
        <div><span class="lbl">Punto de partida:</span> ${esc(billing.direccion)}</div>
      </div>
      <div class="docbox">
        <div class="doc-title">GUÍA DE REMISIÓN</div>
        <div class="doc-num"># ${esc(doc.guia.numero)}</div>
        <div class="lbl">Clave de acceso</div>
        <div class="mono small">${esc(doc.guia.claveAcceso)}</div>
        <div><span class="lbl">Emisión:</span> ${esc(doc.guia.fechaEmision)} · <span class="lbl">Motivo:</span> ${esc(doc.guia.motivoTraslado)}</div>
      </div>
    </header>

    <div class="grid2">
      <div class="box">
        <div class="box-title">Información de destino</div>
        <div><strong>${esc(doc.guia.destinatario.razonSocial)}</strong></div>
        <div>${esc(doc.guia.destinatario.direccion)}</div>
        <div>${esc(doc.guia.destinatario.ciudad)} · ${doc.guia.destinatario.lat}, ${doc.guia.destinatario.lng}</div>
        <div><span class="lbl">ETA:</span> ${esc(doc.guia.transporte.eta || '—')}</div>
      </div>
      <div class="box">
        <div class="box-title">Información de transporte</div>
        <div><span class="lbl">Conductor:</span> ${esc(doc.guia.transporte.conductor || '—')}</div>
        <div><span class="lbl">Placa:</span> <strong>${esc(doc.guia.transporte.placa || '—')}</strong></div>
        <div><span class="lbl">Ruta:</span> ${esc(route.id)} · ${esc(route.date)}</div>
      </div>
    </div>

    <div class="box">
      <div class="box-title">Instrucciones de entrega</div>
      <div class="instr">${esc(order.notes || '')}&nbsp;</div>
    </div>

    <table>
      <thead>
        <tr><th>Id. Contenedor</th><th>Descripción</th><th class="num">Ítems</th><th class="num">Peso (kg)</th><th>Zona de carga</th></tr>
      </thead>
      <tbody>${bultoRows}</tbody>
    </table>

    <div class="factura">
      <div class="docbox">
        <div class="doc-title">FACTURA</div>
        <div class="doc-num"># ${esc(doc.factura.numero)}</div>
        <div class="mono small">${esc(doc.factura.claveAcceso)}</div>
      </div>
      <div class="totales">
        <div><span class="lbl">Cliente:</span> ${esc(doc.factura.cliente.razonSocial)} (${esc(doc.factura.cliente.identificacion)})</div>
        <div><span class="lbl">Subtotal:</span> ${money(doc.factura.subtotal)} ·
             <span class="lbl">IVA ${doc.factura.ivaPct}%:</span> ${money(doc.factura.iva)} ·
             <span class="lbl">TOTAL:</span> <strong>${money(doc.factura.total)}</strong></div>
      </div>
    </div>

    <div class="recibi">
      <div class="box-title">Recibí conforme</div>
      <div class="firma"></div>
      <div class="lbl">Nombre / C.I. / Firma · Fecha y hora</div>
    </div>
  </section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Documentos de ruta ${esc(route.id)} · ${esc(companyName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 12.5px; color: #16191d; background: #eceef1; }
  .page { background: #fff; max-width: 820px; margin: 18px auto; padding: 26px 30px; border: 1px solid #d6d9de; }
  .topbar { display: flex; justify-content: space-between; align-items: center; gap: 14px; border: 1.5px solid #16191d; padding: 8px 12px; margin-bottom: 14px; }
  .brand { font-size: 21px; font-weight: 800; letter-spacing: 1px; color: #3d4148; }
  .brand b { color: #be1e2d; }
  header { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 12px; }
  .lbl { color: #5c636e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  .docbox { border: 1.5px solid #16191d; padding: 10px 12px; min-width: 300px; }
  .doc-title { font-weight: 800; letter-spacing: 0.6px; }
  .doc-num { font-size: 17px; font-weight: 800; color: #be1e2d; margin: 2px 0 4px; }
  .mono { font-family: ui-monospace, monospace; }
  .small { font-size: 11px; word-break: break-all; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .box { border: 1px solid #b9bec6; padding: 8px 10px; margin-bottom: 10px; }
  .box-title { font-weight: 800; font-size: 11.5px; text-transform: uppercase; color: #3d4148; margin-bottom: 4px; }
  .instr { min-height: 30px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
  th, td { border: 1px solid #b9bec6; padding: 5px 8px; text-align: left; font-size: 12px; }
  th { background: #f0f1f3; font-size: 11px; text-transform: uppercase; }
  .num { text-align: right; }
  .factura { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 14px; }
  .totales { padding-top: 6px; display: flex; flex-direction: column; gap: 6px; }
  .recibi .firma { border: 1px solid #b9bec6; height: 64px; margin: 6px 0; }
  .toolbar { max-width: 820px; margin: 14px auto 0; display: flex; justify-content: space-between; align-items: center; }
  .toolbar button { background: #be1e2d; color: #fff; border: none; border-radius: 8px; padding: 10px 18px; font-weight: 700; cursor: pointer; }
  @media print { body { background: #fff; } .toolbar { display: none; } .page { border: none; margin: 0; page-break-after: always; } }
</style>
</head>
<body>
  <div class="toolbar">
    <div><strong>${docs.length}</strong> documento(s) · Ruta ${esc(route.id)} · ${esc(vehicle ? vehicle.plate : '')} · ${esc(driver ? driver.name : '')}</div>
    <button onclick="window.print()">🖨 Imprimir</button>
  </div>
  ${pages}
</body>
</html>`;
}

module.exports = { renderRoutePrint };
