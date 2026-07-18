'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

const FARMERS_MSP = 'FishFarmersMSP';

/**
 * Shared plumbing for AquaChain workload modules.
 *
 * Key ideas:
 *  - Every asset ID is namespaced by round + worker index so rounds never
 *    collide: e.g. "r2w0_s3" (round 2, worker 0, seller farm 3).
 *  - Prerequisite state (farms, deposits, productions, offers, batches) is
 *    created in initializeWorkloadModule via un-measured setup requests.
 *  - Buyer/seller farms per worker are configurable (roundArguments.farms).
 *    More farms = fewer MVCC read conflicts on hot balance keys. This is
 *    an intentional, reportable experimental axis (see DESIGN_NOTES.md).
 */
class AquaBase extends WorkloadModuleBase {
    constructor() {
        super();
        this.txIndex = 0;
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
        roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers,
            roundIndex, roundArguments, sutAdapter, sutContext);
        this.prefix = `r${roundIndex}w${workerIndex}`;
        this.farms = Number(roundArguments.farms || 25);
        // Per-worker share of the round's transactions, with headroom.
        this.prealloc = Number(roundArguments.prealloc || 0);
        this.contractId = roundArguments.contractId; // set per benchmark file
    }

    sellerFarm(i) { return `${this.prefix}_s${i % this.farms}`; }
    buyerFarm(i) { return `${this.prefix}_b${i % this.farms}`; }

    /** Send setup (un-measured) requests in batches to avoid overload. */
    async setupBatch(requests, batchSize = 50) {
        for (let i = 0; i < requests.length; i += batchSize) {
            await this.sutAdapter.sendRequests(requests.slice(i, i + batchSize));
        }
    }

    invokeAsFarmer(contractFunction, contractArguments, readOnly = false) {
        return {
            contractId: this.contractId,
            contractFunction,
            contractArguments,
            invokerIdentity: 'User1',
            invokerMspId: FARMERS_MSP,
            readOnly,
        };
    }

    invokeAsSettlement(settlementMsp, contractFunction, contractArguments) {
        return {
            contractId: this.contractId,
            contractFunction,
            contractArguments,
            invokerIdentity: 'User1',
            invokerMspId: settlementMsp,
            readOnly: false,
        };
    }

    /** Register `count` seller and/or buyer farms owned by FishFarmers User1. */
    async registerFarms({ sellers = 0, buyers = 0 }) {
        const reqs = [];
        for (let i = 0; i < sellers; i++) {
            reqs.push(this.invokeAsFarmer('registerFarm', [this.sellerFarm(i)]));
        }
        for (let i = 0; i < buyers; i++) {
            reqs.push(this.invokeAsFarmer('registerFarm', [this.buyerFarm(i)]));
        }
        await this.setupBatch(reqs);
    }

    /** Top up every buyer farm with a large balance via the settlement org. */
    async fundBuyers(settlementMsp, amount = '1000000000') {
        const reqs = [];
        for (let i = 0; i < this.farms; i++) {
            reqs.push(this.invokeAsSettlement(settlementMsp, 'depositCredits',
                [this.buyerFarm(i), amount]));
        }
        await this.setupBatch(reqs);
    }
}

module.exports = { AquaBase, FARMERS_MSP };
