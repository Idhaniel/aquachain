'use strict';
const { AquaBase } = require('./lib/aqua-base');

/**
 * Measures purchaseBatch throughput: escrow lock against buyer balances.
 * Each measured tx purchases its OWN pre-created, listed batch.
 */
class PurchaseBatch extends AquaBase {
    async initializeWorkloadModule(...args) {
        await super.initializeWorkloadModule(...args);
        if (!this.prealloc) { throw new Error('roundArguments.prealloc required'); }
        await this.registerFarms({ sellers: this.farms, buyers: this.farms });
        await this.fundBuyers('FishProcessorsMSP');
        const wq = [];
        for (let i = 0; i < this.farms; i++) {
            wq.push(this.invokeAsFarmer('updateWaterQuality',
                [this.sellerFarm(i), '725', '2850', '680']));
        }
        await this.setupBatch(wq);
        const creates = [];
        const lists = [];
        for (let i = 0; i < this.prealloc; i++) {
            creates.push(this.invokeAsFarmer('createBatch',
                [`${this.prefix}_bt${i}`, this.sellerFarm(i), 'catfish', '120000']));
            lists.push(this.invokeAsFarmer('listBatch',
                [`${this.prefix}_bt${i}`, '30000']));
        }
        await this.setupBatch(creates);
        await this.setupBatch(lists);
    }

    async submitTransaction() {
        const i = this.txIndex++;
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'purchaseBatch',
            [`${this.prefix}_bt${i}`, this.buyerFarm(i), '']));
    }
}
module.exports.createWorkloadModule = () => new PurchaseBatch();
