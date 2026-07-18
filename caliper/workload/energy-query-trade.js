'use strict';
const { AquaBase } = require('./lib/aqua-base');

/** Measures read (evaluate) throughput via getTrade. */
class QueryTrade extends AquaBase {
    async initializeWorkloadModule(...args) {
        await super.initializeWorkloadModule(...args);
        if (!this.prealloc) { throw new Error('roundArguments.prealloc required'); }
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
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'getTrade', [`${this.prefix}_t${i % this.prealloc}`], true));
    }
}
module.exports.createWorkloadModule = () => new QueryTrade();
