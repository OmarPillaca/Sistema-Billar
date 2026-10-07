# Sistema de Gestión de Salón de Billar

Aplicación web **100% frontend** (HTML5, CSS3 y JavaScript ES6+ sin frameworks) para
administrar un salón de billar: mesas en tiempo real, consumos por persona, cobro por
tiempo, productos, gastos, reportes y respaldos de datos.

## Requisitos

- [Visual Studio Code](https://code.visualstudio.com/) con la extensión **Live Server**.
- Un navegador moderno (Chrome, Edge o Firefox).

No necesita servidor, base de datos ni dependencias: los datos se guardan en el
`localStorage` del navegador.

## Cómo ejecutar

1. Abrir la carpeta del proyecto en VS Code.
2. Abrir `index.html` → clic derecho → **Open with Live Server**.
3. El navegador abrirá el dashboard (`pages/dashboard/dashboard.html`).

> Es obligatorio usar Live Server (o cualquier servidor estático): las páginas usan
> módulos ES6 (`type="module"`), que no funcionan abriendo el archivo con `file://`.

## Estructura

```
sistema-billar/
├── index.html                  Redirige al dashboard
├── css/                        variables, temas (claro/oscuro), estilos globales, responsive
├── js/
│   ├── app.js                  Inicialización común (tema, navegación, demo)
│   ├── storage.js              Único módulo que toca localStorage (prefijo "billar:")
│   ├── db.js                   API de datos asíncrona (mesas, sesiones, productos, gastos, config)
│   ├── billing.js              Regla única de cobro por tiempo
│   ├── utils.js                Formateo, modales, notificaciones, confirmaciones
│   ├── theme.js                Tema claro/oscuro persistente
│   ├── navigation.js           Sidebar y menú (definidos una sola vez)
│   ├── comprobante.js          Comprobante imprimible
│   └── reports.js              Agregaciones y gráficos SVG hechos a mano
├── pages/
│   ├── dashboard/              Resumen del día/mes y accesos rápidos
│   ├── mesas/                  Mesas, sesiones en vivo, consumos, cobro
│   ├── productos/              Catálogo con precios, stock e imágenes
│   ├── ventas/                 Historial de sesiones cobradas y canceladas
│   ├── gastos/                 Gastos del salón con categoría y filtros
│   ├── reportes/               Ingresos, gastos, utilidad y gráficos por rango
│   └── configuracion/          Nombre del salón, tema, exportar/importar, demo, borrar
└── tests/                      Pruebas del navegador para billing.js
```

## Funcionalidades

- **Mesas**: crear/editar/desactivar mesas, iniciar sesión con personas, consumos en vivo
  con cantidades, contador y cobro en tiempo real, cancelación con motivo.
- **Cobro**: regla única en `js/billing.js` — horas completas × tarifa + adicional por
  fracción (0–9 min = 0, 10–29 = minuto, 30–59 = media hora + minuto), vuelto y
  comprobante imprimible (`window.print()`).
- **Productos**: CRUD con categorías, precio, estado, stock opcional e imagen
  (URL o archivo ≤ 300 KB).
- **Historial**: sesiones cobradas y canceladas con filtros por fecha, estado, método
  de pago y mesa; detalle y comprobante.
- **Gastos**: CRUD con categorías fijas, filtros por mes/búsqueda y KPIs.
- **Reportes**: rangos rápidos (hoy, 7 días, mes, todo), ingresos por día, gastos por
  categoría, ingresos por método de pago, top productos y sesiones por hora (gráficos
  SVG sin librerías).
- **Configuración**: nombre del salón, pie de comprobante, tema, exportar/importar
  respaldo JSON, restaurar datos demo y borrar todo.
- **Dinero** siempre en soles con 2 decimales; internamente se usa redondeo a
  centavos. **Fechas** en zona horaria `America/Lima`.

## Datos y respaldos

- Todo se guarda en `localStorage` con el prefijo `billar:`.
- **Primera ejecución**: se crean datos de demo (4 mesas y 5 productos).
- **Exportar JSON** descarga un respaldo completo; **Importar JSON** lo valida antes de
  reemplazar los datos (si el archivo es inválido no se modifica nada).
- **Borrar todos los datos** deja el sistema vacío y evita que la demo vuelva a crearse.

## Pruebas

- `tests/pruebas-billing.html` — suite de la regla de cobro (52 casos). Abrirla con
  Live Server: los resultados (✔/✘) se pintan automáticamente en las tablas.

## Fases de desarrollo

| Fase | Contenido | Estado |
|------|-----------|--------|
| 0 | Análisis y especificación (`FASE-0-ANALISIS.md`) | ✅ |
| 1 | Base: HTML, CSS, storage, db, tema, navegación | ✅ |
| 2 | `billing.js` + pruebas de la regla de cobro | ✅ |
| 3 | Mesas: CRUD, sesiones, detalle en vivo | ✅ |
| 4 | Productos + consumos dentro de la sesión | ✅ |
| 5 | Cobro, vuelto, comprobante imprimible, historial | ✅ |
| 6 | Gastos, reportes y dashboard | ✅ |
| 7 | Configuración, respaldos, README y revisión final | ✅ |
