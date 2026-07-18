'use strict';

const { Contract } = require('fabric-contract-api');
const U = require('./ledger-utils');

/**
 * EnergyTradingContract — implements the manuscript's Section 3.4 lifecycle:
 *
 *   logEnergyProduction -> createOffer -> acceptOffer (credits locked)
 *   -> confirmDelivery (full or partial settlement, Eq. 4-6)
 *   -> expireTrade (timeout, credits refunded)
 *
 * Units: energy in Wh (integer), price in credit minor-units per kWh
 * (integer), credits in minor units (integer).
 *
 * MSP of the cooperative administrator (may mint/deposit credits and act
 * as arbiter). On energychannel this is the EnergyProvider organization.
 */
const SETTLEMENT_MSP = 'EnergyProviderMSP';

/** Default trade timeout: 24 h (manuscript Step 6). Overridable per-trade for testing. */
const DEFAULT_TIMEOUT_SECS = 24 * 60 * 60;

const K = {
    production: (id) => `prod:${id}`,
    offer: (id) => `offer:${id}`,
    trade: (id) => `trade:${id}`,
};

class EnergyTradingContract extends Contract {
    constructor() {
        super('EnergyTradingContract');
    }

    /* ------------------------- registration ------------------------- */

    /**
     * Bind the calling client identity to a farm ID. All subsequent
     * farm-scoped calls check this binding (farm-level authorization is
     * enforced in chaincode because farms are client identities within
     * FishFarmersMSP, not separate Fabric organizations).
     */
    async registerFarm(ctx, farmId) {
        if (!farmId) { throw new Error('farmId required'); }
        await U.mustNotExist(ctx, U.KEY.farm(farmId), 'Farm');
        const farm = {
            docType: 'farm',
            farmId,
            owner: U.callerId(ctx),
            msp: U.callerMsp(ctx),
            registeredAt: U.txTimeSeconds(ctx),
        };
        await U.putJSON(ctx, U.KEY.farm(farmId), farm);
        return JSON.stringify(farm);
    }

    /**
     * Credit top-up reflecting an off-chain bank transfer (manuscript 3.3).
     * Restricted to the cooperative administrator organization.
     */
    async depositCredits(ctx, farmId, amount) {
        if (U.callerMsp(ctx) !== SETTLEMENT_MSP) {
            throw new Error(`depositCredits is restricted to ${SETTLEMENT_MSP}`);
        }
        const amt = U.requirePositive(U.toInt(amount, 'amount'), 'amount');
        await U.getFarm(ctx, farmId); // must exist
        const bal = await U.getBalance(ctx, farmId);
        bal.available += amt;
        await U.putBalance(ctx, bal);
        return JSON.stringify(bal);
    }

    /* --------------------- Step 1: log production --------------------- */

    async logEnergyProduction(ctx, productionId, farmId, wh) {
        const farm = await U.requireFarmOwner(ctx, farmId);
        const energyWh = U.requirePositive(U.toInt(wh, 'wh'), 'wh');
        await U.mustNotExist(ctx, K.production(productionId), 'Production');
        const prod = {
            docType: 'production',
            productionId,
            farmId: farm.farmId,
            totalWh: energyWh,
            remainingWh: energyWh,
            loggedAt: U.txTimeSeconds(ctx),
        };
        await U.putJSON(ctx, K.production(productionId), prod);
        return JSON.stringify(prod);
    }

    /* ----------------------- Step 2: make offer ----------------------- */

    async createOffer(ctx, offerId, productionId, quantityWh, pricePerKwh) {
        const qty = U.requirePositive(U.toInt(quantityWh, 'quantityWh'), 'quantityWh');
        const price = U.requirePositive(U.toInt(pricePerKwh, 'pricePerKwh'), 'pricePerKwh');
        await U.mustNotExist(ctx, K.offer(offerId), 'Offer');

        const prod = await U.mustGet(ctx, K.production(productionId), 'Production');
        await U.requireFarmOwner(ctx, prod.farmId);
        if (prod.remainingWh < qty) {
            throw new Error(
                `Offered quantity ${qty} Wh exceeds remaining surplus ${prod.remainingWh} Wh`);
        }
        prod.remainingWh -= qty;
        await U.putJSON(ctx, K.production(productionId), prod);

        const offer = {
            docType: 'offer',
            offerId,
            productionId,
            sellerFarmId: prod.farmId,
            remainingWh: qty,
            pricePerKwh: price,
            status: 'OPEN',
            createdAt: U.txTimeSeconds(ctx),
        };
        await U.putJSON(ctx, K.offer(offerId), offer);
        return JSON.stringify(offer);
    }

    /* ---------------------- Step 3: accept offer ---------------------- */

    /**
     * Buyer accepts (part of) an offer. Credits worth qty*price are locked
     * in escrow and a trade asset is created with status IN_PROGRESS.
     * `timeoutSecs` is optional (defaults to 24 h).
     */
    async acceptOffer(ctx, tradeId, offerId, buyerFarmId, requestedWh, timeoutSecs) {
        const qty = U.requirePositive(U.toInt(requestedWh, 'requestedWh'), 'requestedWh');
        await U.mustNotExist(ctx, K.trade(tradeId), 'Trade');
        await U.requireFarmOwner(ctx, buyerFarmId);

        const offer = await U.mustGet(ctx, K.offer(offerId), 'Offer');
        if (offer.status !== 'OPEN') {
            throw new Error(`Offer ${offerId} is not OPEN (status=${offer.status})`);
        }
        if (offer.sellerFarmId === buyerFarmId) {
            throw new Error('Buyer and seller farm must differ');
        }
        if (offer.remainingWh < qty) {
            throw new Error(
                `Requested ${qty} Wh exceeds offer remaining ${offer.remainingWh} Wh`);
        }

        // total credits = qty(Wh) * price(per kWh) / 1000, floor to integer
        const lockedAmount = Math.floor((qty * offer.pricePerKwh) / 1000);
        U.requirePositive(lockedAmount, 'computed trade value');

        await U.lockCredits(ctx, buyerFarmId, lockedAmount);

        offer.remainingWh -= qty;
        if (offer.remainingWh === 0) {
            offer.status = 'FILLED';
        }
        await U.putJSON(ctx, K.offer(offerId), offer);

        const now = U.txTimeSeconds(ctx);
        const timeout = timeoutSecs !== undefined && timeoutSecs !== ''
            ? U.requirePositive(U.toInt(timeoutSecs, 'timeoutSecs'), 'timeoutSecs')
            : DEFAULT_TIMEOUT_SECS;

        const trade = {
            docType: 'trade',
            tradeId,
            offerId,
            sellerFarmId: offer.sellerFarmId,
            buyerFarmId,
            quantityWh: qty,
            pricePerKwh: offer.pricePerKwh,
            lockedAmount,
            status: 'IN_PROGRESS',
            createdAt: now,
            deadline: now + timeout,
        };
        await U.putJSON(ctx, K.trade(tradeId), trade);
        ctx.stub.setEvent('TradeAccepted', Buffer.from(JSON.stringify(trade)));
        return JSON.stringify(trade);
    }

    /* ------------------- Step 5: delivery confirm ------------------- */

    /**
     * Called by the buyer's metering pipeline with the measured received
     * energy. Implements Eq. (4)-(6): alpha = min(received/requested, 1);
     * seller receives floor(alpha * locked); buyer refunded the rest.
     */
    async confirmDelivery(ctx, tradeId, receivedWh) {
        const received = U.toInt(receivedWh, 'receivedWh');
        const trade = await U.mustGet(ctx, K.trade(tradeId), 'Trade');
        if (trade.status !== 'IN_PROGRESS') {
            throw new Error(`Trade ${tradeId} is not IN_PROGRESS (status=${trade.status})`);
        }
        // Only the buyer's identity (its metering middleware) may confirm.
        await U.requireFarmOwner(ctx, trade.buyerFarmId);

        const effectiveWh = Math.min(received, trade.quantityWh);
        const paid = Math.floor((trade.lockedAmount * effectiveWh) / trade.quantityWh);
        const result = await U.settleLock(
            ctx, trade.buyerFarmId, trade.sellerFarmId, trade.lockedAmount, paid);

        trade.receivedWh = received;
        trade.paidAmount = result.paid;
        trade.refundedAmount = result.refunded;
        trade.settledAt = U.txTimeSeconds(ctx);
        trade.status = effectiveWh === trade.quantityWh
            ? 'SETTLED'
            : (effectiveWh > 0 ? 'PARTIALLY_SETTLED' : 'EXPIRED');
        await U.putJSON(ctx, K.trade(tradeId), trade);
        ctx.stub.setEvent('TradeSettled', Buffer.from(JSON.stringify(trade)));
        return JSON.stringify(trade);
    }

    /* ------------------------ Step 6: timeout ------------------------ */

    /**
     * Anyone may invoke after the deadline; the chaincode enforces the
     * deadline against the deterministic tx timestamp. (Fabric has no
     * scheduler, so expiry must be triggered by an external client —
     * see DESIGN_NOTES.md.)
     */
    async expireTrade(ctx, tradeId) {
        const trade = await U.mustGet(ctx, K.trade(tradeId), 'Trade');
        if (trade.status !== 'IN_PROGRESS') {
            throw new Error(`Trade ${tradeId} is not IN_PROGRESS (status=${trade.status})`);
        }
        const now = U.txTimeSeconds(ctx);
        if (now < trade.deadline) {
            throw new Error(
                `Trade ${tradeId} deadline not reached (now=${now}, deadline=${trade.deadline})`);
        }
        const result = await U.settleLock(
            ctx, trade.buyerFarmId, trade.sellerFarmId, trade.lockedAmount, 0);
        trade.status = 'EXPIRED';
        trade.refundedAmount = result.refunded;
        trade.settledAt = now;
        await U.putJSON(ctx, K.trade(tradeId), trade);
        ctx.stub.setEvent('TradeExpired', Buffer.from(JSON.stringify(trade)));
        return JSON.stringify(trade);
    }

    /* --------------------------- queries --------------------------- */

    async getFarm(ctx, farmId) {
        return JSON.stringify(await U.getFarm(ctx, farmId));
    }

    async getBalance(ctx, farmId) {
        return JSON.stringify(await U.getBalance(ctx, farmId));
    }

    async getProduction(ctx, productionId) {
        return JSON.stringify(await U.mustGet(ctx, K.production(productionId), 'Production'));
    }

    async getOffer(ctx, offerId) {
        return JSON.stringify(await U.mustGet(ctx, K.offer(offerId), 'Offer'));
    }

    async getTrade(ctx, tradeId) {
        return JSON.stringify(await U.mustGet(ctx, K.trade(tradeId), 'Trade'));
    }
}

module.exports = EnergyTradingContract;
