'use strict';

const { Contract } = require('fabric-contract-api');
const U = require('./ledger-utils');

/**
 * ProduceTradingContract — implements the manuscript's Section 3.5 lifecycle:
 *
 *   updateWaterQuality (IoT) -> createBatch (attaches latest readings)
 *   -> listBatch -> purchaseBatch (credits locked, PENDING_DELIVERY)
 *   -> confirmReceipt (COMPLETED) | flagDispute (DISPUTED)
 *   -> expireSale (timeout -> DISPUTED) -> resolveDispute (arbiter)
 *
 * Units: weight in grams (integer), water-quality values scaled x100
 * (integers, e.g. pH 7.25 -> 725), credits in minor units (integer).
 *
 * On producechannel the cooperative administrator / arbiter organization
 * is FishProcessors.
 */
const SETTLEMENT_MSP = 'FishProcessorsMSP';

/** Default receipt timeout: 48 h (manuscript Step 6). */
const DEFAULT_TIMEOUT_SECS = 48 * 60 * 60;

const K = {
    batch: (id) => `batch:${id}`,
    waterQuality: (farmId) => `wq:${farmId}`,
};

class ProduceTradingContract extends Contract {
    constructor() {
        super('ProduceTradingContract');
    }

    /* ------------------------- registration ------------------------- */

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

    async depositCredits(ctx, farmId, amount) {
        if (U.callerMsp(ctx) !== SETTLEMENT_MSP) {
            throw new Error(`depositCredits is restricted to ${SETTLEMENT_MSP}`);
        }
        const amt = U.requirePositive(U.toInt(amount, 'amount'), 'amount');
        await U.getFarm(ctx, farmId);
        const bal = await U.getBalance(ctx, farmId);
        bal.available += amt;
        await U.putBalance(ctx, bal);
        return JSON.stringify(bal);
    }

    /* ------------------------ IoT water quality ------------------------ */

    /**
     * Middleware writes the latest sensor snapshot for a farm. Values are
     * integers scaled x100 to keep chaincode free of floating point.
     */
    async updateWaterQuality(ctx, farmId, phX100, tempCX100, dissolvedOxygenX100) {
        await U.requireFarmOwner(ctx, farmId);
        const reading = {
            docType: 'waterQuality',
            farmId,
            phX100: U.toInt(phX100, 'phX100'),
            tempCX100: U.toInt(tempCX100, 'tempCX100'),
            dissolvedOxygenX100: U.toInt(dissolvedOxygenX100, 'dissolvedOxygenX100'),
            recordedAt: U.txTimeSeconds(ctx),
        };
        await U.putJSON(ctx, K.waterQuality(farmId), reading);
        return JSON.stringify(reading);
    }

    /* ----------------------- Step 1: create batch ----------------------- */

    /**
     * Creates a harvest batch and attaches the farm's most recent on-chain
     * water-quality snapshot as provenance metadata (manuscript Step 1).
     */
    async createBatch(ctx, batchId, farmId, species, weightGrams) {
        await U.requireFarmOwner(ctx, farmId);
        await U.mustNotExist(ctx, K.batch(batchId), 'Batch');
        const weight = U.requirePositive(U.toInt(weightGrams, 'weightGrams'), 'weightGrams');

        const wq = await U.getJSON(ctx, K.waterQuality(farmId)); // may be null

        const batch = {
            docType: 'batch',
            batchId,
            species,
            weightGrams: weight,
            harvestedAt: U.txTimeSeconds(ctx),
            ownerFarmId: farmId,
            producerFarmId: farmId,
            waterQualityAtHarvest: wq,
            status: 'CREATED',
        };
        await U.putJSON(ctx, K.batch(batchId), batch);
        return JSON.stringify(batch);
    }

    /* ----------------------- Step 2: list batch ----------------------- */

    async listBatch(ctx, batchId, askingPrice) {
        const price = U.requirePositive(U.toInt(askingPrice, 'askingPrice'), 'askingPrice');
        const batch = await U.mustGet(ctx, K.batch(batchId), 'Batch');
        await U.requireFarmOwner(ctx, batch.ownerFarmId);
        if (batch.status !== 'CREATED') {
            throw new Error(`Batch ${batchId} cannot be listed (status=${batch.status})`);
        }
        batch.status = 'LISTED';
        batch.askingPrice = price;
        await U.putJSON(ctx, K.batch(batchId), batch);
        return JSON.stringify(batch);
    }

    /* ------------------------ Step 3: purchase ------------------------ */

    async purchaseBatch(ctx, batchId, buyerFarmId, timeoutSecs) {
        const batch = await U.mustGet(ctx, K.batch(batchId), 'Batch');
        await U.requireFarmOwner(ctx, buyerFarmId);
        if (batch.status !== 'LISTED') {
            throw new Error(`Batch ${batchId} is not LISTED (status=${batch.status})`);
        }
        if (batch.ownerFarmId === buyerFarmId) {
            throw new Error('Buyer must differ from current owner');
        }

        await U.lockCredits(ctx, buyerFarmId, batch.askingPrice);

        const now = U.txTimeSeconds(ctx);
        const timeout = timeoutSecs !== undefined && timeoutSecs !== ''
            ? U.requirePositive(U.toInt(timeoutSecs, 'timeoutSecs'), 'timeoutSecs')
            : DEFAULT_TIMEOUT_SECS;

        batch.status = 'PENDING_DELIVERY';
        batch.buyerFarmId = buyerFarmId;
        batch.lockedAmount = batch.askingPrice;
        batch.purchasedAt = now;
        batch.deadline = now + timeout;
        await U.putJSON(ctx, K.batch(batchId), batch);
        ctx.stub.setEvent('BatchPurchased', Buffer.from(JSON.stringify(batch)));
        return JSON.stringify(batch);
    }

    /* --------------------- Step 5: confirm receipt --------------------- */

    async confirmReceipt(ctx, batchId) {
        const batch = await U.mustGet(ctx, K.batch(batchId), 'Batch');
        if (batch.status !== 'PENDING_DELIVERY') {
            throw new Error(`Batch ${batchId} is not PENDING_DELIVERY (status=${batch.status})`);
        }
        await U.requireFarmOwner(ctx, batch.buyerFarmId);

        const sellerFarmId = batch.ownerFarmId;
        await U.settleLock(ctx, batch.buyerFarmId, sellerFarmId,
            batch.lockedAmount, batch.lockedAmount);

        batch.status = 'COMPLETED';
        batch.previousOwnerFarmId = sellerFarmId;
        batch.ownerFarmId = batch.buyerFarmId;
        batch.completedAt = U.txTimeSeconds(ctx);
        await U.putJSON(ctx, K.batch(batchId), batch);
        ctx.stub.setEvent('BatchCompleted', Buffer.from(JSON.stringify(batch)));
        return JSON.stringify(batch);
    }

    /* --------------------- Step 6: dispute / timeout --------------------- */

    async flagDispute(ctx, batchId, reason) {
        const batch = await U.mustGet(ctx, K.batch(batchId), 'Batch');
        if (batch.status !== 'PENDING_DELIVERY') {
            throw new Error(`Batch ${batchId} is not PENDING_DELIVERY (status=${batch.status})`);
        }
        await U.requireFarmOwner(ctx, batch.buyerFarmId);
        batch.status = 'DISPUTED';
        batch.disputeReason = reason || 'unspecified';
        batch.disputedAt = U.txTimeSeconds(ctx);
        await U.putJSON(ctx, K.batch(batchId), batch);
        ctx.stub.setEvent('BatchDisputed', Buffer.from(JSON.stringify(batch)));
        return JSON.stringify(batch);
    }

    /**
     * After the 48 h deadline, anyone may flag the sale for dispute
     * (manuscript Step 6: "the transaction is flagged for dispute").
     * Credits remain locked until the arbiter resolves.
     */
    async expireSale(ctx, batchId) {
        const batch = await U.mustGet(ctx, K.batch(batchId), 'Batch');
        if (batch.status !== 'PENDING_DELIVERY') {
            throw new Error(`Batch ${batchId} is not PENDING_DELIVERY (status=${batch.status})`);
        }
        const now = U.txTimeSeconds(ctx);
        if (now < batch.deadline) {
            throw new Error(
                `Batch ${batchId} deadline not reached (now=${now}, deadline=${batch.deadline})`);
        }
        batch.status = 'DISPUTED';
        batch.disputeReason = 'receipt timeout';
        batch.disputedAt = now;
        await U.putJSON(ctx, K.batch(batchId), batch);
        ctx.stub.setEvent('BatchDisputed', Buffer.from(JSON.stringify(batch)));
        return JSON.stringify(batch);
    }

    /**
     * Arbiter (FishProcessors org) splits the escrow: `buyerRefundPct`
     * percent (0-100) returns to the buyer, remainder pays the seller.
     * Ownership transfers to the buyer iff the seller is paid anything.
     */
    async resolveDispute(ctx, batchId, buyerRefundPct) {
        if (U.callerMsp(ctx) !== SETTLEMENT_MSP) {
            throw new Error(`resolveDispute is restricted to ${SETTLEMENT_MSP}`);
        }
        const pct = U.toInt(buyerRefundPct, 'buyerRefundPct');
        if (pct > 100) { throw new Error('buyerRefundPct must be 0-100'); }

        const batch = await U.mustGet(ctx, K.batch(batchId), 'Batch');
        if (batch.status !== 'DISPUTED') {
            throw new Error(`Batch ${batchId} is not DISPUTED (status=${batch.status})`);
        }
        const refund = Math.floor((batch.lockedAmount * pct) / 100);
        const paid = batch.lockedAmount - refund;
        const sellerFarmId = batch.ownerFarmId;
        await U.settleLock(ctx, batch.buyerFarmId, sellerFarmId, batch.lockedAmount, paid);

        batch.status = 'RESOLVED';
        batch.resolution = { buyerRefund: refund, sellerPaid: paid };
        batch.resolvedAt = U.txTimeSeconds(ctx);
        if (paid > 0) {
            batch.previousOwnerFarmId = sellerFarmId;
            batch.ownerFarmId = batch.buyerFarmId;
        }
        await U.putJSON(ctx, K.batch(batchId), batch);
        ctx.stub.setEvent('BatchResolved', Buffer.from(JSON.stringify(batch)));
        return JSON.stringify(batch);
    }

    /* --------------------------- queries --------------------------- */

    async getBatch(ctx, batchId) {
        return JSON.stringify(await U.mustGet(ctx, K.batch(batchId), 'Batch'));
    }

    async getBalance(ctx, farmId) {
        return JSON.stringify(await U.getBalance(ctx, farmId));
    }

    async getWaterQuality(ctx, farmId) {
        const wq = await U.getJSON(ctx, K.waterQuality(farmId));
        return JSON.stringify(wq);
    }
}

module.exports = ProduceTradingContract;
