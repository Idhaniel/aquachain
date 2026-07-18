'use strict';
const { AquaBase } = require('./lib/aqua-base');

/**
 * Measures createBatch throughput. Heavier payload than energy writes:
 * the chaincode reads the farm's latest water-quality snapshot and embeds
 * it as provenance metadata (manuscript Section 3.5 Step 1).
 */
class CreateBatch extends AquaBase {
    async initializeWorkloadModule(...args) {
        await super.initializeWorkloadModule(...args);
        await this.registerFarms({ sellers: this.farms });
        // one water-quality snapshot per farm (pH 7.25, 28.5 C, DO 6.8 mg/L)
        const reqs = [];
        for (let i = 0; i < this.farms; i++) {
            reqs.push(this.invokeAsFarmer('updateWaterQuality',
                [this.sellerFarm(i), '725', '2850', '680']));
        }
        await this.setupBatch(reqs);
    }

    async submitTransaction() {
        const i = this.txIndex++;
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'createBatch',
            [`${this.prefix}_bt${i}`, this.sellerFarm(i), 'catfish', '120000']));
    }
}
module.exports.createWorkloadModule = () => new CreateBatch();
