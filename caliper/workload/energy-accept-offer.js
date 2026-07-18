'use strict';
const { AquaBase } = require('./lib/aqua-base');

/**
 * Measures acceptOffer throughput: credit escrow lock + offer decrement.
 * Each measured tx accepts its OWN pre-created offer; buyer balances cycle
 * across `farms` buyer accounts (hot-key contention axis).
 */
class AcceptOffer extends AquaBase {
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
        for (let i = 0; i < this.prealloc; i++) {
            offers.push(this.invokeAsFarmer('createOffer',
                [`${this.prefix}_o${i}`, `${this.prefix}_p${i % this.farms}`,
                 '10000', '150']));
        }
        await this.setupBatch(offers);
    }

    async submitTransaction() {
        const i = this.txIndex++;
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'acceptOffer',
            [`${this.prefix}_t${i}`, `${this.prefix}_o${i}`,
             this.buyerFarm(i), '10000', '']));
    }
}
module.exports.createWorkloadModule = () => new AcceptOffer();
