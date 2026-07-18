'use strict';

/* AquaChain console frontend — vanilla JS, no build step. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
    identity: localStorage.getItem('aq-identity') || 'ff-user1',
    tab: 'energy',
    timer: null,
};

/* ---------------- API helpers ---------------- */

async function api(path, body) {
    const res = await fetch(path, body ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    } : undefined);
    const data = await res.json();
    if (!data.ok) { throw new Error(data.error || 'Request failed'); }
    return data;
}

function invoke(domain, fn, args) {
    return api('/api/invoke', { domain, fn, args, identity: state.identity });
}

/* ---------------- activity log ---------------- */

function log(kind, text) {
    const li = document.createElement('li');
    li.className = kind;
    const t = new Date().toTimeString().slice(0, 8);
    li.innerHTML = `<time>${t}</time>${escapeHtml(text)}`;
    $('#log').prepend(li);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- identities ---------------- */

async function loadIdentities() {
    const list = await (await fetch('/api/identities')).json();
    const sel = $('#identity');
    sel.innerHTML = list.map((i) =>
        `<option value="${i.key}">${escapeHtml(i.label)}</option>`).join('');
    sel.value = state.identity;
    sel.addEventListener('change', () => {
        state.identity = sel.value;
        localStorage.setItem('aq-identity', sel.value);
        log('ok', `Now acting as ${sel.selectedOptions[0].text}`);
    });
}

/* ---------------- forms ---------------- */

function wireForms() {
    $$('form.card').forEach((form) => {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const domain = form.dataset.domain;
            const fn = form.dataset.fn;
            const args = Array.from(form.querySelectorAll('[name]'))
                .map((el) => el.value.trim());
            const btn = form.querySelector('button');
            btn.disabled = true;
            try {
                const { result } = await invoke(domain, fn, args);
                log('ok', `${fn}(${args.filter(Boolean).join(', ')}) ✓` +
                    (result && result.status ? ` → ${result.status}` : ''));
                regenIds(form);
                refresh();
            } catch (err) {
                log('err', `${fn}: ${err.message}`);
            } finally {
                btn.disabled = false;
            }
        });
    });
    $$('input[data-autogen]').forEach((el) => { if (!el.value) autogen(el); });
}

function autogen(el) {
    el.value = `${el.dataset.autogen}-${Date.now().toString(36).slice(-6)}`;
}
function regenIds(form) {
    form.querySelectorAll('input[data-autogen]').forEach(autogen);
}

/* ---------------- tables ---------------- */

const fmt = new Intl.NumberFormat('en-NG');
const chip = (s) => `<span class="chip ${escapeHtml(s || '')}">${escapeHtml(s || '—')}</span>`;
const mono = (s) => `<span class="mono">${escapeHtml(s ?? '')}</span>`;

function rows(tbody, items, render, cols) {
    if (!items || !items.length) {
        tbody.innerHTML = `<tr><td class="empty" colspan="${cols}">Nothing yet — actions you take will appear here.</td></tr>`;
        return;
    }
    tbody.innerHTML = items.map(render).join('');
}

async function refresh() {
    const domain = state.tab;
    try {
        const data = await api(`/api/overview/${domain}?identity=${state.identity}`);
        $('#conn').className = 'conn-dot ok';
        if (domain === 'energy') { renderEnergy(data); } else { renderProduce(data); }
    } catch (err) {
        $('#conn').className = 'conn-dot err';
        log('err', `refresh: ${err.message}`);
    }
}

function renderEnergy(d) {
    rows($('#tbl-energy-farms tbody'), d.farms, (b) => `
        <tr><td>${mono(b.farmId)}</td>
        <td class="num">${fmt.format(b.available)}</td>
        <td class="num">${fmt.format(b.locked)}</td></tr>`, 3);

    rows($('#tbl-energy-productions tbody'), d.productions, (p) => `
        <tr><td>${mono(p.productionId || p.id)}</td>
        <td>${mono(p.farmId || '')}</td>
        <td class="num">${p.totalWh != null ? fmt.format(p.totalWh) : '—'}</td>
        <td class="num">${p.remainingWh != null ? fmt.format(p.remainingWh) : '—'}</td></tr>`, 4);

    rows($('#tbl-energy-offers tbody'), d.offers, (o) => `
        <tr><td>${mono(o.offerId || o.id)}</td>
        <td>${mono(o.sellerFarmId || '')}</td>
        <td class="num">${o.remainingWh != null ? fmt.format(o.remainingWh) : '—'}</td>
        <td class="num">${o.pricePerKwh != null ? fmt.format(o.pricePerKwh) : '—'}</td>
        <td>${chip(o.status)}</td>
        <td>${o.status === 'OPEN'
            ? `<button class="btn btn-row" data-act="prefill-accept" data-id="${escapeHtml(o.offerId)}" data-qty="${o.remainingWh}">Accept…</button>`
            : ''}</td></tr>`, 6);

    rows($('#tbl-energy-trades tbody'), d.trades, (t) => `
        <tr><td>${mono(t.tradeId || t.id)}</td>
        <td>${mono(`${t.sellerFarmId || ''} → ${t.buyerFarmId || ''}`)}</td>
        <td class="num">${t.quantityWh != null ? fmt.format(t.quantityWh) : '—'}</td>
        <td class="num">${t.lockedAmount != null ? fmt.format(t.lockedAmount) : '—'}</td>
        <td>${chip(t.status)}</td>
        <td>${t.status === 'IN_PROGRESS' ? `
            <button class="btn btn-row" data-act="prefill-confirm" data-id="${escapeHtml(t.tradeId)}" data-qty="${t.quantityWh}">Confirm…</button>
            <button class="btn btn-row" data-act="expire-trade" data-id="${escapeHtml(t.tradeId)}">Expire</button>` : ''}</td></tr>`, 6);
}

function renderProduce(d) {
    rows($('#tbl-produce-farms tbody'), d.farms, (b) => `
        <tr><td>${mono(b.farmId)}</td>
        <td class="num">${fmt.format(b.available)}</td>
        <td class="num">${fmt.format(b.locked)}</td></tr>`, 3);

    rows($('#tbl-produce-batches tbody'), d.batches, (b) => {
        const wq = b.waterQualityAtHarvest
            ? `pH ${(b.waterQualityAtHarvest.phX100 / 100).toFixed(2)} · ${(b.waterQualityAtHarvest.tempCX100 / 100).toFixed(1)}°C · DO ${(b.waterQualityAtHarvest.dissolvedOxygenX100 / 100).toFixed(1)}`
            : '—';
        let actions = '';
        if (b.status === 'CREATED') {
            actions = `<button class="btn btn-row" data-act="prefill-list" data-id="${escapeHtml(b.batchId)}">List…</button>`;
        } else if (b.status === 'LISTED') {
            actions = `<button class="btn btn-row" data-act="prefill-buy" data-id="${escapeHtml(b.batchId)}">Buy…</button>`;
        } else if (b.status === 'PENDING_DELIVERY') {
            actions = `<button class="btn btn-row" data-act="confirm-receipt" data-id="${escapeHtml(b.batchId)}">Receive</button>
                       <button class="btn btn-row" data-act="prefill-dispute" data-id="${escapeHtml(b.batchId)}">Dispute…</button>`;
        } else if (b.status === 'DISPUTED') {
            actions = `<button class="btn btn-row" data-act="prefill-resolve" data-id="${escapeHtml(b.batchId)}">Resolve…</button>`;
        }
        return `
        <tr><td>${mono(b.batchId || b.id)}</td>
        <td>${escapeHtml(b.species || '')}</td>
        <td>${mono(b.ownerFarmId || '')}</td>
        <td class="num">${b.weightGrams != null ? fmt.format(b.weightGrams) : '—'}</td>
        <td class="num">${b.askingPrice != null ? fmt.format(b.askingPrice) : '—'}</td>
        <td>${wq}</td>
        <td>${chip(b.status)}</td>
        <td>${actions}</td></tr>`;
    }, 8);
}

/* ---------------- row actions ---------------- */

function wireRowActions() {
    document.body.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) { return; }
        const id = btn.dataset.id;
        const act = btn.dataset.act;

        const prefill = (formSel, fields) => {
            const form = $(formSel);
            Object.entries(fields).forEach(([name, val]) => {
                const input = form.querySelector(`[name="${name}"]`);
                if (input) { input.value = val; }
            });
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
            form.querySelector('input:not([type=hidden])').focus();
        };

        try {
            if (act === 'prefill-accept') {
                prefill('#form-accept', { offerId: id, requestedWh: btn.dataset.qty });
            } else if (act === 'prefill-confirm') {
                prefill('#form-confirm', { tradeId: id, receivedWh: btn.dataset.qty });
            } else if (act === 'expire-trade') {
                btn.disabled = true;
                await invoke('energy', 'expireTrade', [id]);
                log('ok', `expireTrade(${id}) ✓`);
                refresh();
            } else if (act === 'prefill-list') {
                prefill('#form-list', { batchId: id });
            } else if (act === 'prefill-buy') {
                prefill('#form-buy', { batchId: id });
            } else if (act === 'confirm-receipt') {
                btn.disabled = true;
                await invoke('produce', 'confirmReceipt', [id]);
                log('ok', `confirmReceipt(${id}) ✓`);
                refresh();
            } else if (act === 'prefill-dispute') {
                prefill('#form-dispute', { batchId: id });
            } else if (act === 'prefill-resolve') {
                prefill('#form-resolve', { batchId: id });
            }
        } catch (err) {
            log('err', `${act}: ${err.message}`);
            refresh();
        }
    });
}

/* ---------------- tabs & lifecycle ---------------- */

function wireTabs() {
    $$('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            $$('.tab').forEach((t) => t.classList.remove('active'));
            $$('.tab-panel').forEach((p) => p.classList.remove('active'));
            tab.classList.add('active');
            state.tab = tab.dataset.tab;
            $(`#tab-${state.tab}`).classList.add('active');
            refresh();
        });
    });
}

async function main() {
    await loadIdentities();
    wireForms();
    wireTabs();
    wireRowActions();
    $('#refresh').addEventListener('click', refresh);
    $('#clear-log').addEventListener('click', () => { $('#log').innerHTML = ''; });
    await refresh();
    state.timer = setInterval(refresh, 8000);
    log('ok', 'Console ready. Select an identity and register a farm to begin.');
}

main().catch((err) => log('err', err.message));
