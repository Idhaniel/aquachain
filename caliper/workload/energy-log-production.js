'use strict';
const { AquaBase } = require('./lib/aqua-base');

/** Measures logEnergyProduction (asset creation) throughput. */
class LogProduction extends AquaBase {
    async initializeWorkloadModule(...args) {
        await super.initializeWorkloadModule(...args);
        await this.registerFarms({ sellers: this.farms });
    }

    async submitTransaction() {
        const i = this.txIndex++;
        // ~25.2 kWh/day surplus scenario: log 25,200 Wh production events
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'logEnergyProduction',
            [`${this.prefix}_p${i}`, this.sellerFarm(i), '25200']));
    }
}
module.exports.createWorkloadModule = () => new LogProduction();
