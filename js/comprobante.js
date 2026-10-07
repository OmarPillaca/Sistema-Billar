/* ============================================================
   comprobante.js — Comprobante de pago imprimible.
   Compartido por la página de mesas (cobro) y el historial.
   La impresión usa .print-area + @media print de global.css.
   ============================================================ */

import { openModal, formatCurrency, formatDateTime, formatTime, formatDurationShort, escapeHtml } from './utils.js';
import { getChargeBreakdown } from './billing.js';
import { db } from './db.js';

/** Construye el HTML del comprobante a partir de una sesión FINALIZADA. */
export function buildComprobanteHtml(sesion, { nombreSalon = 'Salón de Billar', pieComprobante = '' } = {}) {
    const cobro = sesion.cobro || {};

    let filasTiempo = '';
    try {
        const b = getChargeBreakdown(cobro.minutos ?? 0, sesion.tarifaHora);
        if (b.horasCompletas > 0) {
            filasTiempo += `<div class="comprobante__row"><span>${b.horasCompletas} hora${
                b.horasCompletas === 1 ? '' : 's'
            } (${formatCurrency(sesion.tarifaHora)}/h)</span><span>${formatCurrency(b.cargoHoras)}</span></div>`;
        }
        if (b.minutosRestantes > 0) {
            filasTiempo += `<div class="comprobante__row"><span>${b.minutosRestantes} min (adicional)</span><span>${formatCurrency(
                b.cargoMinutos
            )}</span></div>`;
        }
        if (b.horasCompletas === 0 && b.minutosRestantes === 0) {
            filasTiempo = `<div class="comprobante__row"><span>Primeros 9 min</span><span>${formatCurrency(0)}</span></div>`;
        }
    } catch (e) {
        filasTiempo = `<div class="comprobante__row"><span>Cargo por tiempo</span><span>${formatCurrency(
            cobro.cargoMesa ?? 0
        )}</span></div>`;
    }

    const productosHtml = (sesion.consumos || [])
        .map(
            (c) =>
                `<div class="comprobante__row"><span>${c.cantidad} × ${escapeHtml(c.nombre)}</span><span>${formatCurrency(
                    c.subtotal
                )}</span></div>`
        )
        .join('');

    const personas = (sesion.personas || []).map((p) => escapeHtml(p.nombre)).join(', ') || '—';
    const fin = cobro.fin ?? sesion.fin ?? sesion.inicio;

    return `
        <div class="comprobante print-area" id="comprobante">
            <div class="comprobante__head">${escapeHtml(nombreSalon)}<br><small>Comprobante de consumo</small></div>
            <div class="comprobante__row"><span>Fecha</span><span>${formatDateTime(fin)}</span></div>
            <div class="comprobante__row"><span>Mesa</span><span>${escapeHtml(sesion.mesaNombre || '—')}</span></div>
            <div class="comprobante__row"><span>Inicio</span><span>${formatTime(sesion.inicio)}</span></div>
            <div class="comprobante__row"><span>Fin</span><span>${formatTime(fin)}</span></div>
            <div class="comprobante__row"><span>Duración</span><span>${formatDurationShort(cobro.minutos ?? 0)}</span></div>
            <div class="comprobante__row"><span>Personas</span><span>${personas}</span></div>
            <hr class="comprobante__sep">
            <div class="comprobante__row comprobante__row--strong"><span>Cargo de mesa</span><span>${formatCurrency(
                cobro.cargoMesa ?? 0
            )}</span></div>
            ${filasTiempo}
            <hr class="comprobante__sep">
            <div class="comprobante__row comprobante__row--strong"><span>Productos</span><span>${formatCurrency(
                cobro.totalProductos ?? 0
            )}</span></div>
            ${productosHtml}
            <div class="comprobante__row comprobante__row--strong"><span>TOTAL</span><span>${formatCurrency(
                cobro.total ?? 0
            )}</span></div>
            <hr class="comprobante__sep">
            <div class="comprobante__row"><span>Método de pago</span><span>${escapeHtml(cobro.metodoPago || '—')}</span></div>
            <div class="comprobante__row"><span>Recibido</span><span>${formatCurrency(cobro.montoRecibido ?? 0)}</span></div>
            <div class="comprobante__row"><span>Vuelto</span><span>${formatCurrency(cobro.vuelto ?? 0)}</span></div>
            <div class="comprobante__foot">${escapeHtml(pieComprobante || '¡Gracias por su visita!')}</div>
        </div>`;
}

/**
 * Abre el comprobante en un modal con botón Imprimir.
 * @param {object} sesion sesión FINALIZADA con cobro
 */
export async function openComprobante(sesion) {
    if (!sesion || sesion.estado !== 'FINALIZADA' || !sesion.cobro) {
        return null;
    }

    let cfg = {};
    try {
        cfg = await db.config.get();
    } catch (e) {
        cfg = {};
    }

    const content = buildComprobanteHtml(sesion, {
        nombreSalon: cfg.nombreSalon || 'Salón de Billar',
        pieComprobante: cfg.pieComprobante || '',
    });

    const footer = `
        <button type="button" class="btn btn--secondary no-print" data-close>Cerrar</button>
        <button type="button" class="btn btn--primary no-print" id="btn-imprimir">🖨 Imprimir</button>`;

    const modal = openModal({ title: 'Comprobante de pago', content, footer, size: 'sm' });
    modal.root.querySelector('[data-close]').addEventListener('click', () => modal.close());
    modal.root.querySelector('#btn-imprimir').addEventListener('click', () => window.print());
    return modal;
}
