/* ============================================================
   ventas.js — Historial de sesiones: filtros por fecha, estado,
   método de pago y mesa; KPIs; comprobante y detalle.
   ============================================================ */

import { initApp } from '../../js/app.js';
import { db } from '../../js/db.js';
import {
    formatCurrency,
    formatDateTime,
    formatDurationShort,
    msToISO,
    elapsedSeconds,
    openModal,
    notify,
    escapeHtml,
    sortBy,
} from '../../js/utils.js';
import { openComprobante } from '../../js/comprobante.js';

/* ------------------------- Estado --------------------------- */
const state = {
    sesiones: [],
    mesas: [],
    filtros: { desde: '', hasta: '', estado: '', metodo: '', mesa: '' },
};

/* ------------------- Arranque (al final del archivo) -------- */
await initApp({ page: 'ventas' });
await reload();

document.getElementById('filtro-desde').addEventListener('change', (e) => {
    state.filtros.desde = e.target.value;
    render();
});
document.getElementById('filtro-hasta').addEventListener('change', (e) => {
    state.filtros.hasta = e.target.value;
    render();
});
document.getElementById('filtro-estado').addEventListener('change', (e) => {
    state.filtros.estado = e.target.value;
    render();
});
document.getElementById('filtro-metodo').addEventListener('change', (e) => {
    state.filtros.metodo = e.target.value;
    render();
});
document.getElementById('filtro-mesa').addEventListener('change', (e) => {
    state.filtros.mesa = e.target.value;
    render();
});
document.getElementById('ventas-tbody').addEventListener('click', onTableClick);

/* ------------------------ Carga/render ---------------------- */
async function reload() {
    state.sesiones = await db.sesiones.getAll();
    state.mesas = sortBy(await db.mesas.getAll({ incluirEliminadas: true }), (m) => m.nombre);
    renderFiltroMesas();
    render();
}

function renderFiltroMesas() {
    const select = document.getElementById('filtro-mesa');
    const actual = state.filtros.mesa;
    select.innerHTML = '<option value="">Todas</option>';
    state.mesas.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.nombre;
        if (m.id === actual) opt.selected = true;
        select.appendChild(opt);
    });
    if (actual && !state.mesas.some((m) => m.id === actual)) {
        state.filtros.mesa = '';
        select.value = '';
    }
}

function filteredSessions() {
    let list = [...state.sesiones];
    const f = state.filtros;

    if (f.estado) list = list.filter((s) => s.estado === f.estado);
    if (f.mesa) list = list.filter((s) => s.mesaId === f.mesa);
    if (f.metodo) list = list.filter((s) => s.cobro && s.cobro.metodoPago === f.metodo);
    if (f.desde) list = list.filter((s) => msToISO(sessionEnd(s)) >= f.desde);
    if (f.hasta) list = list.filter((s) => msToISO(sessionEnd(s)) <= f.hasta);

    return list.sort((a, b) => sessionEnd(b) - sessionEnd(a));
}

function sessionEnd(s) {
    if (s.estado === 'ACTIVA') return Date.now();
    return s.fin || s.inicio || 0;
}

function render() {
    const lista = filteredSessions();
    const tbody = document.getElementById('ventas-tbody');
    const wrap = document.getElementById('ventas-table-wrap');
    const vacio = document.getElementById('ventas-vacio');
    tbody.innerHTML = '';

    const hayFiltro = Object.values(state.filtros).some(Boolean);

    if (lista.length === 0) {
        wrap.classList.add('hidden');
        vacio.classList.remove('hidden');
        if (state.sesiones.length === 0) {
            document.getElementById('ventas-vacio-titulo').textContent = 'Sin sesiones todavía';
            document.getElementById('ventas-vacio-texto').textContent =
                'Cuando finalices o canceles sesiones aparecerán aquí.';
        } else {
            document.getElementById('ventas-vacio-titulo').textContent = 'Sin resultados';
            document.getElementById('ventas-vacio-texto').textContent = hayFiltro
                ? 'Ninguna sesión coincide con los filtros aplicados.'
                : 'No hay sesiones que mostrar.';
        }
    } else {
        wrap.classList.remove('hidden');
        vacio.classList.add('hidden');
        lista.forEach((s) => tbody.appendChild(buildRow(s)));
    }

    renderStats(lista);
    renderSubtitle(lista);
}

function buildRow(s) {
    const tr = document.createElement('tr');
    const cobro = s.cobro;
    const fin = sessionEnd(s);

    const duracion =
        s.estado === 'FINALIZADA'
            ? formatDurationShort(cobro.minutos)
            : s.estado === 'CANCELADA'
              ? formatDurationShort(Math.floor((s.fin - s.inicio) / 60000))
              : formatDurationShort(Math.floor(elapsedSeconds(s.inicio) / 60));

    const badgeEstado =
        s.estado === 'FINALIZADA'
            ? '<span class="badge badge--success">FINALIZADA</span>'
            : s.estado === 'CANCELADA'
              ? '<span class="badge badge--gray">CANCELADA</span>'
              : '<span class="badge badge--danger badge--pulse">EN CURSO</span>';

    const acciones =
        s.estado === 'FINALIZADA'
            ? `<button type="button" class="btn btn--sm btn--secondary" data-ver-comprobante="${s.id}">Comprobante</button>`
            : `<button type="button" class="btn btn--sm btn--secondary" data-ver-detalle="${s.id}">Detalle</button>`;

    tr.innerHTML = `
        <td data-label="Fecha">${formatDateTime(fin)}</td>
        <td data-label="Mesa"><strong>${escapeHtml(s.mesaNombre || '—')}</strong></td>
        <td class="num" data-label="Duración">${duracion}</td>
        <td class="num" data-label="Tiempo">${cobro ? formatCurrency(cobro.cargoMesa) : '—'}</td>
        <td class="num" data-label="Productos">${cobro ? formatCurrency(cobro.totalProductos) : '—'}</td>
        <td class="num" data-label="Total"><strong>${
            cobro ? formatCurrency(cobro.total) : '—'
        }</strong></td>
        <td data-label="Estado">${badgeEstado}</td>
        <td data-label="Pago">${
            cobro ? `<span class="badge badge--pago">${escapeHtml(cobro.metodoPago)}</span>` : '—'
        }</td>
        <td class="actions-cell" data-label="Acciones"><div class="ventas-acciones">${acciones}</div></td>`;
    return tr;
}

function renderStats(lista) {
    const finalizadas = lista.filter((s) => s.estado === 'FINALIZADA' && s.cobro);
    const cobrado = finalizadas.reduce((a, s) => a + s.cobro.total, 0);
    const tiempo = finalizadas.reduce((a, s) => a + s.cobro.cargoMesa, 0);
    const productos = finalizadas.reduce((a, s) => a + s.cobro.totalProductos, 0);
    const canceladas = lista.filter((s) => s.estado === 'CANCELADA').length;

    document.getElementById('stat-cobrado').textContent = formatCurrency(cobrado);
    document.getElementById('stat-tiempo').textContent = formatCurrency(tiempo);
    document.getElementById('stat-productos').textContent = formatCurrency(productos);
    document.getElementById('stat-canceladas').textContent = String(canceladas);
}

function renderSubtitle(lista) {
    const total = state.sesiones.length;
    if (total === 0) {
        document.getElementById('ventas-subtitle').textContent = 'Aún no hay sesiones registradas';
        return;
    }
    const fin = lista.filter((s) => s.estado === 'FINALIZADA').length;
    const can = lista.filter((s) => s.estado === 'CANCELADA').length;
    const act = lista.filter((s) => s.estado === 'ACTIVA').length;
    const parte = `${lista.length} en la vista · ${fin} finalizada${fin === 1 ? '' : 's'} · ${can} cancelada${
        can === 1 ? '' : 's'
    }${act ? ` · ${act} en curso` : ''}`;
    document.getElementById('ventas-subtitle').textContent = `${total} ${
        total === 1 ? 'sesión' : 'sesiones'
    } · ${parte}`;
}

/* ------------------------ Acciones -------------------------- */
async function onTableClick(e) {
    const btn = e.target.closest('[data-ver-comprobante], [data-ver-detalle]');
    if (!btn) return;

    if (btn.dataset.verComprobante) {
        const sesion = state.sesiones.find((s) => s.id === btn.dataset.verComprobante);
        if (!sesion) return;
        try {
            await openComprobante(sesion);
        } catch (err) {
            notify(err.message, 'error');
        }
        return;
    }

    const sesion = state.sesiones.find((s) => s.id === btn.dataset.verDetalle);
    if (sesion) openDetalle(sesion);
}

function openDetalle(sesion) {
    const cancelada = sesion.estado === 'CANCELADA';
    const personas = sesion.personas.map((p) => escapeHtml(p.nombre)).join(', ') || '—';
    const consumos = sesion.consumos.length
        ? sesion.consumos
              .map(
                  (c) =>
                      `<div class="comprobante__row"><span>${c.cantidad} × ${escapeHtml(c.nombre)}</span><span>${formatCurrency(
                          c.subtotal
                      )}</span></div>`
              )
              .join('')
        : '<p class="form-hint">Sin productos.</p>';

    const content = `
        <div class="kv">
            <div class="kv__row"><span>Mesa</span><span>${escapeHtml(sesion.mesaNombre || '—')}</span></div>
            <div class="kv__row"><span>Inicio</span><span>${formatDateTime(sesion.inicio)}</span></div>
            <div class="kv__row"><span>Fin</span><span>${sesion.fin ? formatDateTime(sesion.fin) : '—'}</span></div>
            <div class="kv__row"><span>Tarifa</span><span>${formatCurrency(sesion.tarifaHora)}/h</span></div>
            <div class="kv__row"><span>Personas</span><span>${personas}</span></div>
        </div>
        <hr class="cuenta-sep">
        <div class="comprobante__row comprobante__row--strong"><span>Productos</span><span>${formatCurrency(
            sesion.consumos.reduce((a, c) => a + c.subtotal, 0)
        )}</span></div>
        ${consumos}
        ${
            cancelada
                ? `<hr class="cuenta-sep">
                   <p class="modal__text">Sesión <strong>CANCELADA</strong>${
                       sesion.motivoCancelacion ? ` — Motivo: ${escapeHtml(sesion.motivoCancelacion)}` : ''
                   }. Sin cobro; el stock de sus consumos fue devuelto.</p>`
                : '<p class="form-hint mt-3">Sesión aún en curso. Cómprala desde la página de Mesas.</p>'
        }`;

    const modal = openModal({
        title: cancelada ? 'Detalle de sesión cancelada' : 'Detalle de sesión',
        content,
        size: 'md',
        footer: '<button type="button" class="btn btn--secondary" data-close>Cerrar</button>',
    });
    modal.root.querySelector('[data-close]').addEventListener('click', () => modal.close());
}
