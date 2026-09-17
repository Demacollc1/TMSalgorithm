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
| <http://localhost:3000/conductor> | **App del conductor** (móvil): ruta GPS, escáner de entrega, novedades |
| <http://localhost:3000/docs> | Documentación de las APIs y del módulo de carga |

```bash
npm test           # pruebas del optimizador y del cotizador
```

Al primer arranque se carga la **configuración real de la organización**
desde `config/demaco-drivin.json` (export de driv.in): 21 vehículos con
sus placas, capacidades (UN/kg/m³) y características (URBANO, FURGON,
VIAJE…), 29 tripulantes (conductores y peonetas), 6 bodegas, 6 flotas,
12 esquemas de ruteo y 1000 direcciones del maestro de clientes. Los
pedidos empiezan vacíos: se importan con `POST /api/v1/import` (formato
Driv.in) o llegan por el portal y el API de integración. El botón
**“Recargar datos”** vuelve a leer la configuración y limpia pedidos y
rutas. Precios en USD.

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

## Módulo de carga del camión

Flujo completo desde el plan del ERP hasta la entrega confirmada:

1. **Importar plan** — `POST /api/v1/import` acepta el mismo JSON que se
   envía a Driv.in (`{ clients: [...] }`; ejemplo en
   `samples/plan-demaco.json`). Cada *order* del plan es un **bulto** con
   su código de barras (`alt_code`); `units_2` = kg, `units_3` = cm³.
2. **Rutas propuestas → aprobadas** — el optimizador propone rutas solo
   con vehículos **aptos para viajar** (campo `apto`); el usuario las
   aprueba en Planificación (mapa con rutas por vehículo).
3. **Lista de carga física** — al aprobar se genera la secuencia:
   volumétrica pesada (sacos/empastes) a la **delantera central**, tubos
   a la **parrilla**, paquetería al cajón en **orden inverso de entrega**
   (LIFO). Confirmación por **escáner de código de barras** (lector
   Bluetooth HID) o por botón.
4. **Facturación electrónica** — con la carga completa se generan la
   guía de remisión y la factura por parada (clave de acceso 49 dígitos,
   módulo 11), se envía el payload al webservice configurado
   (`PUT /api/v1/billing-config`) y quedan los formatos imprimibles en
   `/print/route/{id}`.
4b. **Remolques plegables y puntos de acopio** — para tanques y tubería
   (mucho volumen, poco peso), el planificador acopla un remolque a un
   camión con **bola** cuando falta capacidad volumétrica, y programa la
   parada *"Dejar remolque"* en el **punto de acopio** más cercano en
   cuanto la carga restante cabe en el camión solo (el remolque
   dificulta la maniobra). Se retira al final de la ruta o queda
   **estacionado** para retirarlo otro día u otra ruta. Los vehículos
   registran bola de remolque y montacargas/ascensor de cola; la carga
   del remolque es la **Fase 0** de la lista de carga.
5. **App del conductor** (`/conductor`, móvil) — sigue la ruta por GPS;
   al llegar, la parada queda *en sitio* hasta que el conductor confirma
   cada bulto con el mismo escáner, con **entregas parciales,
   devoluciones y rechazos** con motivo y receptor.

## Inteligencia operativa (AI-ready)

El sistema deja ganchos para que un agente LLM participe activamente. Cada
caso, consulta al chofer, notificación e informe se registra y se reenvía
al webservice de IA configurable (`PUT /api/v1/ai-config`).

- **Monitoreo activo de desvíos**: si el vehículo se aleja de la ruta
  planificada, la IA le pregunta al chofer el motivo (opciones + texto),
  registra la respuesta y al cerrar la ruta arma un **informe** con
  paradas, resultados, consultas, casos, delegaciones y gastos para
  analizar si lo reportado es coherente y alimentar el algoritmo.
- **Discrepancia de geolocalización**: si la entrega se confirma lejos de
  la dirección registrada, se crea un **caso** para corregir la
  geolocalización (un clic actualiza pedido y maestro de direcciones) o
  gestionar con vendedor/cliente.
- **Avisos al cliente en tiempo real**: "tu entrega es la **siguiente**"
  con ETA; aviso de **retraso** respecto de la hora informada; y
  solicitud de **feedback** cuando la demora es alta o el local está
  cerrado (calificación con estrellas en el portal).
- **Telemetría multi-fuente**: además del GPS del celular, los GPS
  físicos del vehículo y la dashcam transmiten a `POST /api/v1/telemetry`
  con token de dispositivo. Si el celular pierde señal (inseguridad,
  apagado), el sistema sigue por el respaldo y abre un caso; el botón de
  pánico de cualquier fuente dispara un caso de emergencia.
- **Pantalla de cabina** (`/cabina?v=PLACA`): asistente fijo del vehículo
  con próxima parada + ETA, estado de las tres señales GPS, respuesta a
  las consultas de la IA con un toque y **botón SOS** con protocolo de
  emergencia.

## Delegación de paquetes entre rutas

Un chofer (o el planificador) puede **delegar** un paquete de su ruta a
otra ruta planificada; el otro transportista **acepta o rechaza**. Al
aceptar, la parada queda *delegada* en la ruta origen y el paquete pasa a
la lista de carga destino para re-escanearse. (`POST /routes/:id/delegate`,
`POST /delegations/:id/accept|reject`).

## Gastos de ruta

Los choferes registran gastos desde la app (combustible, peaje, parqueo,
viáticos, reparación…) **vinculados a la ruta y opcionalmente a la parada**
y con georreferencia; se consolidan en el informe de ruta.
(`POST /routes/:id/expenses`).

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
src/loading.js       Módulo de carga: clasificación de bultos y secuencia física
src/importer.js      Importador de planes (formato Driv.in del ERP)
src/billing.js       Guías y facturas electrónicas (clave de acceso módulo 11)
src/printview.js     Formatos de impresión de ruta (guía + factura)
src/pricing.js       Motor de cotización de fletes (USD, por peso/vol o por ítems)
src/packages.js      Catálogo de tipos de paquete y peso facturable
src/simulator.js     Simulador GPS (mueve la flota, cierra paradas, emite POD)
src/store.js         Almacén en memoria con persistencia JSON, tenants y seed
src/webhooks.js      Webhooks globales + webhook por empresa cliente
src/geo.js           Haversine, interpolación, rumbo, centroides
public/index.html    TMS (SPA de operaciones, incluye vista Carga)
public/portal.html   Portal público mobile-first (cotizar/contratar/seguir)
public/conductor.html App del conductor (ruta GPS, escáner, gastos, delegación)
public/cabina.html    Asistente de cabina (pantalla fija del vehículo, SOS)
src/ai.js            IA operativa: desvíos, casos, notificaciones, telemetría, informe
samples/             Planes de ejemplo del ERP (formato Driv.in)
config/              Configuración real de la organización (export driv.in)
public/docs.html     Documentación de las APIs
test/run-tests.js    Pruebas del algoritmo y del cotizador
data/db.json         Base de datos JSON (se genera al arrancar; ignorada en git)
```

> Plataforma de demostración construida sobre la réplica educativa de TMS
> de este repositorio. La marca "Macotrans" pertenece a su titular.
