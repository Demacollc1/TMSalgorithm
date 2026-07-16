# RutaFleet TMS 🚚

Réplica funcional (educativa) de un **TMS de última milla** al estilo Driv.in:
optimización de rutas, gestión de flota, monitoreo GPS en tiempo real, prueba
de entrega y API REST con webhooks. Incluye el algoritmo del repositorio:
**rutas con madre nodriza y recolecciones**.

> Proyecto de demostración, sin afiliación con Driv.in ni otro proveedor.
> Interfaz y contenidos propios; solo replica el *tipo* de funcionalidad.

## Ejecución

Sin dependencias externas — solo Node.js ≥ 18:

```bash
npm start          # o: node server.js
```

- Aplicación web: <http://localhost:3000/>
- Documentación de la API: <http://localhost:3000/docs>
- API REST: `http://localhost:3000/api/v1/`

Al primer arranque se cargan datos de demostración (Santiago de Chile):
18 pedidos (14 entregas + 4 recolecciones), 4 vehículos (uno de ellos
madre nodriza) y 4 conductores. El botón **“Reiniciar demo”** restaura todo.

```bash
npm test           # pruebas del motor de optimización
```

## Funcionalidades

| Módulo | Descripción |
|---|---|
| **Panel** | KPIs del día: cumplimiento, pedidos por estado, km planificados, pedidos por comuna y feed de actividad. |
| **Pedidos** | CRUD de entregas y recolecciones con ventana horaria, peso/volumen y georreferencia. Importación masiva por API. |
| **Flota** | CRUD de vehículos (capacidad kg/m³, tipo, marca de nodriza) y conductores. |
| **Planificación** | Motor VRP: barrido angular + vecino más cercano + mejora 2-opt, con validación de capacidad. Modo clásico o **madre nodriza** (transbordo a vehículos satélite). Visualización de rutas en mapa. |
| **Monitoreo** | Seguimiento GPS simulado de la flota: posición, avance de paradas, ETAs y cierre automático con POD. |
| **Prueba de entrega** | POD con receptor, método, notas y georreferencia; consultable desde la tabla de pedidos y por API. |
| **Integraciones** | Webhooks HTTP por evento (`order.status_changed`, `route.completed`, …) y API REST completa. |

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

## API (resumen)

```
GET/POST/PUT/DELETE  /api/v1/orders          pedidos (entrega | recoleccion)
POST                 /api/v1/orders/:id/pod  prueba de entrega manual
GET/POST/PUT/DELETE  /api/v1/vehicles        flota (isNodriza para transbordo)
GET/POST/PUT/DELETE  /api/v1/drivers         conductores
POST                 /api/v1/optimize        genera rutas (options.useNodriza)
GET/DELETE           /api/v1/routes          rutas planificadas/en curso
POST                 /api/v1/routes/:id/start  despacho + inicio de GPS
GET                  /api/v1/tracking        posiciones en tiempo real
GET                  /api/v1/kpis            indicadores operativos
GET                  /api/v1/events          feed de actividad
GET/POST/DELETE      /api/v1/webhooks        suscripciones de eventos
POST                 /api/v1/reset           restaura datos de demo
```

Documentación completa con ejemplos en `/docs`.

## Estructura

```
server.js            Servidor HTTP (API REST + estáticos), sin dependencias
src/optimizer.js     Motor VRP: sweep, NN, 2-opt, recolecciones, nodriza
src/simulator.js     Simulador GPS (mueve la flota, cierra paradas, emite POD)
src/store.js         Almacén en memoria con persistencia JSON y datos seed
src/webhooks.js      Despacho de webhooks
src/geo.js           Haversine, interpolación, rumbo, centroides
public/              SPA (vanilla JS + Leaflet/OpenStreetMap) y docs de la API
test/run-tests.js    Pruebas del algoritmo
data/db.json         Base de datos JSON (se genera al arrancar; ignorada en git)
```
