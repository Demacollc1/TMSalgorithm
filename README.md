# Macotrans TMS 🚚

Plataforma logística de **Macotrans**: TMS de última milla con planificación
consolidada de rutas **multi-empresa**, portal público de contratación de
fletes (responsive, mobile-first) y **API de integración** para ERPs,
sistemas de facturación electrónica y e-commerce. Incluye el algoritmo del
repositorio: **rutas con madre nodriza y recolecciones**.

## Ejecución

Sin dependencias externas — solo Node.js ≥ 18:

```bash
npm start          # o: node server.js  (PORT=4000 npm start para otro puerto)
```

| URL | Qué es |
|---|---|
| <http://localhost:3000/> | **Portal TMS** (operaciones): panel, pedidos, flota, planificación, monitoreo, empresas |
| <http://localhost:3000/portal> | **Portal público** de contratación de fletes y seguimiento (mobile-first) |
| <http://localhost:3000/docs> | Documentación de las tres APIs |

```bash
npm test           # pruebas del optimizador y del cotizador
```

Al primer arranque se cargan datos de demostración (Santiago de Chile):
3 empresas cliente con API key, 18 pedidos repartidos entre ellas,
4 vehículos (uno madre nodriza) y 4 conductores. El botón **“Reiniciar
demo”** del TMS restaura todo.

## Arquitectura

```
                                  ┌──────────────────────────────┐
  Cliente final (web móvil)  ───► │  /portal  +  /api/public/v1  │──┐
                                  └──────────────────────────────┘  │
                                  ┌──────────────────────────────┐  │   ┌───────────────────┐
  ERP / Facturación electrónica ► │   /api/integration/v1        │──┼──►│  Pool consolidado │
  E-commerce (delegan logística)  │   (middleware, X-API-Key,    │  │   │  de pedidos       │
                                  │    scope por empresa,        │──┘   │        │          │
                                  │    webhooks salientes)       │      │  Optimización VRP │
                                  └──────────────────────────────┘      │  (nodriza + reco- │
                                  ┌──────────────────────────────┐      │   lecciones)      │
  Operaciones Macotrans  ───────► │   TMS  /  +  /api/v1         │─────►│  Rutas, GPS, POD  │
                                  └──────────────────────────────┘      └───────────────────┘
```

- **Portal público** (`public/portal.html`): cotización instantánea
  (motor de tarifas en `src/pricing.js`), contratación con código de
  seguimiento `MAC-XXXXXX` y seguimiento con línea de tiempo. Mobile-first.
- **API de integración** (`/api/integration/v1`): autenticación por
  `X-API-Key` por empresa, alcance limitado a sus pedidos, `externalRef`
  para conciliar con factura/orden del sistema externo, webhook saliente
  por empresa (`PUT /webhook`) en cada cambio de estado — pensado para
  gatillar facturación electrónica al confirmar la entrega. Toda llamada
  queda auditada (vista *Empresas* del TMS).
- **TMS multi-empresa**: los pedidos de todas las empresas y del portal
  entran a un único pool y se planifican en rutas consolidadas; cada
  pedido conserva su empresa de origen y su fuente (`portal`, `api-erp`,
  `api-ecommerce`, `tms`).

## Funcionalidades del TMS

| Módulo | Descripción |
|---|---|
| **Panel** | KPIs del día: cumplimiento, pedidos por estado, km planificados, pedidos por comuna y feed de actividad. |
| **Pedidos** | CRUD de entregas y recolecciones con empresa de origen, código de seguimiento, ventana horaria, peso/volumen y POD. |
| **Flota** | CRUD de vehículos (capacidad kg/m³, marca de nodriza) y conductores. |
| **Planificación** | Motor VRP: barrido angular + vecino más cercano + 2-opt, con validación de capacidad. Modo clásico o **madre nodriza**. Consolida pedidos de todas las empresas. |
| **Monitoreo** | Seguimiento GPS simulado: posición, avance de paradas, ETAs y cierre automático con POD. |
| **Empresas** | Tenants (ERP / e-commerce / portal) con API keys (ver, copiar, regenerar), webhook por empresa y auditoría del API de integración. |
| **Integraciones** | Webhooks globales por evento y API REST completa. |

## El algoritmo (src/optimizer.js)

1. **Asignación** — barrido angular (*sweep*) alrededor del depósito,
   llenando cada vehículo hasta su capacidad en kg y m³; lo que no cabe se
   reporta como no asignado.
2. **Secuenciación** — vecino más cercano para construir cada ruta y
   **2-opt** para eliminar cruces y reducir distancia.
3. **Recolecciones** — la carga inicial es la suma de las entregas; a lo
   largo de la ruta cada entrega descarga y cada recolección carga. Si una
   recolección excede la capacidad disponible, se **pospone** hasta que las
   entregas liberen espacio (reparación de factibilidad).
4. **Madre nodriza** — los pedidos se agrupan con *k-means* (un cluster por
   vehículo satélite); el centroide de cada cluster es un **punto de
   transbordo**. La nodriza recorre los puntos de transbordo desde el
   depósito y cada satélite reparte su zona partiendo del transbordo.
5. **ETAs** — velocidad media urbana de 30 km/h + 6 min de atención por
   parada; las ventanas horarias actúan como criterio de ordenamiento blando.

## APIs (resumen)

```
API PÚBLICA (portal, sin autenticación)
POST  /api/public/v1/quote                cotización instantánea
POST  /api/public/v1/freights             contrata y devuelve trackingCode
GET   /api/public/v1/tracking/{code}      seguimiento público

API DE INTEGRACIÓN (X-API-Key por empresa)
GET   /api/integration/v1/me              identifica la cuenta
POST  /api/integration/v1/quote           cotización
POST  /api/integration/v1/orders          crea pedidos (objeto o lote)
GET   /api/integration/v1/orders[/{id}]   lista/consulta (acepta externalRef)
DELETE /api/integration/v1/orders/{id}    anula (solo pendientes)
GET   /api/integration/v1/tracking/{code} seguimiento
PUT   /api/integration/v1/webhook         URL de notificaciones de la empresa

API INTERNA DEL TMS (/api/v1)
orders, vehicles, drivers, companies (+ regenerate-key), optimize,
routes (+ start), tracking, kpis, events, webhooks, integration-logs, reset
```

Documentación completa con ejemplos en `/docs`.

## Estructura

```
server.js            Servidor HTTP: 3 APIs + estáticos, sin dependencias
src/optimizer.js     Motor VRP: sweep, NN, 2-opt, recolecciones, nodriza
src/pricing.js       Motor de cotización de fletes (CLP)
src/simulator.js     Simulador GPS (mueve la flota, cierra paradas, emite POD)
src/store.js         Almacén en memoria con persistencia JSON, tenants y seed
src/webhooks.js      Webhooks globales + webhook por empresa cliente
src/geo.js           Haversine, interpolación, rumbo, centroides
public/index.html    TMS (SPA de operaciones)
public/portal.html   Portal público mobile-first (cotizar/contratar/seguir)
public/docs.html     Documentación de las APIs
test/run-tests.js    Pruebas del algoritmo y del cotizador
data/db.json         Base de datos JSON (se genera al arrancar; ignorada en git)
```

> Plataforma de demostración construida sobre la réplica educativa de TMS
> de este repositorio. La marca "Macotrans" pertenece a su titular.
