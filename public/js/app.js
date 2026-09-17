'use strict';

/* Macotrans TMS — SPA. Vanilla JS + Leaflet. */

const API = '/api/v1';
const ROUTE_COLORS = ['#1f5eff', '#00b386', '#e5484d', '#f0a020', '#8b5cf6', '#0ea5e9', '#d946ef', '#84cc16'];

const state = {
  company: null,
  companies: [],
  orders: [],
  vehicles: [],
  drivers: [],
  deposits: [],
  fleets: [],
  schemas: [],
  trailers: [],
  routes: [],
  view: 'panel',
  maps: {},
  layers: { plan: null, live: null, vehicles: {} },
  pollTimer: null,
};

// ------------------------------------------------------------ util
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json.data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badge(text, cls) {
  return `<span class="badge ${esc(cls || text)}">${esc(text).replace(/_/g, ' ')}</span>`;
}

function routeColor(i) {
  return ROUTE_COLORS[i % ROUTE_COLORS.length];
}

// ------------------------------------------------------------ modal
function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
}
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

// ------------------------------------------------------------ carga de datos
async function refreshData() {
  [state.orders, state.vehicles, state.drivers, state.routes, state.companies, state.trailers] = await Promise.all([
    api('/orders'),
    api('/vehicles'),
    api('/drivers'),
    api('/routes'),
    api('/companies'),
    api('/trailers'),
  ]);
  if (!state.company) state.company = await api('/company');
  if (!state.deposits.length) {
    [state.deposits, state.fleets, state.schemas] = await Promise.all([
      api('/deposits'),
      api('/fleets'),
      api('/schemas'),
    ]);
  }
}

// ------------------------------------------------------------ enrutado SPA
function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  const el = document.getElementById('view-' + view);
  if (el) el.classList.remove('hidden');
  document.querySelectorAll('.nav-item[data-view]').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === view);
  });
  render();
}

window.addEventListener('hashchange', () => {
  const view = (location.hash || '#/panel').replace('#/', '') || 'panel';
  setView(view);
});

// ------------------------------------------------------------ render
async function render() {
  try {
    await refreshData();
  } catch (err) {
    toast('Error cargando datos: ' + err.message, true);
    return;
  }
  const view = state.view;
  if (view === 'panel') renderPanel();
  if (view === 'pedidos') renderOrders();
  if (view === 'flota') renderFleet();
  if (view === 'direcciones') renderAddresses();
  if (view === 'planificacion') renderPlanning();
  if (view === 'carga') renderLoading();
  if (view === 'monitoreo') renderMonitoring();
  if (view === 'empresas') renderCompanies();
  if (view === 'webhooks') renderWebhooks();
}

// ============================================================ PANEL
async function renderPanel() {
  const kpis = await api('/kpis');
  const events = await api('/events');
  document.getElementById('panel-depot').textContent = state.company.depot.name;

  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi blue"><div class="kpi-label">Pedidos del día</div><div class="kpi-value">${kpis.orders.total}</div><div class="kpi-extra">${kpis.orders.pending} pendientes</div></div>
    <div class="kpi green"><div class="kpi-label">Completados</div><div class="kpi-value">${kpis.orders.done}</div><div class="kpi-extra">entregas + recolecciones</div></div>
    <div class="kpi orange"><div class="kpi-label">En ruta</div><div class="kpi-value">${kpis.orders.inRoute}</div><div class="kpi-extra">${kpis.routes.active} rutas activas</div></div>
    <div class="kpi red"><div class="kpi-label">No entregados</div><div class="kpi-value">${kpis.orders.failed}</div><div class="kpi-extra">requieren gestión</div></div>
    <div class="kpi green"><div class="kpi-label">Cumplimiento</div><div class="kpi-value">${kpis.compliancePct}%</div><div class="kpi-extra">sobre pedidos cerrados</div></div>
    <div class="kpi blue"><div class="kpi-label">Km planificados</div><div class="kpi-value">${kpis.totalKm}</div><div class="kpi-extra">${kpis.routes.planned} rutas planificadas · ${kpis.routes.completed} completadas</div></div>
  `;

  const communes = Object.entries(kpis.byCommune).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...communes.map((c) => c[1]));
  document.getElementById('chart-communes').innerHTML = communes
    .map(
      ([name, n]) => `
      <div class="bar-row">
        <span>${esc(name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(n / max) * 100}%"></div></div>
        <strong>${n}</strong>
      </div>`
    )
    .join('');

  const EV_LABEL = {
    'order.created': '📦 Pedidos creados',
    'order.entregado': '✅ Pedido entregado',
    'order.recolectado': '📥 Recolección realizada',
    'routes.planned': '🗺️ Rutas planificadas',
    'route.iniciada': '▶️ Ruta iniciada',
    'route.completada': '🏁 Ruta completada',
    'route.transbordo': '🔄 Transbordo nodriza',
    'webhook.error': '⚠️ Error de webhook',
  };
  document.getElementById('event-feed').innerHTML =
    events
      .map((e) => {
        const t = new Date(e.at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const detail = e.payload.code || e.payload.routeId || (e.payload.count != null ? e.payload.count + ' ítems' : '');
        return `<li><span class="ev-time">${t}</span><span>${EV_LABEL[e.type] || esc(e.type)} <strong>${esc(detail)}</strong></span></li>`;
      })
      .join('') || '<li><span>Sin actividad todavía. Planifica rutas para comenzar.</span></li>';
}

function companyName(companyId) {
  if (!companyId) return '—';
  const c = state.companies.find((x) => x.id === companyId);
  return c ? c.name : companyId;
}

// ============================================================ PEDIDOS
function renderOrders() {
  const filter = document.getElementById('filter-status').value;
  const list = filter ? state.orders.filter((o) => o.status === filter) : state.orders;
  document.querySelector('#orders-table tbody').innerHTML = list
    .map(
      (o) => `
    <tr>
      <td><strong>${esc(o.code)}</strong></td>
      <td><code>${esc(o.trackingCode || '—')}</code></td>
      <td>${badge(o.type)}</td>
      <td>${esc(companyName(o.companyId))}</td>
      <td>${esc(o.customer)}</td>
      <td class="wrap">${esc(o.address)}</td>
      <td>${esc(o.timeWindow.start)}–${esc(o.timeWindow.end)}</td>
      <td>${o.weightKg}</td>
      <td>${badge(o.status)}</td>
      <td>${o.pod ? `<button class="btn-link" onclick="showPod('${o.id}')">Ver POD</button>` : '—'}</td>
      <td>
        <button class="btn-link" onclick="editOrder('${o.id}')">Editar</button>
        <button class="btn-link danger" onclick="deleteOrder('${o.id}')">Eliminar</button>
      </td>
    </tr>`
    )
    .join('');
}

function orderForm(o = {}) {
  return `
    <div class="form-grid">
      <label class="field"><span>Código</span><input class="input" id="f-code" value="${esc(o.code || '')}" placeholder="PED-0100"/></label>
      <label class="field"><span>Tipo</span>
        <select class="input" id="f-type" style="width:100%">
          <option value="entrega" ${o.type !== 'recoleccion' ? 'selected' : ''}>Entrega</option>
          <option value="recoleccion" ${o.type === 'recoleccion' ? 'selected' : ''}>Recolección</option>
        </select>
      </label>
      <label class="field full"><span>Cliente</span><input class="input" id="f-customer" value="${esc(o.customer || '')}"/></label>
      <label class="field full"><span>Dirección</span><input class="input" id="f-address" value="${esc(o.address || '')}"/></label>
      <label class="field"><span>Comuna</span><input class="input" id="f-commune" value="${esc(o.commune || '')}"/></label>
      <label class="field"><span>Peso (kg)</span><input class="input" id="f-weight" type="number" value="${o.weightKg ?? 100}"/></label>
      <label class="field"><span>Latitud</span><input class="input" id="f-lat" type="number" step="0.0001" value="${o.lat ?? -33.45}"/></label>
      <label class="field"><span>Longitud</span><input class="input" id="f-lng" type="number" step="0.0001" value="${o.lng ?? -70.66}"/></label>
      <label class="field"><span>Ventana desde</span><input class="input" id="f-tw-start" type="time" value="${esc(o.timeWindow?.start || '09:00')}"/></label>
      <label class="field"><span>Ventana hasta</span><input class="input" id="f-tw-end" type="time" value="${esc(o.timeWindow?.end || '18:00')}"/></label>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" id="f-save">Guardar</button>
    </div>`;
}

function readOrderForm() {
  return {
    code: document.getElementById('f-code').value.trim() || undefined,
    type: document.getElementById('f-type').value,
    customer: document.getElementById('f-customer').value.trim(),
    address: document.getElementById('f-address').value.trim(),
    commune: document.getElementById('f-commune').value.trim(),
    weightKg: Number(document.getElementById('f-weight').value) || 0,
    lat: Number(document.getElementById('f-lat').value),
    lng: Number(document.getElementById('f-lng').value),
    timeWindow: {
      start: document.getElementById('f-tw-start').value,
      end: document.getElementById('f-tw-end').value,
    },
  };
}

document.getElementById('btn-new-order').addEventListener('click', () => {
  openModal('Nuevo pedido', orderForm());
  document.getElementById('f-save').onclick = async () => {
    try {
      await api('/orders', { method: 'POST', body: readOrderForm() });
      closeModal();
      toast('Pedido creado');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
});

window.editOrder = (id) => {
  const o = state.orders.find((x) => x.id === id);
  openModal('Editar pedido ' + o.code, orderForm(o));
  document.getElementById('f-save').onclick = async () => {
    try {
      await api('/orders/' + id, { method: 'PUT', body: readOrderForm() });
      closeModal();
      toast('Pedido actualizado');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
};

window.deleteOrder = async (id) => {
  if (!confirm('¿Eliminar este pedido?')) return;
  await api('/orders/' + id, { method: 'DELETE' });
  toast('Pedido eliminado');
  render();
};

window.showPod = (id) => {
  const o = state.orders.find((x) => x.id === id);
  const p = o.pod;
  openModal('Prueba de entrega · ' + o.code, `
    <p><strong>Estado:</strong> ${badge(o.status)}</p>
    <p style="margin-top:8px"><strong>Fecha/hora:</strong> ${new Date(p.at).toLocaleString('es-CL')}</p>
    <p><strong>Receptor:</strong> ${esc(p.receiver)}</p>
    <p><strong>Método:</strong> ${esc(p.method).replace('_', ' ')}</p>
    ${p.notes ? `<p><strong>Notas:</strong> ${esc(p.notes)}</p>` : ''}
    <p class="muted" style="margin-top:8px">Georreferencia: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</p>
  `);
};

document.getElementById('filter-status').addEventListener('change', renderOrders);

document.getElementById('btn-import-plan').addEventListener('click', () => {
  openModal('Importar plan de entregas (JSON)', `
    <p class="muted">Pega el JSON del plan que genera tu API (formato <code>{ "clients": [...] }</code>, el mismo que se envía a Driv.in). Cada <em>order</em> se registra como un bulto con su código de barras (<code>alt_code</code>).</p>
    <textarea class="input" id="imp-json" rows="12" style="font-family:ui-monospace,monospace;font-size:12px" placeholder='{ "clients": [ { "code": 537, "address": "...", "lat": "-2.15", "lng": "-79.88", "orders": [...] } ] }'></textarea>
    <div class="actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" id="imp-run">Importar</button>
    </div>`);
  document.getElementById('imp-run').onclick = async () => {
    let plan;
    try {
      plan = JSON.parse(document.getElementById('imp-json').value);
    } catch {
      return toast('El texto no es JSON válido (usa comillas dobles en claves y textos)', true);
    }
    try {
      const result = await api('/import', { method: 'POST', body: { plan } });
      closeModal();
      const bultos = result.orders.reduce((s, o) => s + o.bultos, 0);
      toast(`Plan importado: ${result.orders.length} entregas, ${bultos} bultos`);
      if (result.warnings.length) toast(result.warnings.join(' · '), true);
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
});

// ============================================================ FLOTA
function renderFleet() {
  document.querySelector('#vehicles-table tbody').innerHTML = state.vehicles
    .map((v) => {
      const driver = state.drivers.find((d) => d.id === v.driverId);
      return `
      <tr>
        <td><strong>${esc(v.plate)}</strong></td>
        <td>${esc(v.name)} ${v.isNodriza ? badge('nodriza', 'nodriza') : ''}${
          v.tags && v.tags.length
            ? `<br><span class="muted">${v.tags.map(esc).join(' · ')}</span>`
            : ''
        }</td>
        <td>${esc(v.type)}${v.hasParrilla ? ' ▤' : ''}${v.hasTowHitch ? ' <span title="Bola para remolque">🔗</span>' : ''}${v.hasLiftgate ? ' <span title="Montacargas de cola">⬆</span>' : ''}</td>
        <td>${v.capacityKg}</td>
        <td>${v.capacityM3}</td>
        <td>${esc(driver ? driver.name : '—')}</td>
        <td>${v.apto === false ? `<span class="badge no_entregado" title="${esc(v.aptoNotes || '')}">⛔ no apto</span>` : badge(v.status)}</td>
        <td>
          <button class="btn-link" onclick="editVehicle('${v.id}')">Editar</button>
          <button class="btn-link danger" onclick="deleteVehicle('${v.id}')">Eliminar</button>
        </td>
      </tr>`;
    })
    .join('');

  document.querySelector('#drivers-table tbody').innerHTML = state.drivers
    .map(
      (d) => `
      <tr>
        <td><strong>${esc(d.name)}</strong>${d.email ? `<br><span class="muted">${esc(d.email)}</span>` : ''}</td>
        <td>${badge(d.role || 'conductor', d.role === 'peoneta' ? 'asignado' : 'entrega')}</td>
        <td>${esc(d.phone)}</td>
        <td>${esc(d.dni || d.license || '—')}</td>
        <td>${badge(d.status)}</td>
        <td><button class="btn-link danger" onclick="deleteDriver('${d.id}')">Eliminar</button></td>
      </tr>`
    )
    .join('');

  const TRL_BADGE = { disponible: 'disponible', reservado: 'asignado', acoplado: 'en_ruta', estacionado: 'planificada' };
  document.querySelector('#trailers-table tbody').innerHTML = (state.trailers || [])
    .map(
      (t) => `
      <tr>
        <td><strong>${esc(t.code)}</strong></td>
        <td>${esc(t.name)}${t.foldable ? ' <span class="muted">(plegable)</span>' : ''}</td>
        <td>${t.capacityKg}</td>
        <td>${t.capacityM3}</td>
        <td>${badge(t.status, TRL_BADGE[t.status] || t.status)}</td>
        <td class="wrap">${esc(t.locationName || '—')}${t.attachedToVehicleId ? ' · ' + esc((state.vehicles.find((v) => v.id === t.attachedToVehicleId) || {}).plate || '') : ''}</td>
        <td>
          ${t.status === 'estacionado' ? `<button class="btn-link" onclick="freeTrailer('${t.id}')">Marcar retirado</button>` : ''}
          <button class="btn-link danger" onclick="deleteTrailer('${t.id}')">Eliminar</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="7" class="muted">Sin remolques registrados.</td></tr>';

  document.querySelector('#fleets-table tbody').innerHTML = (state.fleets || [])
    .map(
      (f) => `
      <tr>
        <td><strong>${esc(f.name)}</strong></td>
        <td>${f.countVehicles}</td>
        <td>${f.capacityKg ? f.capacityKg.toLocaleString('en-US') : '—'}</td>
        <td>${f.capacityM3 || '—'}</td>
      </tr>`
    )
    .join('') || '<tr><td colspan="4" class="muted">Sin flotas configuradas.</td></tr>';
}

function vehicleForm(v = {}) {
  const driverOpts = state.drivers
    .map((d) => `<option value="${d.id}" ${v.driverId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`)
    .join('');
  return `
    <div class="form-grid">
      <label class="field"><span>Patente</span><input class="input" id="v-plate" value="${esc(v.plate || '')}"/></label>
      <label class="field"><span>Nombre</span><input class="input" id="v-name" value="${esc(v.name || '')}"/></label>
      <label class="field"><span>Tipo</span>
        <select class="input" id="v-type" style="width:100%">
          ${['moto', 'van', 'camion'].map((t) => `<option ${v.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Conductor</span>
        <select class="input" id="v-driver" style="width:100%"><option value="">— Sin asignar —</option>${driverOpts}</select>
      </label>
      <label class="field"><span>Capacidad (kg)</span><input class="input" id="v-kg" type="number" value="${v.capacityKg ?? 1000}"/></label>
      <label class="field"><span>Capacidad (m³)</span><input class="input" id="v-m3" type="number" value="${v.capacityM3 ?? 8}"/></label>
      <label class="check full"><input type="checkbox" id="v-nodriza" ${v.isNodriza ? 'checked' : ''}/><span>Es madre nodriza (transbordo)</span></label>
      <label class="check full"><input type="checkbox" id="v-parrilla" ${v.hasParrilla ? 'checked' : ''}/><span>Tiene parrilla / puede llevar tubos arriba</span></label>
      <label class="check full"><input type="checkbox" id="v-bola" ${v.hasTowHitch ? 'checked' : ''}/><span>Tiene <strong>bola para remolque</strong> (puede acoplar remolques plegables)</span></label>
      <label class="check full"><input type="checkbox" id="v-liftgate" ${v.hasLiftgate ? 'checked' : ''}/><span>Tiene <strong>ascensor / montacargas en la cola</strong></span></label>
      <label class="check full"><input type="checkbox" id="v-apto" ${v.apto !== false ? 'checked' : ''}/><span><strong>Apto para viajar</strong> (matrícula, revisión y mantenimiento al día)</span></label>
      <label class="field full"><span>Observaciones de aptitud</span><input class="input" id="v-apto-notes" value="${esc(v.aptoNotes || '')}" placeholder="Ej.: en mantenimiento, sin revisión vehicular"/></label>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" id="v-save">Guardar</button>
    </div>`;
}

function readVehicleForm() {
  return {
    plate: document.getElementById('v-plate').value.trim(),
    name: document.getElementById('v-name').value.trim(),
    type: document.getElementById('v-type').value,
    driverId: document.getElementById('v-driver').value || null,
    capacityKg: Number(document.getElementById('v-kg').value),
    capacityM3: Number(document.getElementById('v-m3').value),
    isNodriza: document.getElementById('v-nodriza').checked,
    hasParrilla: document.getElementById('v-parrilla').checked,
    hasTowHitch: document.getElementById('v-bola').checked,
    hasLiftgate: document.getElementById('v-liftgate').checked,
    apto: document.getElementById('v-apto').checked,
    aptoNotes: document.getElementById('v-apto-notes').value.trim(),
  };
}

document.getElementById('btn-new-vehicle').addEventListener('click', () => {
  openModal('Nuevo vehículo', vehicleForm());
  document.getElementById('v-save').onclick = async () => {
    try {
      await api('/vehicles', { method: 'POST', body: readVehicleForm() });
      closeModal();
      toast('Vehículo creado');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
});

window.editVehicle = (id) => {
  const v = state.vehicles.find((x) => x.id === id);
  openModal('Editar vehículo ' + v.plate, vehicleForm(v));
  document.getElementById('v-save').onclick = async () => {
    try {
      await api('/vehicles/' + id, { method: 'PUT', body: readVehicleForm() });
      closeModal();
      toast('Vehículo actualizado');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
};

window.deleteVehicle = async (id) => {
  if (!confirm('¿Eliminar este vehículo?')) return;
  await api('/vehicles/' + id, { method: 'DELETE' });
  render();
};

document.getElementById('btn-new-driver').addEventListener('click', () => {
  openModal('Nuevo conductor', `
    <label class="field"><span>Nombre</span><input class="input" id="d-name"/></label>
    <label class="field"><span>Teléfono</span><input class="input" id="d-phone" placeholder="+593 99 ..."/></label>
    <label class="field"><span>Licencia</span><input class="input" id="d-license" value="B"/></label>
    <div class="actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" id="d-save">Guardar</button>
    </div>`);
  document.getElementById('d-save').onclick = async () => {
    try {
      await api('/drivers', {
        method: 'POST',
        body: {
          name: document.getElementById('d-name').value.trim(),
          phone: document.getElementById('d-phone').value.trim(),
          license: document.getElementById('d-license').value.trim(),
        },
      });
      closeModal();
      toast('Conductor creado');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
});

document.getElementById('btn-new-trailer').addEventListener('click', () => {
  openModal('Nuevo remolque', `
    <div class="form-grid">
      <label class="field"><span>Código</span><input class="input" id="t-code" placeholder="RMQ-04"/></label>
      <label class="field"><span>Nombre</span><input class="input" id="t-name" placeholder="Remolque plegable 04"/></label>
      <label class="field"><span>Capacidad (kg)</span><input class="input" id="t-kg" type="number" value="1500"/></label>
      <label class="field"><span>Capacidad (m³)</span><input class="input" id="t-m3" type="number" value="28"/></label>
      <label class="check full"><input type="checkbox" id="t-fold" checked/><span>Es plegable</span></label>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" id="t-save">Guardar</button>
    </div>`);
  document.getElementById('t-save').onclick = async () => {
    try {
      await api('/trailers', {
        method: 'POST',
        body: {
          code: document.getElementById('t-code').value.trim(),
          name: document.getElementById('t-name').value.trim(),
          capacityKg: Number(document.getElementById('t-kg').value),
          capacityM3: Number(document.getElementById('t-m3').value),
          foldable: document.getElementById('t-fold').checked,
        },
      });
      closeModal();
      toast('Remolque agregado');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
});

window.freeTrailer = async (id) => {
  if (!confirm('¿Marcar el remolque como retirado del acopio y disponible en el depósito?')) return;
  const depot = state.company.depot;
  await api('/trailers/' + id, {
    method: 'PUT',
    body: { status: 'disponible', locationName: depot.name, lat: depot.lat, lng: depot.lng },
  });
  toast('Remolque disponible en el depósito');
  render();
};

window.deleteTrailer = async (id) => {
  if (!confirm('¿Eliminar este remolque?')) return;
  try {
    await api('/trailers/' + id, { method: 'DELETE' });
    render();
  } catch (err) {
    toast(err.message, true);
  }
};

window.deleteDriver = async (id) => {
  if (!confirm('¿Eliminar este conductor?')) return;
  await api('/drivers/' + id, { method: 'DELETE' });
  render();
};

// ============================================================ DIRECCIONES
async function renderAddresses() {
  const kpis = await api('/addresses/kpis');
  document.getElementById('adr-kpis').innerHTML = `
    <div class="kpi blue"><div class="kpi-label">Direcciones</div><div class="kpi-value">${kpis.total}</div></div>
    <div class="kpi blue"><div class="kpi-label">Clientes</div><div class="kpi-value">${kpis.clients}</div></div>
    <div class="kpi green"><div class="kpi-label">Georeferenciadas</div><div class="kpi-value">${kpis.georef}</div></div>
    <div class="kpi red"><div class="kpi-label">No georeferenciadas</div><div class="kpi-value">${kpis.noGeoref}</div><div class="kpi-extra">requieren corrección</div></div>
  `;
  await loadAddressRows();
}

async function loadAddressRows() {
  const q = encodeURIComponent(document.getElementById('adr-q').value.trim());
  const georef = document.getElementById('adr-georef').value;
  const res = await fetch(`/api/v1/addresses?q=${q}&georef=${georef}&limit=100`).then((r) => r.json());
  const list = res.data || [];
  document.querySelector('#addresses-table tbody').innerHTML = list
    .map(
      (a) => `
    <tr>
      <td>${a.isGeoref ? '🟢' : '🔴'}</td>
      <td><strong>${esc(a.client)}</strong>${a.code ? `<br><span class="muted">${esc(a.code)}</span>` : ''}</td>
      <td class="wrap">${esc(a.address)}</td>
      <td>${esc(a.city)}</td>
      <td>${esc(a.province)}</td>
      <td>${esc(a.type || '—')}</td>
      <td>${a.lat != null ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}` : '—'}</td>
    </tr>`
    )
    .join('');
  document.getElementById('adr-count').textContent =
    `Mostrando ${list.length} de ${res.count} direcciones.`;
}

let adrTimer = null;
document.getElementById('adr-q').addEventListener('input', () => {
  clearTimeout(adrTimer);
  adrTimer = setTimeout(loadAddressRows, 300);
});
document.getElementById('adr-georef').addEventListener('change', loadAddressRows);

// ============================================================ MAPAS
function ensureMap(key, elId) {
  if (state.maps[key]) return state.maps[key];
  if (typeof L === 'undefined') {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '<p class="muted" style="padding:20px">No se pudo cargar la librería de mapas.</p>';
    return null;
  }
  const depot = state.company.depot;
  const map = L.map(elId).setView([depot.lat, depot.lng], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  state.maps[key] = map;
  return map;
}

function depotMarker(map) {
  if (!map) return;
  const depot = state.company.depot;
  L.marker([depot.lat, depot.lng], {
    icon: L.divIcon({ className: '', html: '<div class="veh-marker">🏭</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
  })
    .addTo(map)
    .bindPopup(`<strong>${esc(depot.name)}</strong><br>${esc(depot.address)}`);
}

function drawRoutesOnMap(map, layerKey, routes, { showPending = true } = {}) {
  if (!map) return;
  if (state.layers[layerKey]) state.layers[layerKey].remove();
  const group = L.layerGroup().addTo(map);
  state.layers[layerKey] = group;

  routes.forEach((route, i) => {
    const color = routeColor(i);
    const style = route.isNodriza
      ? { color: '#101a2b', weight: 4, dashArray: '10 6' }
      : { color, weight: 3.5, opacity: 0.85 };
    L.polyline(route.polyline, style).addTo(group);
    route.stops.forEach((stop) => {
      const done = stop.status === 'completada';
      const mark = stop.transferPointId ? '⇄' : stop.trailerAction ? '🅿' : stop.seq;
      const icon = L.divIcon({
        className: '',
        html: `<div class="stop-marker ${done ? 'done' : ''}" style="--stop-color:${route.isNodriza ? '#101a2b' : color}">${mark}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const order = stop.orderId ? state.orders.find((o) => o.id === stop.orderId) : null;
      const popup = order
        ? `<strong>${esc(order.code)}</strong> · ${badge(order.type)}<br>${esc(order.customer)}<br>${esc(order.address)}<br>ETA ${stop.eta} · ${badge(order.status)}`
        : stop.trailerAction
          ? `<strong>${esc(stop.name)}</strong><br>ETA ${stop.eta} · punto de acopio`
          : `<strong>${esc(stop.name || 'Punto de transbordo')}</strong><br>ETA ${stop.eta} · madre nodriza`;
      L.marker([stop.lat, stop.lng], { icon }).addTo(group).bindPopup(popup);
    });
  });

  if (showPending) {
    state.orders
      .filter((o) => o.status === 'pendiente')
      .forEach((o) => {
        const icon = L.divIcon({
          className: '',
          html: '<div class="stop-marker" style="--stop-color:#9aa8bd">·</div>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        L.marker([o.lat, o.lng], { icon })
          .addTo(group)
          .bindPopup(`<strong>${esc(o.code)}</strong> (sin planificar)<br>${esc(o.address)}`);
      });
  }
}

// ============================================================ PLANIFICACIÓN
function renderPlanning() {
  // selectores de esquema y depósito (datos reales)
  const schemaSel = document.getElementById('opt-schema');
  if (schemaSel && !schemaSel.dataset.filled) {
    schemaSel.innerHTML =
      '<option value="">— Sin esquema (parámetros manuales) —</option>' +
      state.schemas
        .map((s) => `<option value="${s.id}">${esc(s.name)} · ${esc(s.deposit ? s.deposit.name : '')}</option>`)
        .join('');
    schemaSel.dataset.filled = '1';
    schemaSel.addEventListener('change', () => {
      const sc = state.schemas.find((x) => x.id === schemaSel.value);
      const depotSel = document.getElementById('opt-depot');
      if (sc) {
        document.getElementById('opt-return').checked = sc.returnToDepot;
        if (sc.deposit) {
          const dep = state.deposits.find((d) => d.externalId === sc.deposit.externalId || d.name === sc.deposit.name);
          if (dep) depotSel.value = dep.id;
        }
        toast(`Esquema aplicado: servicio ${sc.serviceTimeMin} min · vel. máx ${sc.maxSpeedKmh} km/h`);
      }
    });
  }
  const depotSel = document.getElementById('opt-depot');
  if (depotSel && !depotSel.dataset.filled) {
    depotSel.innerHTML = state.deposits
      .map((d) => `<option value="${d.id}">${esc(d.name)} · ${esc(d.city)}</option>`)
      .join('');
    depotSel.dataset.filled = '1';
  }

  const pending = state.orders.filter((o) => o.status === 'pendiente');
  document.getElementById('opt-orders-count').textContent =
    `${pending.length} pedidos pendientes serán considerados (${pending.filter((o) => o.type === 'recoleccion').length} recolecciones).`;

  document.getElementById('opt-vehicles').innerHTML = state.vehicles
    .map((v) => {
      const usable = v.status === 'disponible' && v.apto !== false;
      return `
      <label class="check" ${!usable ? 'style="opacity:0.55"' : ''}>
        <input type="checkbox" class="opt-veh" value="${v.id}" ${usable ? 'checked' : 'disabled'} />
        <span>${esc(v.plate)} · ${esc(v.name)} (${v.capacityKg} kg)${v.isNodriza ? ' 🚛 nodriza' : ''}${v.hasParrilla ? ' ▤ parrilla' : ''}${v.apto === false ? ` — ⛔ no apto${v.aptoNotes ? ': ' + esc(v.aptoNotes) : ''}` : ''}</span>
      </label>`;
    })
    .join('');

  const map = ensureMap('plan', 'map-plan');
  if (map) setTimeout(() => map.invalidateSize(), 50);
  depotMarker(map);
  const visible = state.routes.filter((r) => ['propuesta', 'planificada'].includes(r.status));
  drawRoutesOnMap(map, 'plan', visible);
  renderRoutesList(document.getElementById('routes-list'), visible, { actions: true });
  const proposals = visible.filter((r) => r.status === 'propuesta');
  document.getElementById('opt-summary').innerHTML = visible.length
    ? `<strong>${visible.length}</strong> rutas (${proposals.length} propuestas por aprobar) · <strong>${(visible.reduce((s, r) => s + r.distanceKm, 0)).toFixed(1)} km</strong> totales` +
      (proposals.length ? ` <button class="btn-link" onclick="approveAll()">Aprobar todas</button>` : '')
    : '';
}

function renderRoutesList(container, routes, { actions = false, progress = false } = {}) {
  container.innerHTML = routes.length
    ? routes
        .map((route, i) => {
          const vehicle = state.vehicles.find((v) => v.id === route.vehicleId);
          const done = route.stops.filter((s) => s.status === 'completada').length;
          const pct = Math.round((done / Math.max(1, route.stops.length)) * 100);
          return `
        <div class="route-item" style="--route-color:${route.isNodriza ? '#101a2b' : routeColor(i)}">
          <div class="route-title">
            <span>${esc(route.id)} ${route.isNodriza ? badge('nodriza', 'nodriza') : ''}</span>
            ${badge(route.status)}
          </div>
          <div class="route-meta">
            ${route.depotName ? `<span>🏭 ${esc(route.depotName)}</span>` : ''}
            ${route.schemaName ? `<span>🧩 ${esc(route.schemaName)}</span>` : ''}
            <span>🚛 ${esc(vehicle ? vehicle.plate + ' · ' + vehicle.name : route.vehicleId)}</span>
            <span>📍 ${route.stops.length} paradas</span>
            <span>📏 ${route.distanceKm} km</span>
            <span>⏱️ ${Math.round(route.durationMin)} min</span>
            <span>⚖️ ${route.loadKg} kg (${route.utilizationPct}% uso)</span>
            ${route.pickupKg ? `<span>📥 ${route.pickupKg} kg recolección</span>` : ''}
            ${route.fedByNodriza ? `<span>🔄 abastecida por nodriza</span>` : ''}
            ${route.trailerId ? `<span>🚛🔗 remolque ${esc(route.trailerCode)} (+${route.trailerCapacityM3} m³) · se ${route.trailerPickupAtEnd ? 'retira al final' : 'deja'} en ${esc(route.trailerYard ? route.trailerYard.name : 'acopio')}</span>` : ''}
          </div>
          ${progress ? `<div class="route-progress"><div style="width:${pct}%"></div></div><div class="muted" style="margin-top:4px">${done}/${route.stops.length} paradas completadas</div>` : ''}
          ${actions && route.status === 'propuesta'
            ? `<div class="route-actions">
                <button class="btn btn-primary btn-sm" onclick="approveRoute('${route.id}')">✔ Aprobar ruta</button>
                <button class="btn btn-secondary btn-sm" onclick="deleteRoute('${route.id}')">Rechazar</button>
              </div>`
            : ''}
          ${actions && route.status === 'planificada'
            ? `<div class="route-actions">
                ${route.loadStatus === 'cargada'
                  ? `<button class="btn btn-primary btn-sm" onclick="startRoute('${route.id}')">▶ Despachar</button>
                     <a class="btn btn-secondary btn-sm" href="/print/route/${route.id}" target="_blank" style="text-decoration:none">🖨 Documentos</a>`
                  : `<a class="btn btn-primary btn-sm" href="#/carga" style="text-decoration:none">📦 Ir a carga (${route.loadStatus === 'en_carga' ? 'en curso' : 'pendiente'})</a>`}
                <button class="btn btn-secondary btn-sm" onclick="deleteRoute('${route.id}')">Eliminar</button>
              </div>`
            : ''}
        </div>`;
        })
        .join('')
    : '<p class="muted">No hay rutas en esta categoría.</p>';
}

document.getElementById('btn-optimize').addEventListener('click', async () => {
  const vehicleIds = [...document.querySelectorAll('.opt-veh:checked')].map((c) => c.value);
  const btn = document.getElementById('btn-optimize');
  btn.disabled = true;
  btn.textContent = 'Optimizando…';
  try {
    const result = await api('/optimize', {
      method: 'POST',
      body: {
        vehicleIds,
        options: {
          startTime: document.getElementById('opt-start').value,
          returnToDepot: document.getElementById('opt-return').checked,
          useNodriza: document.getElementById('opt-nodriza').checked,
          useTrailers: document.getElementById('opt-trailers').checked,
          trailerPickup: document.getElementById('opt-trailer-pickup').value,
          schemaId: document.getElementById('opt-schema').value || undefined,
          depotId: document.getElementById('opt-depot').value || undefined,
        },
      },
    });
    toast(`Se generaron ${result.summary.totalRoutes} rutas (${result.summary.totalDistanceKm} km)`);
    if (result.unassigned.length) toast(`${result.unassigned.length} pedidos no pudieron asignarse por capacidad`, true);
    render();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚙️ Optimizar rutas';
  }
});

window.approveRoute = async (id) => {
  try {
    await api(`/routes/${id}/approve`, { method: 'POST' });
    toast('Ruta aprobada. La lista de carga está lista en la sección Carga.');
    render();
  } catch (err) {
    toast(err.message, true);
  }
};

window.approveAll = async () => {
  const proposals = state.routes.filter((r) => r.status === 'propuesta');
  for (const r of proposals) {
    try {
      await api(`/routes/${r.id}/approve`, { method: 'POST' });
    } catch (err) {
      toast(`${r.id}: ${err.message}`, true);
    }
  }
  toast(`${proposals.length} rutas aprobadas`);
  render();
};

window.startRoute = async (id) => {
  try {
    await api(`/routes/${id}/start`, { method: 'POST' });
    toast('Ruta despachada. Revisa Monitoreo para el seguimiento.');
    render();
  } catch (err) {
    toast(err.message, true);
  }
};

window.deleteRoute = async (id) => {
  if (!confirm('¿Eliminar esta ruta? Los pedidos volverán a estado pendiente.')) return;
  await api('/routes/' + id, { method: 'DELETE' });
  render();
};

// ============================================================ CARGA
let selectedLoadRoute = null;

function renderLoading() {
  const loadable = state.routes.filter(
    (r) => r.status === 'planificada' && r.loadingPlan
  );
  const container = document.getElementById('load-routes');
  container.innerHTML = loadable.length
    ? loadable
        .map((r, i) => {
          const vehicle = state.vehicles.find((v) => v.id === r.vehicleId);
          const loaded = r.loadingPlan.filter((b) => b.loaded).length;
          return `
        <div class="route-item" style="--route-color:${routeColor(i)}; cursor:pointer" onclick="selectLoadRoute('${r.id}')">
          <div class="route-title"><span>${esc(r.id)}</span>${badge(r.loadStatus || 'pendiente', r.loadStatus === 'cargada' ? 'entregado' : 'asignado')}</div>
          <div class="route-meta">
            <span>🚛 ${esc(vehicle ? vehicle.plate : '')}</span>
            <span>📦 ${loaded}/${r.loadingPlan.length} bultos</span>
            <span>📍 ${r.stops.length} paradas</span>
          </div>
          <div class="route-progress"><div style="width:${(loaded / Math.max(1, r.loadingPlan.length)) * 100}%"></div></div>
        </div>`;
        })
        .join('')
    : '<p class="muted">No hay rutas aprobadas. Aprueba rutas en Planificación.</p>';

  if (selectedLoadRoute && loadable.some((r) => r.id === selectedLoadRoute)) {
    renderLoadDetail(selectedLoadRoute);
  } else if (loadable.length === 1) {
    selectLoadRoute(loadable[0].id);
  }
}

window.selectLoadRoute = (routeId) => {
  selectedLoadRoute = routeId;
  renderLoadDetail(routeId);
};

async function renderLoadDetail(routeId) {
  let data;
  try {
    data = await api(`/routes/${routeId}/loading`);
  } catch (err) {
    return toast(err.message, true);
  }
  const { plan, summary, loadStatus } = data;
  const route = state.routes.find((r) => r.id === routeId);
  const vehicle = state.vehicles.find((v) => v.id === route.vehicleId);
  const PHASES = {
    0: { title: `Fase 0 · Remolque ${esc(route.trailerCode || '')} — carga volumétrica`, hint: `Va en el remolque y se entrega antes de soltarlo en ${esc(route.trailerYard ? route.trailerYard.name : 'el acopio')}.` },
    1: { title: 'Fase 1 · Volumétrica pesada — delantera central', hint: 'Sacos y pesados primero, al piso delantero-central por estabilidad.' },
    2: { title: 'Fase 2 · Tubos y largos — parrilla / superior', hint: vehicle && !vehicle.hasParrilla ? '⚠️ Este vehículo NO tiene parrilla: reubicar o cambiar de vehículo.' : 'Asegurar con eslingas.' },
    3: { title: 'Fase 3 · Paquetería — cajón en orden inverso de entrega', hint: 'Lo del último cliente al fondo; lo del primero junto a la puerta.' },
  };

  const groups = [0, 1, 2, 3]
    .map((phase) => {
      const items = plan.filter((b) => b.phase === phase);
      if (!items.length) return '';
      const rows = items
        .map(
          (b) => `
        <tr class="${b.loaded ? 'row-loaded' : ''}">
          <td>${b.seq}</td>
          <td><code>${esc(b.barcode)}</code></td>
          <td class="wrap">${esc(b.description)}<br><span class="muted">Parada ${b.stopSeq} · ${esc(b.customer)}</span></td>
          <td>${b.weightKg} kg</td>
          <td>${b.loaded
            ? `<span class="badge entregado">✔ ${b.loadMethod === 'scan' ? 'escaneado' : 'manual'}</span>`
            : `<button class="btn btn-secondary btn-sm" onclick="confirmBulto('${routeId}', ${b.seq})">Confirmar</button>`}</td>
        </tr>`
        )
        .join('');
      return `
      <h4 class="load-phase">${PHASES[phase].title}</h4>
      <p class="muted" style="margin:2px 0 8px">${PHASES[phase].hint}</p>
      <table class="table load-table"><thead><tr><th>#</th><th>Código</th><th>Bulto</th><th>Peso</th><th>Carga</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');

  document.getElementById('load-detail').innerHTML = `
    <div class="load-head">
      <div>
        <h3 style="margin-bottom:2px">${esc(routeId)} · ${esc(vehicle ? vehicle.plate + ' — ' + vehicle.name : '')}</h3>
        <span class="muted">${summary.loaded}/${summary.total} bultos · ${summary.weightKg} kg · ${summary.volumeM3} m³</span>
      </div>
      ${badge(loadStatus, loadStatus === 'cargada' ? 'entregado' : 'asignado')}
    </div>
    ${loadStatus !== 'cargada' ? `
    <div class="scan-box">
      <span class="scan-icon">📷</span>
      <input class="input" id="scan-input" placeholder="Escanea el código de barras del bulto (o escríbelo y Enter)…" autocomplete="off" />
    </div>
    <p class="muted" style="margin:6px 0 12px">El lector Bluetooth teclea el código y envía Enter automáticamente: deja el cursor en el campo y escanea.</p>` : `
    <div class="load-done">
      ✅ Carga completa. Documentos generados (guías y facturas).
      <div class="route-actions" style="margin-top:10px">
        <a class="btn btn-primary btn-sm" href="/print/route/${routeId}" target="_blank" style="text-decoration:none">🖨 Formatos de impresión</a>
        <button class="btn btn-secondary btn-sm" onclick="viewDocuments('${routeId}')">Ver payload facturación</button>
        <button class="btn btn-primary btn-sm" onclick="startRoute('${routeId}')">▶ Despachar ruta</button>
      </div>
    </div>`}
    <div class="route-progress" style="margin:10px 0"><div style="width:${(summary.loaded / Math.max(1, summary.total)) * 100}%"></div></div>
    ${groups}`;

  const scan = document.getElementById('scan-input');
  if (scan) {
    scan.focus();
    scan.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const code = scan.value.trim();
      scan.value = '';
      if (!code) return;
      await sendLoad(routeId, { barcode: code });
    });
  }
}

async function sendLoad(routeId, body) {
  try {
    const result = await api(`/routes/${routeId}/load`, { method: 'POST', body });
    if (result.documentsGenerated) {
      toast('✅ Carga completa: guías y facturas generadas y enviadas al webservice');
    } else {
      toast(`Bulto ${result.bulto.barcode} cargado (${result.summary.loaded}/${result.summary.total})`);
    }
    await refreshData();
    renderLoadDetail(routeId);
    renderLoading();
  } catch (err) {
    toast(err.message, true);
    const scan = document.getElementById('scan-input');
    if (scan) scan.focus();
  }
}

window.confirmBulto = (routeId, seq) => sendLoad(routeId, { seq });

window.viewDocuments = async (routeId) => {
  try {
    const docs = await api(`/routes/${routeId}/documents`);
    openModal(`Payload facturación · ${routeId}`, `
      <p class="muted">Este JSON se envía al webservice de facturación electrónica configurado (Empresas → Facturación).</p>
      <pre style="background:#101a2b;color:#d5e0f2;padding:12px;border-radius:8px;max-height:50vh;overflow:auto;font-size:11.5px">${esc(JSON.stringify(docs, null, 2))}</pre>
      <div class="actions"><button class="btn btn-secondary" onclick="closeModal()">Cerrar</button></div>`);
  } catch (err) {
    toast(err.message, true);
  }
};

// ============================================================ MONITOREO
function renderMonitoring() {
  const map = ensureMap('live', 'map-live');
  if (map) setTimeout(() => map.invalidateSize(), 50);
  depotMarker(map);
  const active = state.routes.filter((r) => r.status === 'en_curso');
  const planned = state.routes.filter((r) => r.status === 'planificada');
  drawRoutesOnMap(map, 'live', active, { showPending: false });
  renderRoutesList(document.getElementById('live-routes'), active, { progress: true });
  renderRoutesList(document.getElementById('planned-routes'), planned, { actions: true });
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (state.view !== 'monitoreo') return stopPolling();
    try {
      const positions = await api('/tracking');
      const map = state.maps.live;
      if (!map) return;
      const seen = new Set();
      for (const p of positions) {
        seen.add(p.routeId);
        let marker = state.layers.vehicles[p.routeId];
        const html = `<div class="veh-marker">${p.isNodriza ? '🚛' : '🚐'}</div>`;
        if (!marker) {
          marker = L.marker([p.lat, p.lng], {
            icon: L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13] }),
            zIndexOffset: 900,
          }).addTo(map);
          state.layers.vehicles[p.routeId] = marker;
        }
        marker.setLatLng([p.lat, p.lng]);
        marker.bindPopup(
          `<strong>${esc(p.plate)} · ${esc(p.vehicleName)}</strong><br>` +
            `Conductor: ${esc(p.driverName || '—')}<br>` +
            `Avance: ${p.completedStops}/${p.totalStops} paradas<br>` +
            (p.nextStop ? `Próxima parada #${p.nextStop.seq} · ETA ${p.nextStop.eta}` : 'Regresando')
        );
      }
      // limpia marcadores de rutas terminadas
      for (const key of Object.keys(state.layers.vehicles)) {
        if (!seen.has(key)) {
          state.layers.vehicles[key].remove();
          delete state.layers.vehicles[key];
        }
      }
      // refresca listas y trazado (estados de paradas cambian)
      await refreshData();
      const active = state.routes.filter((r) => r.status === 'en_curso');
      drawRoutesOnMap(map, 'live', active, { showPending: false });
      renderRoutesList(document.getElementById('live-routes'), active, { progress: true });
      renderRoutesList(
        document.getElementById('planned-routes'),
        state.routes.filter((r) => r.status === 'planificada'),
        { actions: true }
      );
    } catch {
      /* silencioso: reintenta en el próximo tick */
    }
  }, 2000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

// ============================================================ EMPRESAS
const COMPANY_TYPE_LABEL = { erp: 'ERP / Facturación', ecommerce: 'E-commerce', portal: 'Portal público' };

async function renderCompanies() {
  const logs = await api('/integration-logs');
  document.querySelector('#companies-table tbody').innerHTML = state.companies
    .map((c) => {
      const orderCount = state.orders.filter((o) => o.companyId === c.id).length;
      return `
      <tr>
        <td>${esc(c.id)}</td>
        <td><strong>${esc(c.name)}</strong><br><span class="muted">${esc(c.contactEmail || '')}</span></td>
        <td>${badge(COMPANY_TYPE_LABEL[c.type] || c.type, c.type === 'ecommerce' ? 'entrega' : 'planificada')}</td>
        <td>${orderCount}</td>
        <td>
          <code id="key-${c.id}">••••••••</code>
          <button class="btn-link" onclick="toggleKey('${c.id}')">Ver</button>
          <button class="btn-link" onclick="copyKey('${c.id}')">Copiar</button>
          <button class="btn-link" onclick="regenKey('${c.id}')">Regenerar</button>
        </td>
        <td class="wrap">${c.webhookUrl ? esc(c.webhookUrl) : '—'}</td>
        <td>${badge(c.active !== false ? 'disponible' : 'no_entregado')}</td>
        <td>
          <button class="btn-link" onclick="editCompany('${c.id}')">Editar</button>
          <button class="btn-link danger" onclick="deleteCompany('${c.id}')">Eliminar</button>
        </td>
      </tr>`;
    })
    .join('');

  document.querySelector('#intlogs-table tbody').innerHTML = logs.length
    ? logs
        .slice(0, 30)
        .map(
          (l) => `
      <tr>
        <td>${new Date(l.at).toLocaleString('es-CL')}</td>
        <td>${esc(companyName(l.companyId))}</td>
        <td><code>${esc(l.method)}</code></td>
        <td class="wrap">${esc(l.path)}</td>
        <td>${badge(String(l.status), l.status < 400 ? 'entregado' : 'no_entregado')}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted">Aún no hay llamadas al API de integración.</td></tr>';
}

window.toggleKey = (id) => {
  const el = document.getElementById('key-' + id);
  const c = state.companies.find((x) => x.id === id);
  el.textContent = el.textContent === '••••••••' ? c.apiKey : '••••••••';
};

window.copyKey = async (id) => {
  const c = state.companies.find((x) => x.id === id);
  try {
    await navigator.clipboard.writeText(c.apiKey);
    toast('API key copiada al portapapeles');
  } catch {
    toast('No se pudo copiar; usa "Ver" y cópiala manualmente', true);
  }
};

window.regenKey = async (id) => {
  if (!confirm('¿Regenerar la API key? La clave actual dejará de funcionar de inmediato.')) return;
  await api(`/companies/${id}/regenerate-key`, { method: 'PUT' });
  toast('API key regenerada');
  render();
};

function companyForm(c = {}) {
  return `
    <div class="form-grid">
      <label class="field full"><span>Nombre</span><input class="input" id="c-name" value="${esc(c.name || '')}"/></label>
      <label class="field"><span>Tipo</span>
        <select class="input" id="c-type" style="width:100%">
          <option value="erp" ${c.type === 'erp' ? 'selected' : ''}>ERP / Facturación electrónica</option>
          <option value="ecommerce" ${c.type === 'ecommerce' ? 'selected' : ''}>E-commerce</option>
          <option value="portal" ${c.type === 'portal' ? 'selected' : ''}>Portal público</option>
        </select>
      </label>
      <label class="field"><span>Email de contacto</span><input class="input" id="c-email" value="${esc(c.contactEmail || '')}"/></label>
      <label class="field full"><span>Webhook URL (notificaciones a su sistema)</span><input class="input" id="c-webhook" value="${esc(c.webhookUrl || '')}" placeholder="https://erp.empresa.cl/webhooks/macotrans"/></label>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" id="c-save">Guardar</button>
    </div>`;
}

function readCompanyForm() {
  return {
    name: document.getElementById('c-name').value.trim(),
    type: document.getElementById('c-type').value,
    contactEmail: document.getElementById('c-email').value.trim(),
    webhookUrl: document.getElementById('c-webhook').value.trim(),
  };
}

document.getElementById('btn-new-company').addEventListener('click', () => {
  openModal('Nueva empresa cliente', companyForm());
  document.getElementById('c-save').onclick = async () => {
    try {
      const created = await api('/companies', { method: 'POST', body: readCompanyForm() });
      closeModal();
      toast(`Empresa creada. API key: ${created.apiKey.slice(0, 12)}…`);
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
});

window.editCompany = (id) => {
  const c = state.companies.find((x) => x.id === id);
  openModal('Editar empresa ' + c.name, companyForm(c));
  document.getElementById('c-save').onclick = async () => {
    try {
      await api('/companies/' + id, { method: 'PUT', body: readCompanyForm() });
      closeModal();
      toast('Empresa actualizada');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
};

window.deleteCompany = async (id) => {
  if (!confirm('¿Eliminar esta empresa? Su API key dejará de funcionar.')) return;
  try {
    await api('/companies/' + id, { method: 'DELETE' });
    toast('Empresa eliminada');
    render();
  } catch (err) {
    toast(err.message, true);
  }
};

// ============================================================ WEBHOOKS
async function renderWebhooks() {
  const hooks = await api('/webhooks');
  document.querySelector('#webhooks-table tbody').innerHTML = hooks.length
    ? hooks
        .map(
          (w) => `
      <tr>
        <td>${esc(w.id)}</td>
        <td class="wrap">${esc(w.url)}</td>
        <td>${w.events.map((e) => `<code>${esc(e)}</code>`).join(', ')}</td>
        <td>${w.lastDeliveryAt ? new Date(w.lastDeliveryAt).toLocaleString('es-CL') : '—'}</td>
        <td><button class="btn-link danger" onclick="deleteWebhook('${w.id}')">Eliminar</button></td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No hay webhooks suscritos.</td></tr>';
}

document.getElementById('btn-add-webhook').addEventListener('click', async () => {
  const url = document.getElementById('wh-url').value.trim();
  const events = document.getElementById('wh-events').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!url) return toast('Ingresa una URL', true);
  try {
    await api('/webhooks', { method: 'POST', body: { url, events: events.length ? events : ['*'] } });
    document.getElementById('wh-url').value = '';
    document.getElementById('wh-events').value = '';
    toast('Webhook suscrito');
    renderWebhooks();
  } catch (err) {
    toast(err.message, true);
  }
});

window.deleteWebhook = async (id) => {
  await api('/webhooks/' + id, { method: 'DELETE' });
  renderWebhooks();
};

// ============================================================ reset demo
document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!confirm('Esto recarga la configuración real (flota, tripulación, direcciones, esquemas) y borra pedidos y rutas actuales. ¿Continuar?')) return;
  await api('/reset', { method: 'POST' });
  state.deposits = [];
  toast('Configuración recargada');
  render();
});

// ============================================================ arranque
(async function boot() {
  const view = (location.hash || '#/panel').replace('#/', '') || 'panel';
  await refreshData();
  setView(view);
})();
