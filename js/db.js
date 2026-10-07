/* ============================================================
   db.js — Capa de abstracción de datos (asíncrona, con Promesas)
   Hoy persiste en localStorage vía storage.js; mañana podría
   apuntar a una API REST sin tocar las páginas.
   Las páginas NUNCA manipulan localStorage directamente.
   ============================================================ */

import { read, write, remove } from './storage.js';
import { notify, generateId, round2, isValidISODate } from './utils.js';

/** Versión del esquema (migraciones futuras). */
export const SCHEMA_VERSION = 1;

export const ESTADOS_MESA = ['DISPONIBLE', 'EN_USO', 'INACTIVA'];
export const ESTADOS_SESION = ['ACTIVA', 'FINALIZADA', 'CANCELADA'];
export const CATEGORIAS_GASTO = ['Limpieza', 'Servicios', 'Mantenimiento', 'Compra de productos', 'Otros'];

const K = {
    mesas: 'mesas',
    sesiones: 'sesiones',
    productos: 'productos',
    gastos: 'gastos',
    config: 'config',
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function getCollection(key) {
    const value = read(key, []);
    if (!Array.isArray(value)) {
        notify(`La colección "${key}" estaba dañada y se usó una lista vacía.`, 'warning');
        return [];
    }
    return value;
}

function saveCollection(key, list) {
    if (!write(key, list)) throw new Error(`No se pudo guardar "${key}" en el navegador.`);
}

function findIn(list, id) {
    return list.find((item) => item.id === id) || null;
}

function assertString(value, message) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message);
    return value.trim();
}

function assertNumber(value, message, { min = null, exclusiveMin = false } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(message);
    if (min !== null) {
        if (exclusiveMin ? n <= min : n < min) throw new Error(message);
    }
    return n;
}

/* ------------------------------------------------------------
   MESAS
   ------------------------------------------------------------ */
const mesasApi = {
    async getAll({ incluirEliminadas = false } = {}) {
        const list = getCollection(K.mesas);
        const visible = incluirEliminadas ? list : list.filter((m) => !m.eliminada);
        return visible.map(clone);
    },

    async getById(id, { incluirEliminada = true } = {}) {
        const mesa = findIn(getCollection(K.mesas), id);
        if (!mesa || (!incluirEliminada && mesa.eliminada)) return null;
        return clone(mesa);
    },

    async create({ nombre, tarifaHora, estado = 'DISPONIBLE' } = {}) {
        const nombreLimpio = assertString(nombre, 'El nombre de la mesa es obligatorio.');
        const tarifa = assertNumber(tarifaHora, 'La tarifa por hora debe ser un número mayor a 0.', {
            min: 0,
            exclusiveMin: true,
        });
        const lista = getCollection(K.mesas);
        if (lista.some((m) => !m.eliminada && m.nombre.toLowerCase() === nombreLimpio.toLowerCase())) {
            throw new Error('Ya existe una mesa con ese nombre.');
        }
        const estadoFinal = ESTADOS_MESA.includes(estado) && estado !== 'EN_USO' ? estado : 'DISPONIBLE';
        const ahora = Date.now();
        const mesa = {
            id: generateId('mesa'),
            nombre: nombreLimpio,
            tarifaHora: round2(tarifa),
            estado: estadoFinal,
            eliminada: false,
            creadaEn: ahora,
            actualizadaEn: ahora,
        };
        lista.push(mesa);
        saveCollection(K.mesas, lista);
        return clone(mesa);
    },

    async update(id, parcial = {}) {
        const lista = getCollection(K.mesas);
        const mesa = lista.find((m) => m.id === id && !m.eliminada);
        if (!mesa) throw new Error('La mesa no existe.');

        if (parcial.nombre !== undefined) {
            const nombreLimpio = assertString(parcial.nombre, 'El nombre de la mesa es obligatorio.');
            if (
                lista.some(
                    (m) => m.id !== id && !m.eliminada && m.nombre.toLowerCase() === nombreLimpio.toLowerCase()
                )
            ) {
                throw new Error('Ya existe otra mesa con ese nombre.');
            }
            mesa.nombre = nombreLimpio;
        }

        if (parcial.tarifaHora !== undefined) {
            mesa.tarifaHora = round2(
                assertNumber(parcial.tarifaHora, 'La tarifa por hora debe ser un número mayor a 0.', {
                    min: 0,
                    exclusiveMin: true,
                })
            );
        }

        if (parcial.estado !== undefined) {
            if (!ESTADOS_MESA.includes(parcial.estado)) throw new Error('Estado de mesa no válido.');
            if (parcial.estado === 'EN_USO') {
                throw new Error('El estado EN_USO lo controla una sesión activa.');
            }
            if (mesa.estado === 'EN_USO') {
                throw new Error('No se puede desactivar una mesa que está en uso. Finaliza o cancela la sesión primero.');
            }
            mesa.estado = parcial.estado;
        }

        mesa.actualizadaEn = Date.now();
        saveCollection(K.mesas, lista);
        return clone(mesa);
    },

    /**
     * Eliminación lógica. Si la mesa tiene sesión activa, la cancela
     * (sin cobro, devuelve stock) y luego elimina la mesa.
     */
    async delete(id) {
        const mesas = getCollection(K.mesas);
        const sesiones = getCollection(K.sesiones);
        const productos = getCollection(K.productos);
        const mesa = findIn(mesas, id);
        if (!mesa || mesa.eliminada) throw new Error('La mesa no existe.');

        const activa = sesiones.find((s) => s.mesaId === id && s.estado === 'ACTIVA');
        if (activa) aplicarCancelacion(activa, 'Mesa eliminada por el usuario', { mesas, productos });

        mesa.eliminada = true;
        mesa.actualizadaEn = Date.now();

        saveCollection(K.mesas, mesas);
        saveCollection(K.sesiones, sesiones);
        saveCollection(K.productos, productos);
        return clone(mesa);
    },
};

/* ------------------------------------------------------------
   PRODUCTOS
   ------------------------------------------------------------ */
const productosApi = {
    async getAll({ incluirEliminados = false, soloActivos = false } = {}) {
        let list = getCollection(K.productos);
        if (!incluirEliminados) list = list.filter((p) => !p.eliminado);
        if (soloActivos) list = list.filter((p) => p.estado === 'ACTIVO');
        return list.map(clone);
    },

    async getById(id, { incluirEliminado = true } = {}) {
        const producto = findIn(getCollection(K.productos), id);
        if (!producto || (!incluirEliminado && producto.eliminado)) return null;
        return clone(producto);
    },

    async create({ nombre, categoria = '', precio, estado = 'ACTIVO', imagen = null, stock = null } = {}) {
        const nombreLimpio = assertString(nombre, 'El nombre del producto es obligatorio.');
        const precioFinal = assertNumber(precio, 'El precio debe ser un número no negativo.', { min: 0 });
        const stockFinal = normalizeStock(stock);
        const imagenFinal = normalizeImagen(imagen);

        const lista = getCollection(K.productos);
        if (lista.some((p) => !p.eliminado && p.nombre.toLowerCase() === nombreLimpio.toLowerCase())) {
            throw new Error('Ya existe un producto con ese nombre.');
        }

        const producto = {
            id: generateId('producto'),
            nombre: nombreLimpio,
            categoria: typeof categoria === 'string' ? categoria.trim() : '',
            precio: round2(precioFinal),
            estado: estado === 'INACTIVO' ? 'INACTIVO' : 'ACTIVO',
            imagen: imagenFinal,
            stock: stockFinal,
            eliminado: false,
        };
        lista.push(producto);
        saveCollection(K.productos, lista);
        return clone(producto);
    },

    async update(id, parcial = {}) {
        const lista = getCollection(K.productos);
        const producto = lista.find((p) => p.id === id && !p.eliminado);
        if (!producto) throw new Error('El producto no existe.');

        if (parcial.nombre !== undefined) {
            const nombreLimpio = assertString(parcial.nombre, 'El nombre del producto es obligatorio.');
            if (
                lista.some(
                    (p) => p.id !== id && !p.eliminado && p.nombre.toLowerCase() === nombreLimpio.toLowerCase()
                )
            ) {
                throw new Error('Ya existe otro producto con ese nombre.');
            }
            producto.nombre = nombreLimpio;
        }

        if (parcial.precio !== undefined) {
            producto.precio = round2(
                assertNumber(parcial.precio, 'El precio debe ser un número no negativo.', { min: 0 })
            );
        }

        if (parcial.categoria !== undefined) {
            producto.categoria = typeof parcial.categoria === 'string' ? parcial.categoria.trim() : '';
        }

        if (parcial.estado !== undefined) {
            if (parcial.estado !== 'ACTIVO' && parcial.estado !== 'INACTIVO') {
                throw new Error('Estado de producto no válido.');
            }
            producto.estado = parcial.estado;
        }

        if (parcial.stock !== undefined) producto.stock = normalizeStock(parcial.stock);
        if (parcial.imagen !== undefined) producto.imagen = normalizeImagen(parcial.imagen);

        saveCollection(K.productos, lista);
        return clone(producto);
    },

    /** Eliminación lógica: las ventas anteriores se conservan. */
    async delete(id) {
        const lista = getCollection(K.productos);
        const producto = findIn(lista, id);
        if (!producto || producto.eliminado) throw new Error('El producto no existe.');
        producto.eliminado = true;
        saveCollection(K.productos, lista);
        return clone(producto);
    },
};

function normalizeStock(stock) {
    if (stock === null || stock === undefined || stock === '') return null;
    const n = Number(stock);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new Error('El stock debe ser un número entero mayor o igual a 0 (o vacío sin control).');
    }
    return n;
}

function normalizeImagen(imagen) {
    if (imagen === null || imagen === undefined || imagen === '') return null;
    const raw = String(imagen);
    if (raw.length > 400000) throw new Error('La imagen es demasiado grande para guardarse (máximo aproximado 300 KB).');
    return raw;
}

/* ------------------------------------------------------------
   SESIONES (personas, consumos, cobro)
   ------------------------------------------------------------ */

/** Normaliza la lista de personas (mínimo una, IDs únicos). */
function normalizarPersonas(personas) {
    if (!Array.isArray(personas) || personas.length === 0) {
        throw new Error('Debes indicar al menos una persona principal.');
    }
    const result = [];
    const ids = new Set();
    for (const p of personas) {
        const nombre = assertString(p && p.nombre, 'El nombre de la persona no puede estar vacío.');
        let id = p.id && typeof p.id === 'string' ? p.id : generateId('persona');
        if (ids.has(id)) id = generateId('persona');
        ids.add(id);
        result.push({ id, nombre });
    }
    return result;
}

/** Devuelve el stock de los consumos y marca la sesión CANCELADA. */
function aplicarCancelacion(sesion, motivo, { mesas, productos }) {
    for (const consumo of sesion.consumos || []) {
        const producto = findIn(productos, consumo.productoId);
        if (producto && typeof producto.stock === 'number') {
            producto.stock += consumo.cantidad;
        }
    }
    sesion.estado = 'CANCELADA';
    sesion.fin = Date.now();
    sesion.motivoCancelacion = motivo && motivo.trim() ? motivo.trim() : null;
    sesion.cobro = null;
    const mesa = findIn(mesas, sesion.mesaId);
    if (mesa && mesa.estado === 'EN_USO') {
        mesa.estado = 'DISPONIBLE';
        mesa.actualizadaEn = Date.now();
    }
}

const sesionesApi = {
    async getAll() {
        return getCollection(K.sesiones).map(clone);
    },

    async getById(id) {
        const sesion = findIn(getCollection(K.sesiones), id);
        return sesion ? clone(sesion) : null;
    },

    async getActivas() {
        return getCollection(K.sesiones)
            .filter((s) => s.estado === 'ACTIVA')
            .map(clone);
    },

    async getByMesa(mesaId) {
        return getCollection(K.sesiones)
            .filter((s) => s.mesaId === mesaId)
            .map(clone);
    },

    /** Inicia una sesión: congela tarifa, marca la mesa EN_USO. */
    async create({ mesaId, personas } = {}) {
        const mesas = getCollection(K.mesas);
        const sesiones = getCollection(K.sesiones);

        const mesa = findIn(mesas, mesaId);
        if (!mesa || mesa.eliminada) throw new Error('La mesa no existe.');
        if (mesa.estado === 'INACTIVA') throw new Error('La mesa está inactiva y no puede iniciar una sesión.');
        if (sesiones.some((s) => s.mesaId === mesaId && s.estado === 'ACTIVA')) {
            throw new Error('La mesa ya tiene una sesión activa.');
        }

        const personasLimpias = normalizarPersonas(personas);
        const ahora = Date.now();

        const sesion = {
            id: generateId('sesion'),
            mesaId,
            mesaNombre: mesa.nombre,
            tarifaHora: mesa.tarifaHora,
            inicio: ahora,
            fin: null,
            estado: 'ACTIVA',
            personas: personasLimpias,
            consumos: [],
            cobro: null,
        };

        const estadoPrevio = mesa.estado;
        mesa.estado = 'EN_USO';
        mesa.actualizadaEn = ahora;
        saveCollection(K.mesas, mesas);

        sesiones.push(sesion);
        try {
            saveCollection(K.sesiones, sesiones);
        } catch (err) {
            // Revertir la mesa si no se pudo guardar la sesión.
            mesa.estado = estadoPrevio;
            saveCollection(K.mesas, mesas);
            throw err;
        }
        return clone(sesion);
    },

    /**
     * Actualización genérica limitada a campos seguros (personas).
     * Consumos, cobro y estado se gestionan con acciones específicas.
     */
    async update(id, parcial = {}) {
        const sesiones = getCollection(K.sesiones);
        const sesion = findIn(sesiones, id);
        if (!sesion) throw new Error('La sesión no existe.');

        if (parcial.personas !== undefined) sesion.personas = normalizarPersonas(parcial.personas);

        if (parcial.estado !== undefined && parcial.estado !== sesion.estado) {
            throw new Error('El estado de la sesión se gestiona al finalizar o cancelar.');
        }
        if (parcial.consumos !== undefined || parcial.cobro !== undefined || parcial.inicio !== undefined) {
            throw new Error('Usa las acciones específicas para modificar consumos, cobro u horario.');
        }

        saveCollection(K.sesiones, sesiones);
        return clone(sesion);
    },

    /* ------------------------- Personas ------------------------- */
    async addPersona(sesionId, { nombre } = {}) {
        const sesiones = getCollection(K.sesiones);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        if (sesion.estado !== 'ACTIVA') throw new Error('La sesión ya no está activa.');
        const nombreLimpio = assertString(nombre, 'El nombre de la persona no puede estar vacío.');
        const persona = { id: generateId('persona'), nombre: nombreLimpio };
        sesion.personas.push(persona);
        saveCollection(K.sesiones, sesiones);
        return clone(persona);
    },

    async updatePersona(sesionId, personaId, { nombre } = {}) {
        const sesiones = getCollection(K.sesiones);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        const persona = sesion.personas.find((p) => p.id === personaId);
        if (!persona) throw new Error('La persona no existe en esta sesión.');
        persona.nombre = assertString(nombre, 'El nombre de la persona no puede estar vacío.');
        saveCollection(K.sesiones, sesiones);
        return clone(persona);
    },

    async removePersona(sesionId, personaId) {
        const sesiones = getCollection(K.sesiones);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        if (sesion.personas.length <= 1) {
            throw new Error('La sesión debe conservar al menos una persona.');
        }
        if (sesion.consumos.some((c) => c.personaId === personaId)) {
            throw new Error('Esa persona tiene consumos. Quita sus consumos antes de eliminarla.');
        }
        sesion.personas = sesion.personas.filter((p) => p.id !== personaId);
        saveCollection(K.sesiones, sesiones);
        return true;
    },

    /* ------------------------- Consumos ------------------------- */
    async addConsumo(sesionId, { productoId, cantidad, personaId } = {}) {
        const sesiones = getCollection(K.sesiones);
        const productos = getCollection(K.productos);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        if (sesion.estado !== 'ACTIVA') throw new Error('La sesión ya no está activa; no se pueden agregar productos.');

        const producto = findIn(productos, productoId);
        if (!producto || producto.eliminado) throw new Error('El producto no existe o fue eliminado.');
        if (producto.estado !== 'ACTIVO') throw new Error('El producto está inactivo y no se puede vender.');

        const cant = Math.trunc(Number(cantidad));
        if (!Number.isFinite(cant) || cant < 1) throw new Error('La cantidad debe ser al menos 1.');

        const persona = sesion.personas.find((p) => p.id === personaId);
        if (!persona) throw new Error('Selecciona la persona que pidió el producto.');

        if (typeof producto.stock === 'number' && producto.stock < cant) {
            throw new Error(`Stock insuficiente de ${producto.nombre} (disponible: ${producto.stock}).`);
        }

        const precio = round2(producto.precio);
        const consumo = {
            id: generateId('consumo'),
            productoId: producto.id,
            nombre: producto.nombre,
            precioUnitario: precio,
            cantidad: cant,
            personaId,
            subtotal: round2(precio * cant),
            creadoEn: Date.now(),
        };

        sesion.consumos.push(consumo);
        if (typeof producto.stock === 'number') producto.stock -= cant;

        saveCollection(K.sesiones, sesiones);
        saveCollection(K.productos, productos);
        return clone(consumo);
    },

    async removeConsumo(sesionId, consumoId) {
        const sesiones = getCollection(K.sesiones);
        const productos = getCollection(K.productos);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        const consumo = sesion.consumos.find((c) => c.id === consumoId);
        if (!consumo) throw new Error('El consumo no existe.');

        sesion.consumos = sesion.consumos.filter((c) => c.id !== consumoId);
        const producto = findIn(productos, consumo.productoId);
        if (producto && typeof producto.stock === 'number') producto.stock += consumo.cantidad;

        saveCollection(K.sesiones, sesiones);
        saveCollection(K.productos, productos);
        return true;
    },

    async updateConsumoCantidad(sesionId, consumoId, cantidad) {
        const sesiones = getCollection(K.sesiones);
        const productos = getCollection(K.productos);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        if (sesion.estado !== 'ACTIVA') throw new Error('La sesión ya no está activa.');

        const consumo = sesion.consumos.find((c) => c.id === consumoId);
        if (!consumo) throw new Error('El consumo no existe.');

        const cant = Math.trunc(Number(cantidad));
        if (!Number.isFinite(cant) || cant < 1) throw new Error('La cantidad debe ser al menos 1.');

        const delta = cant - consumo.cantidad;
        const producto = findIn(productos, consumo.productoId);
        if (producto && typeof producto.stock === 'number') {
            if (delta > 0 && producto.stock < delta) {
                throw new Error(`Stock insuficiente de ${producto.nombre} (disponible: ${producto.stock}).`);
            }
            producto.stock -= delta;
        }

        consumo.cantidad = cant;
        consumo.subtotal = round2(consumo.precioUnitario * cant);

        saveCollection(K.sesiones, sesiones);
        saveCollection(K.productos, productos);
        return clone(consumo);
    },

    /* -------------------- Cancelar / finalizar -------------------- */

    /** Cancela una sesión ACTIVA: sin cobro, devuelve stock, libera la mesa. */
    async cancelar(sesionId, motivo = '') {
        const sesiones = getCollection(K.sesiones);
        const mesas = getCollection(K.mesas);
        const productos = getCollection(K.productos);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        if (sesion.estado !== 'ACTIVA') throw new Error('Solo se pueden cancelar sesiones activas.');

        aplicarCancelacion(sesion, motivo, { mesas, productos });

        saveCollection(K.sesiones, sesiones);
        saveCollection(K.mesas, mesas);
        saveCollection(K.productos, productos);
        return clone(sesion);
    },

    /**
     * Finaliza y cobra una sesión. El cobro se calcula fuera (billing.js)
     * y llega ya validado; aquí se congrega fin, estado y liberación de mesa.
     * @param {string} sesionId
     * @param {{fin?:number, minutos:number, cargoMesa:number, totalProductos:number,
     *          total:number, metodoPago:string, montoRecibido:number, vuelto:number}} cobro
     */
    async finalizar(sesionId, cobro = {}) {
        if (!cobro || typeof cobro !== 'object') throw new Error('Faltan los datos del cobro.');
        for (const campo of ['minutos', 'cargoMesa', 'totalProductos', 'total', 'montoRecibido', 'vuelto']) {
            const v = Number(cobro[campo]);
            if (!Number.isFinite(v) || v < 0) throw new Error(`El campo "${campo}" del cobro no es válido.`);
        }
        if (!assertStringSafe(cobro.metodoPago)) throw new Error('Debes indicar el método de pago.');

        const sesiones = getCollection(K.sesiones);
        const mesas = getCollection(K.mesas);
        const sesion = findIn(sesiones, sesionId);
        if (!sesion) throw new Error('La sesión no existe.');
        if (sesion.estado !== 'ACTIVA') throw new Error('La sesión ya no está activa.');

        const fin = Number.isFinite(Number(cobro.fin)) ? Number(cobro.fin) : Date.now();

        sesion.fin = fin;
        sesion.estado = 'FINALIZADA';
        sesion.cobro = {
            minutos: Math.floor(Number(cobro.minutos)),
            cargoMesa: round2(cobro.cargoMesa),
            totalProductos: round2(cobro.totalProductos),
            total: round2(cobro.total),
            metodoPago: String(cobro.metodoPago).trim().toUpperCase(),
            montoRecibido: round2(cobro.montoRecibido),
            vuelto: round2(cobro.vuelto),
            pagadoEn: fin,
        };

        const mesa = findIn(mesas, sesion.mesaId);
        if (mesa && mesa.estado === 'EN_USO') {
            mesa.estado = 'DISPONIBLE';
            mesa.actualizadaEn = Date.now();
        }

        saveCollection(K.sesiones, sesiones);
        saveCollection(K.mesas, mesas);
        return clone(sesion);
    },
};

function assertStringSafe(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/* ------------------------------------------------------------
   GASTOS
   ------------------------------------------------------------ */
const gastosApi = {
    async getAll() {
        return getCollection(K.gastos).map(clone);
    },

    async create({ monto, descripcion, categoria, fecha } = {}) {
        const montoFinal = assertNumber(monto, 'El monto del gasto debe ser un número mayor a 0.', {
            min: 0,
            exclusiveMin: true,
        });
        const desc = assertString(descripcion, 'La descripción del gasto es obligatoria.');
        const fechaFinal = assertString(fecha, 'La fecha del gasto es obligatoria.');
        if (!isValidISODate(fechaFinal)) throw new Error('La fecha del gasto no es válida (usa el formato AAAA-MM-DD).');
        const cat = assertString(categoria, 'Selecciona una categoría de gasto.');
        if (!CATEGORIAS_GASTO.includes(cat)) throw new Error('Categoría de gasto no válida.');

        const lista = getCollection(K.gastos);
        const gasto = {
            id: generateId('gasto'),
            monto: round2(montoFinal),
            descripcion: desc,
            categoria: cat,
            fecha: fechaFinal,
            creadoEn: Date.now(),
        };
        lista.push(gasto);
        saveCollection(K.gastos, lista);
        return clone(gasto);
    },

    async update(id, parcial = {}) {
        const lista = getCollection(K.gastos);
        const gasto = findIn(lista, id);
        if (!gasto) throw new Error('El gasto no existe.');

        if (parcial.monto !== undefined) {
            gasto.monto = round2(
                assertNumber(parcial.monto, 'El monto del gasto debe ser un número mayor a 0.', {
                    min: 0,
                    exclusiveMin: true,
                })
            );
        }
        if (parcial.descripcion !== undefined) {
            gasto.descripcion = assertString(parcial.descripcion, 'La descripción del gasto es obligatoria.');
        }
        if (parcial.categoria !== undefined) {
            const cat = assertString(parcial.categoria, 'Selecciona una categoría de gasto.');
            if (!CATEGORIAS_GASTO.includes(cat)) throw new Error('Categoría de gasto no válida.');
            gasto.categoria = cat;
        }
        if (parcial.fecha !== undefined) {
            const fecha = assertString(parcial.fecha, 'La fecha del gasto es obligatoria.');
            if (!isValidISODate(fecha)) throw new Error('La fecha del gasto no es válida (usa el formato AAAA-MM-DD).');
            gasto.fecha = fecha;
        }

        saveCollection(K.gastos, lista);
        return clone(gasto);
    },

    async delete(id) {
        const lista = getCollection(K.gastos);
        const gasto = findIn(lista, id);
        if (!gasto) throw new Error('El gasto no existe.');
        const restantes = lista.filter((g) => g.id !== id);
        saveCollection(K.gastos, restantes);
        return true;
    },
};

/* ------------------------------------------------------------
   CONFIGURACIÓN
   ------------------------------------------------------------ */
function defaultConfig() {
    return {
        version: SCHEMA_VERSION,
        nombreSalon: 'Salón de Billar',
        tema: null,
        pieComprobante: '¡Gracias por su visita!',
        datosDemoAplicados: false,
    };
}

const configApi = {
    async get() {
        const actual = read(K.config, null);
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
            const nueva = defaultConfig();
            write(K.config, nueva);
            return nueva;
        }
        return { ...defaultConfig(), ...actual, version: SCHEMA_VERSION };
    },

    async update(parcial = {}) {
        const actual = await configApi.get();
        const { version, ...resto } = parcial;
        const siguiente = { ...actual, ...resto, version: SCHEMA_VERSION };
        if (!write(K.config, siguiente)) throw new Error('No se pudo guardar la configuración.');
        return siguiente;
    },
};

/* ------------------------------------------------------------
   EXPORTAR / IMPORTAR / LIMPIAR / DEMO
   ------------------------------------------------------------ */

async function exportAll() {
    return {
        app: 'sistema-billar',
        version: SCHEMA_VERSION,
        exportadoEn: Date.now(),
        mesas: await mesasApi.getAll({ incluirEliminadas: true }),
        sesiones: await sesionesApi.getAll(),
        productos: await productosApi.getAll({ incluirEliminados: true }),
        gastos: await gastosApi.getAll(),
        config: await configApi.get(),
    };
}

/** Valida una importación completa; lanza Error con el motivo si es inválida. */
function validateImportData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('El archivo no contiene un objeto JSON válido.');
    }
    if (typeof data.version !== 'number') {
        throw new Error('El archivo no indica la versión del esquema (campo "version").');
    }
    if (data.version > SCHEMA_VERSION) {
        throw new Error(`El archivo usa una versión más reciente (${data.version}) que la soportada (${SCHEMA_VERSION}).`);
    }
    for (const key of ['mesas', 'sesiones', 'productos', 'gastos']) {
        if (!Array.isArray(data[key])) throw new Error(`Falta la colección "${key}" o no es una lista.`);
    }
    if (data.config !== undefined && (typeof data.config !== 'object' || data.config === null || Array.isArray(data.config))) {
        throw new Error('La configuración (config) del archivo no es válida.');
    }

    const errors = [];
    const checkIds = (list, name) => {
        const ids = new Set();
        list.forEach((item, i) => {
            if (!item || typeof item !== 'object') {
                errors.push(`${name}[${i}] no es un objeto.`);
                return;
            }
            if (typeof item.id !== 'string' || !item.id) errors.push(`${name}[${i}] no tiene un id válido.`);
            else if (ids.has(item.id)) errors.push(`${name}: id duplicado "${item.id}".`);
            else ids.add(item.id);
        });
    };

    checkIds(data.mesas, 'mesas');
    checkIds(data.sesiones, 'sesiones');
    checkIds(data.productos, 'productos');
    checkIds(data.gastos, 'gastos');

    data.mesas.forEach((m, i) => {
        if (typeof m.nombre !== 'string' || !m.nombre.trim()) errors.push(`mesas[${i}]: falta el nombre.`);
        if (typeof m.tarifaHora !== 'number' || m.tarifaHora <= 0) errors.push(`mesas[${i}]: tarifaHora inválida.`);
        if (!ESTADOS_MESA.includes(m.estado)) errors.push(`mesas[${i}]: estado inválido.`);
    });

    data.sesiones.forEach((s, i) => {
        if (typeof s.mesaId !== 'string' || !s.mesaId) errors.push(`sesiones[${i}]: falta mesaId.`);
        if (typeof s.inicio !== 'number') errors.push(`sesiones[${i}]: falta inicio.`);
        if (!ESTADOS_SESION.includes(s.estado)) errors.push(`sesiones[${i}]: estado inválido.`);
        if (!Array.isArray(s.personas) || s.personas.length === 0) errors.push(`sesiones[${i}]: debe tener personas.`);
        if (!Array.isArray(s.consumos)) errors.push(`sesiones[${i}]: consumos inválidos.`);
        if (typeof s.tarifaHora !== 'number') errors.push(`sesiones[${i}]: falta tarifaHora.`);
    });

    data.productos.forEach((p, i) => {
        if (typeof p.nombre !== 'string' || !p.nombre.trim()) errors.push(`productos[${i}]: falta el nombre.`);
        if (typeof p.precio !== 'number' || p.precio < 0) errors.push(`productos[${i}]: precio inválido.`);
        if (p.estado !== 'ACTIVO' && p.estado !== 'INACTIVO') errors.push(`productos[${i}]: estado inválido.`);
    });

    data.gastos.forEach((g, i) => {
        if (typeof g.monto !== 'number' || g.monto <= 0) errors.push(`gastos[${i}]: monto inválido.`);
        if (typeof g.descripcion !== 'string' || !g.descripcion.trim()) errors.push(`gastos[${i}]: falta descripción.`);
        if (!isValidISODate(g.fecha)) errors.push(`gastos[${i}]: fecha inválida.`);
    });

    if (errors.length) {
        const primeros = errors.slice(0, 5).join(' ');
        const resto = errors.length > 5 ? ` (+${errors.length - 5} más)` : '';
        throw new Error(`El archivo no es válido: ${primeros}${resto}`);
    }
}

async function importAll(data) {
    validateImportData(data); // lanza con el motivo; no se modifica nada si falla

    if (!write(K.mesas, data.mesas)) throw new Error('No se pudieron importar las mesas.');
    if (!write(K.sesiones, data.sesiones)) throw new Error('No se pudieron importar las sesiones.');
    if (!write(K.productos, data.productos)) throw new Error('No se pudieron importar los productos.');
    if (!write(K.gastos, data.gastos)) throw new Error('No se pudieron importar los gastos.');

    const configActual = await configApi.get();
    const configImportada = {
        ...defaultConfig(),
        ...configActual,
        ...(data.config || {}),
        version: SCHEMA_VERSION,
        datosDemoAplicados: true,
    };
    if (!write(K.config, configImportada)) throw new Error('No se pudo importar la configuración.');
    return true;
}

/** Borra todo. Conserva solo el tema; evita resembrar la demo después. */
async function clearAll() {
    remove(K.mesas);
    remove(K.sesiones);
    remove(K.productos);
    remove(K.gastos);
    const configActual = await configApi.get();
    const siguiente = {
        ...defaultConfig(),
        tema: configActual.tema ?? null,
        datosDemoAplicados: true,
    };
    if (!write(K.config, siguiente)) throw new Error('No se pudo reiniciar la configuración.');
    return true;
}

/**
 * Crea los datos de demostración (solo si no hay mesas, salvo reemplazo).
 * @param {{reemplazar?:boolean}} options reemplazar=true limpia todo antes de sembrar.
 */
async function seedDemo({ reemplazar = false } = {}) {
    if (reemplazar) {
        await clearAll();
    } else {
        // Solo primera ejecución: si el flag está marcado (o ya hay mesas), no se siembra.
        const config = await configApi.get();
        const mesasActuales = getCollection(K.mesas).filter((m) => !m.eliminada);
        if (config.datosDemoAplicados === true || mesasActuales.length > 0) return false;
    }

    const ahora = Date.now();
    const mesasDemo = [
        { nombre: 'Mesa 1', tarifaHora: 8 },
        { nombre: 'Mesa 2', tarifaHora: 10 },
        { nombre: 'Mesa 3', tarifaHora: 8 },
        { nombre: 'Mesa 4', tarifaHora: 10 },
    ].map((m) => ({
        id: generateId('mesa'),
        nombre: m.nombre,
        tarifaHora: m.tarifaHora,
        estado: 'DISPONIBLE',
        eliminada: false,
        creadaEn: ahora,
        actualizadaEn: ahora,
    }));

    const productosDemo = [
        { nombre: 'Gaseosa', categoria: 'Bebidas', precio: 5 },
        { nombre: 'Agua', categoria: 'Bebidas', precio: 3 },
        { nombre: 'Snack', categoria: 'Snacks', precio: 4.5 },
        { nombre: 'Café', categoria: 'Bebidas', precio: 4 },
        { nombre: 'Jugo', categoria: 'Bebidas', precio: 6 },
    ].map((p) => ({
        id: generateId('producto'),
        nombre: p.nombre,
        categoria: p.categoria,
        precio: p.precio,
        estado: 'ACTIVO',
        imagen: null,
        stock: null,
        eliminado: false,
    }));

    saveCollection(K.mesas, mesasDemo);
    saveCollection(K.productos, productosDemo);
    await configApi.update({ datosDemoAplicados: true });
    return true;
}

/* ------------------------------------------------------------
   Contrato público
   ------------------------------------------------------------ */
export const db = {
    mesas: mesasApi,
    productos: productosApi,
    sesiones: sesionesApi,
    gastos: gastosApi,
    config: configApi,
    exportAll,
    importAll,
    clearAll,
    seedDemo,
};
