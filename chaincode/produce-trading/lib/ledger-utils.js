'use strict';

/**
 * Shared ledger utilities for AquaChain chaincodes.
 *
 * Design rules enforced here (see DESIGN_NOTES.md):
 *  - All money is integer minor units ("credits", e.g. kobo). No floats.
 *  - All energy is integer watt-hours (Wh).
 *  - Time comes ONLY from the transaction timestamp (deterministic across
 *    endorsing peers). Never use Date.now() in chaincode.
 *  - Asset IDs are client-supplied and validated, which keeps chaincode
 *    deterministic and makes Caliper workloads straightforward.
 */

const KEY = {
    farm: (farmId) => `farm:${farmId}`,
    balance: (farmId) => `bal:${farmId}`,
    config: (name) => `cfg:${name}`,
};

/** Deterministic tx time in epoch seconds (works for Long or number). */
function txTimeSeconds(ctx) {
    const ts = ctx.stub.getTxTimestamp();
    // fabric-shim may return protobuf Long for seconds
    if (ts.seconds && typeof ts.seconds.toNumber === 'function') {
        return ts.seconds.toNumber();
    }
    if (ts.seconds && typeof ts.seconds.low === 'number') {
        return ts.seconds.low;
    }
    return Number(ts.seconds);
}

function callerId(ctx) {
    return ctx.clientIdentity.getID();
}

function callerMsp(ctx) {
    return ctx.clientIdentity.getMSPID();
}

/** Parse a strictly non-negative integer from a chaincode string arg. */
function toInt(value, name) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new Error(`${name} must be a non-negative integer string, got: ${value}`);
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
        throw new Error(`${name} exceeds safe integer range`);
    }
    return n;
}

function requirePositive(n, name) {
    if (n <= 0) {
        throw new Error(`${name} must be > 0`);
    }
    return n;
}

async function getJSON(ctx, key) {
    const data = await ctx.stub.getState(key);
    if (!data || data.length === 0) {
        return null;
    }
    return JSON.parse(data.toString());
}

async function putJSON(ctx, key, obj) {
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(obj)));
}

async function mustGet(ctx, key, what) {
    const obj = await getJSON(ctx, key);
    if (!obj) {
        throw new Error(`${what} not found: ${key}`);
    }
    return obj;
}

async function mustNotExist(ctx, key, what) {
    const data = await ctx.stub.getState(key);
    if (data && data.length > 0) {
        throw new Error(`${what} already exists: ${key}`);
    }
}

/* ------------------------- farms & identity ------------------------- */

async function getFarm(ctx, farmId) {
    return mustGet(ctx, KEY.farm(farmId), 'Farm');
}

/** Caller must be the identity that registered farmId. */
async function requireFarmOwner(ctx, farmId) {
    const farm = await getFarm(ctx, farmId);
    if (farm.owner !== callerId(ctx)) {
        throw new Error(`Caller is not the registered owner of farm ${farmId}`);
    }
    return farm;
}

/* --------------------------- credit ledger --------------------------- */

async function getBalance(ctx, farmId) {
    const bal = await getJSON(ctx, KEY.balance(farmId));
    return bal || { farmId, available: 0, locked: 0 };
}

async function putBalance(ctx, bal) {
    await putJSON(ctx, KEY.balance(bal.farmId), bal);
}

/** Move `amount` from available -> locked. Throws if insufficient. */
async function lockCredits(ctx, farmId, amount) {
    const bal = await getBalance(ctx, farmId);
    if (bal.available < amount) {
        throw new Error(
            `Insufficient credits for ${farmId}: available=${bal.available}, required=${amount}`);
    }
    bal.available -= amount;
    bal.locked += amount;
    await putBalance(ctx, bal);
    return bal;
}

/**
 * Settle a lock of `lockedAmount` held by `buyerId`:
 * pay `paidAmount` to seller, refund the remainder to buyer.
 * Conservation: paid + refund === lockedAmount (integer math).
 */
async function settleLock(ctx, buyerId, sellerId, lockedAmount, paidAmount) {
    if (paidAmount < 0 || paidAmount > lockedAmount) {
        throw new Error(`Invalid settlement: paid=${paidAmount}, locked=${lockedAmount}`);
    }
    const refund = lockedAmount - paidAmount;

    const buyer = await getBalance(ctx, buyerId);
    if (buyer.locked < lockedAmount) {
        throw new Error(`Locked balance underflow for ${buyerId}`);
    }
    buyer.locked -= lockedAmount;
    buyer.available += refund;
    await putBalance(ctx, buyer);

    if (paidAmount > 0) {
        const seller = await getBalance(ctx, sellerId);
        seller.available += paidAmount;
        await putBalance(ctx, seller);
    }
    return { paid: paidAmount, refunded: refund };
}

module.exports = {
    KEY,
    txTimeSeconds,
    callerId,
    callerMsp,
    toInt,
    requirePositive,
    getJSON,
    putJSON,
    mustGet,
    mustNotExist,
    getFarm,
    requireFarmOwner,
    getBalance,
    putBalance,
    lockCredits,
    settleLock,
};
