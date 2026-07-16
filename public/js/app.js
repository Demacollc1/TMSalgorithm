'use strict';

/* RutaFleet TMS — SPA. Vanilla JS + Leaflet. */

const API = '/api/v1';
const ROUTE_COLORS = ['#1f5eff', '#00b386', '#e5484d', '#f0a020', '#8b5cf6', '#0ea5e9', '#d946ef', '#84cc16'];

const state = {
  company: null,
  orders: [],
  vehicles: [],
  drivers: [],
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
  [state.orders, state.vehicles, state.drivers, state.routes] = await Promise.all([
    api('/orders'),
    api('/vehicles'),
    api('/drivers'),
    api('/routes'),
  ]);
  if (!state.company) state.company = await api('/company');
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
  if (view === 'planificacion') renderPlanning();
  if (view === 'monitoreo') renderMonitoring();
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

// ============================================================ PEDIDOS
function renderOrders() {
  const filter = document.getElementById('filter-status').value;
  const list = filter ? state.orders.filter((o) => o.status === filter) : state.orders;
  document.querySelector('#orders-table tbody').innerHTML = list
    .map(
      (o) => `
    <tr>
      <td><strong>${esc(o.code)}</strong></td>
      <td>${badge(o.type)}</td>
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

// ============================================================ FLOTA
function renderFleet() {
  document.querySelector('#vehicles-table tbody').innerHTML = state.vehicles
    .map((v) => {
      const driver = state.drivers.find((d) => d.id === v.driverId);
      return `
      <tr>
        <td><strong>${esc(v.plate)}</strong></td>
        <td>${esc(v.name)} ${v.isNodriza ? badge('nodriza', 'nodriza') : ''}</td>
        <td>${esc(v.type)}</td>
        <td>${v.capacityKg}</td>
        <td>${v.capacityM3}</td>
        <td>${esc(driver ? driver.name : '—')}</td>
        <td>${badge(v.status)}</td>
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
        <td><strong>${esc(d.name)}</strong></td>
        <td>${esc(d.phone)}</td>
        <td>${esc(d.license)}</td>
        <td>${badge(d.status)}</td>
        <td><button class="btn-link danger" onclick="deleteDriver('${d.id}')">Eliminar</button></td>
      </tr>`
    )
    .join('');
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
    <label class="field"><span>Teléfono</span><input class="input" id="d-phone" placeholder="+56 9 ..."/></label>
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

window.deleteDriver = async (id) => {
  if (!confirm('¿Eliminar este conductor?')) return;
  await api('/drivers/' + id, { method: 'DELETE' });
  render();
};

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
      const icon = L.divIcon({
        className: '',
        html: `<div class="stop-marker ${done ? 'done' : ''}" style="--stop-color:${route.isNodriza ? '#101a2b' : color}">${stop.transferPointId ? '⇄' : stop.seq}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const order = stop.orderId ? state.orders.find((o) => o.id === stop.orderId) : null;
      const popup = order
        ? `<strong>${esc(order.code)}</strong> · ${badge(order.type)}<br>${esc(order.customer)}<br>${esc(order.address)}<br>ETA ${stop.eta} · ${badge(order.status)}`
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
  const pending = state.orders.filter((o) => o.status === 'pendiente');
  document.getElementById('opt-orders-count').textContent =
    `${pending.length} pedidos pendientes serán considerados (${pending.filter((o) => o.type === 'recoleccion').length} recolecciones).`;

  document.getElementById('opt-vehicles').innerHTML = state.vehicles
    .map(
      (v) => `
      <label class="check">
        <input type="checkbox" class="opt-veh" value="${v.id}" ${v.status === 'disponible' ? 'checked' : 'disabled'} />
        <span>${esc(v.plate)} · ${esc(v.name)} (${v.capacityKg} kg)${v.isNodriza ? ' 🚛 nodriza' : ''}</span>
      </label>`
    )
    .join('');

  const map = ensureMap('plan', 'map-plan');
  if (map) setTimeout(() => map.invalidateSize(), 50);
  depotMarker(map);
  const planned = state.routes.filter((r) => r.status === 'planificada');
  drawRoutesOnMap(map, 'plan', planned);
  renderRoutesList(document.getElementById('routes-list'), planned, { actions: true });
  document.getElementById('opt-summary').innerHTML = planned.length
    ? `<strong>${planned.length}</strong> rutas planificadas · <strong>${(planned.reduce((s, r) => s + r.distanceKm, 0)).toFixed(1)} km</strong> totales`
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
            <span>🚛 ${esc(vehicle ? vehicle.plate + ' · ' + vehicle.name : route.vehicleId)}</span>
            <span>📍 ${route.stops.length} paradas</span>
            <span>📏 ${route.distanceKm} km</span>
            <span>⏱️ ${Math.round(route.durationMin)} min</span>
            <span>⚖️ ${route.loadKg} kg (${route.utilizationPct}% uso)</span>
            ${route.pickupKg ? `<span>📥 ${route.pickupKg} kg recolección</span>` : ''}
            ${route.fedByNodriza ? `<span>🔄 abastecida por nodriza</span>` : ''}
          </div>
          ${progress ? `<div class="route-progress"><div style="width:${pct}%"></div></div><div class="muted" style="margin-top:4px">${done}/${route.stops.length} paradas completadas</div>` : ''}
          ${actions && route.status === 'planificada'
            ? `<div class="route-actions">
                <button class="btn btn-primary btn-sm" onclick="startRoute('${route.id}')">▶ Despachar</button>
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
  if (!confirm('Esto restaura los datos de demostración y borra rutas y pedidos actuales. ¿Continuar?')) return;
  await api('/reset', { method: 'POST' });
  toast('Datos de demostración restaurados');
  render();
});

// ============================================================ arranque
(async function boot() {
  const view = (location.hash || '#/panel').replace('#/', '') || 'panel';
  await refreshData();
  setView(view);
})();
