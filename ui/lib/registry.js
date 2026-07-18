'use strict';

/**
 * A tiny on-disk index of asset IDs created through this UI.
 *
 * Why it exists: the chaincodes expose key-based reads (getOffer, getTrade,
 * getBatch, ...) but no "list all" functions — listing on-chain would need
 * range-query functions and a chaincode upgrade (see ui/README.md for that
 * optional path). The registry only stores IDs; every displayed field is
 * fetched fresh from the ledger, so the blockchain remains the source of
 * truth. Deleting data/registry.json just makes the UI forget what to show.
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'registry.json');

const EMPTY = () => ({
    energy: { farms: [], productions: [], offers: [], trades: [] },
    produce: { farms: [], batches: [] },
});

let state = EMPTY();

function load() {
    try {
        state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        state = EMPTY();
    }
}

function save() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

function push(domain, kind, id) {
    const list = state[domain][kind];
    if (!list.includes(id)) {
        list.push(id);
        save();
    }
}

/** Record IDs from a successful invoke so the UI can list them later. */
function record(domain, fn, args) {
    if (domain === 'energy') {
        if (fn === 'registerFarm') { push('energy', 'farms', args[0]); }
        if (fn === 'logEnergyProduction') { push('energy', 'productions', args[0]); }
        if (fn === 'createOffer') { push('energy', 'offers', args[0]); }
        if (fn === 'acceptOffer') { push('energy', 'trades', args[0]); }
    } else if (domain === 'produce') {
        if (fn === 'registerFarm') { push('produce', 'farms', args[0]); }
        if (fn === 'createBatch') { push('produce', 'batches', args[0]); }
    }
}

function get(domain) {
    return state[domain];
}

load();

module.exports = { record, get };
