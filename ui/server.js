'use strict';

/**
 * AquaChain UI server.
 *
 * A thin REST proxy between the browser and the Fabric Gateway SDK:
 *
 *   POST /api/invoke  { domain, identity, fn, args[] }  -> submitTransaction
 *   POST /api/query   { domain, identity, fn, args[] }  -> evaluateTransaction
 *   GET  /api/identities                                -> selectable identities
 *   GET  /api/overview/:domain                          -> registry IDs hydrated
 *                                                          with fresh ledger state
 *
 * This is a localhost demo/ops console: it deliberately exposes a generic
 * invoke endpoint and holds dev keys on disk. Do not expose it to a network
 * as-is — a production app would have per-user auth and scoped endpoints.
 */

const path = require('node:path');
const express = require('express');
const { IDENTITIES, getContract, closeAll } = require('./lib/fabric');
const registry = require('./lib/registry');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dec = new TextDecoder();

// Only functions the chaincodes actually expose can pass through.
const ALLOWED = {
    energy: new Set(['registerFarm', 'depositCredits', 'logEnergyProduction',
        'createOffer', 'acceptOffer', 'confirmDelivery', 'expireTrade',
        'getFarm', 'getBalance', 'getProduction', 'getOffer', 'getTrade']),
    produce: new Set(['registerFarm', 'depositCredits', 'updateWaterQuality',
        'createBatch', 'listBatch', 'purchaseBatch', 'confirmReceipt',
        'flagDispute', 'expireSale', 'resolveDispute',
        'getBatch', 'getBalance', 'getWaterQuality']),
};

function fabricErrorMessage(err) {
    // fabric-gateway errors carry per-peer details worth surfacing
    let msg = err.message || String(err);
    if (Array.isArray(err.details) && err.details.length) {
        msg += ' — ' + err.details.map(d => d.message).join(' | ');
    }
    return msg;
}

app.get('/api/identities', (_req, res) => {
    res.json(Object.entries(IDENTITIES).map(([key, d]) =>
        ({ key, label: d.label, mspId: d.mspId, role: d.role })));
});

app.post('/api/invoke', async (req, res) => {
    const { domain, identity, fn, args = [] } = req.body || {};
    try {
        if (!ALLOWED[domain] || !ALLOWED[domain].has(fn)) {
            throw new Error(`Function not allowed: ${domain}/${fn}`);
        }
        const contract = await getContract(identity, domain);
        const result = await contract.submitTransaction(fn, ...args.map(String));
        registry.record(domain, fn, args);
        const text = dec.decode(result);
        res.json({ ok: true, result: text ? JSON.parse(text) : null });
    } catch (err) {
        res.status(400).json({ ok: false, error: fabricErrorMessage(err) });
    }
});

app.post('/api/query', async (req, res) => {
    const { domain, identity, fn, args = [] } = req.body || {};
    try {
        if (!ALLOWED[domain] || !ALLOWED[domain].has(fn)) {
            throw new Error(`Function not allowed: ${domain}/${fn}`);
        }
        const contract = await getContract(identity, domain);
        const result = await contract.evaluateTransaction(fn, ...args.map(String));
        const text = dec.decode(result);
        res.json({ ok: true, result: text ? JSON.parse(text) : null });
    } catch (err) {
        res.status(400).json({ ok: false, error: fabricErrorMessage(err) });
    }
});

// Hydrate the registry's known IDs with fresh ledger state for the tables.
const READERS = {
    energy: [
        ['farms', 'getBalance'],
        ['productions', 'getProduction'],
        ['offers', 'getOffer'],
        ['trades', 'getTrade'],
    ],
    produce: [
        ['farms', 'getBalance'],
        ['batches', 'getBatch'],
    ],
};
const MAX_ROWS = 100; // hydrate at most the last N of each kind

app.get('/api/overview/:domain', async (req, res) => {
    const domain = req.params.domain;
    const identity = String(req.query.identity || 'ff-user1');
    if (!READERS[domain]) {
        return res.status(400).json({ ok: false, error: `Unknown domain ${domain}` });
    }
    try {
        const contract = await getContract(identity, domain);
        const ids = registry.get(domain);
        const out = {};
        for (const [kind, fn] of READERS[domain]) {
            const slice = ids[kind].slice(-MAX_ROWS);
            const rows = await Promise.all(slice.map(async (id) => {
                try {
                    const r = await contract.evaluateTransaction(fn, id);
                    return JSON.parse(dec.decode(r));
                } catch (err) {
                    return { id, _error: fabricErrorMessage(err) };
                }
            }));
            out[kind] = rows;
        }
        res.json({ ok: true, ...out });
    } catch (err) {
        res.status(400).json({ ok: false, error: fabricErrorMessage(err) });
    }
});

const server = app.listen(PORT, () => {
    console.log(`AquaChain UI on http://localhost:${PORT}`);
    console.log('Network material expected under:', require('./lib/fabric').ORG_ROOT);
});

process.on('SIGINT', () => {
    closeAll();
    server.close(() => process.exit(0));
});
