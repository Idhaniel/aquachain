'use strict';
const { AquaBase } = require('./lib/aqua-base');

/**
 * Measures confirmReceipt throughput: escrow settlement, seller payment,
 * and on-chain ownership transfer of the fish batch.
 */
class ConfirmReceipt extends AquaBase {
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
        const buys = [];
        for (let i = 0; i < this.prealloc; i++) {
            creates.push(this.invokeAsFarmer('createBatch',
                [`${this.prefix}_bt${i}`, this.sellerFarm(i), 'catfish', '120000']));
            lists.push(this.invokeAsFarmer('listBatch',
                [`${this.prefix}_bt${i}`, '30000']));
            buys.push(this.invokeAsFarmer('purchaseBatch',
                [`${this.prefix}_bt${i}`, this.buyerFarm(i), '']));
        }
        await this.setupBatch(creates);
        await this.setupBatch(lists);
        await this.setupBatch(buys);
    }

    async submitTransaction() {
        const i = this.txIndex++;
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'confirmReceipt', [`${this.prefix}_bt${i}`]));
    }
}
module.exports.createWorkloadModule = () => new ConfirmReceipt();
