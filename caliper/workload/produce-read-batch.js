'use strict';
const { AquaBase } = require('./lib/aqua-base');

/** Measures read (evaluate) throughput via getBatch — provenance lookups. */
class ReadBatch extends AquaBase {
    async initializeWorkloadModule(...args) {
        await super.initializeWorkloadModule(...args);
        if (!this.prealloc) { throw new Error('roundArguments.prealloc required'); }
        await this.registerFarms({ sellers: this.farms });
        const wq = [];
        for (let i = 0; i < this.farms; i++) {
            wq.push(this.invokeAsFarmer('updateWaterQuality',
                [this.sellerFarm(i), '725', '2850', '680']));
        }
        await this.setupBatch(wq);
        const creates = [];
        for (let i = 0; i < this.prealloc; i++) {
            creates.push(this.invokeAsFarmer('createBatch',
                [`${this.prefix}_bt${i}`, this.sellerFarm(i), 'catfish', '120000']));
        }
        await this.setupBatch(creates);
    }

    async submitTransaction() {
        const i = this.txIndex++;
        await this.sutAdapter.sendRequests(this.invokeAsFarmer(
            'getBatch', [`${this.prefix}_bt${i % this.prealloc}`], true));
    }
}
module.exports.createWorkloadModule = () => new ReadBatch();
