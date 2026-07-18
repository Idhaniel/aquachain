'use strict';
const { AquaBase } = require('./lib/aqua-base');

/** Measures createOffer throughput (validates + decrements surplus). */
class CreateOffer extends AquaBase {
    async initializeWorkloadModule(...args) {
        await super.initializeWorkloadModule(...args);
        await this.registerFarms({ sellers: this.farms });
        // one giant production per seller so offers never exhaust surplus
        const reqs = [];
        for (let i = 0; i < this.farms; i++) {
            reqs.push(this.invokeAsFarmer('logEnergyProduction',
                [`${this.prefix}_p${i}`, this.sellerFarm(i), '1000000000']));
        }
        await this.setupBatch(reqs);
    }

    async submitTransaction() {
        const i = this.txIndex++;
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'createOffer',
            [`${this.prefix}_o${i}`, `${this.prefix}_p${i % this.farms}`,
             '10000', '150']));
    }
}
module.exports.createWorkloadModule = () => new CreateOffer();
