'use strict';
const { AquaBase } = require('./lib/aqua-base');

/**
 * Measures confirmDelivery throughput: escrow settlement with the alpha
 * partial-delivery ratio. roundArguments.partialPct of confirmations report
 * ~73% delivery (partial settlement); the rest are full deliveries.
 */
class ConfirmDelivery extends AquaBase {
    async initializeWorkloadModule(...args) {
        await super.initializeWorkloadModule(...args);
        if (!this.prealloc) { throw new Error('roundArguments.prealloc required'); }
        this.partialPct = Number(this.roundArguments.partialPct || 30);

        await this.registerFarms({ sellers: this.farms, buyers: this.farms });
        await this.fundBuyers('EnergyProviderMSP');
        const prods = [];
        for (let i = 0; i < this.farms; i++) {
            prods.push(this.invokeAsFarmer('logEnergyProduction',
                [`${this.prefix}_p${i}`, this.sellerFarm(i), '1000000000']));
        }
        await this.setupBatch(prods);
        const offers = [];
        const trades = [];
        for (let i = 0; i < this.prealloc; i++) {
            offers.push(this.invokeAsFarmer('createOffer',
                [`${this.prefix}_o${i}`, `${this.prefix}_p${i % this.farms}`,
                 '10000', '150']));
            trades.push(this.invokeAsFarmer('acceptOffer',
                [`${this.prefix}_t${i}`, `${this.prefix}_o${i}`,
                 this.buyerFarm(i), '10000', '']));
        }
        await this.setupBatch(offers);
        await this.setupBatch(trades);
    }

    async submitTransaction() {
        const i = this.txIndex++;
        const partial = (i % 100) < this.partialPct;
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'confirmDelivery',
            [`${this.prefix}_t${i}`, partial ? '7333' : '10000']));
    }
}
module.exports.createWorkloadModule = () => new ConfirmDelivery();
