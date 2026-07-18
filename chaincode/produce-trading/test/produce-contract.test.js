'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const ProduceTradingContract = require('../lib/produce-contract');
const { MockWorld } = require('./mock-context');

const ARBITER = { id: 'x509::/CN=processoradmin', msp: 'FishProcessorsMSP' };
const ALICE = { id: 'x509::/CN=alice', msp: 'FishFarmersMSP' };
const BOB = { id: 'x509::/CN=bob-processor', msp: 'FishProcessorsMSP' };

async function setup(world, c) {
    await c.registerFarm(world.as(ALICE.id, ALICE.msp), 'farmA');
    await c.registerFarm(world.as(BOB.id, BOB.msp), 'buyerB');
    await c.depositCredits(world.as(ARBITER.id, ARBITER.msp), 'buyerB', '50000');
    // IoT snapshot: pH 7.25, 28.5 C, DO 6.8 mg/L
    await c.updateWaterQuality(world.as(ALICE.id, ALICE.msp), 'farmA', '725', '2850', '680');
    await c.createBatch(world.as(ALICE.id, ALICE.msp), 'b1', 'farmA', 'catfish', '120000');
    await c.listBatch(world.as(ALICE.id, ALICE.msp), 'b1', '30000');
}

test('batch carries water-quality provenance and completes with ownership transfer', async () => {
    const world = new MockWorld();
    const c = new ProduceTradingContract();
    await setup(world, c);

    let batch = JSON.parse(await c.getBatch(world.as(ALICE.id, ALICE.msp), 'b1'));
    assert.strictEqual(batch.waterQualityAtHarvest.phX100, 725);
    assert.strictEqual(batch.status, 'LISTED');

    await c.purchaseBatch(world.as(BOB.id, BOB.msp), 'b1', 'buyerB', '');
    let bal = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'buyerB'));
    assert.deepStrictEqual({ a: bal.available, l: bal.locked }, { a: 20000, l: 30000 });

    batch = JSON.parse(await c.confirmReceipt(world.as(BOB.id, BOB.msp), 'b1'));
    assert.strictEqual(batch.status, 'COMPLETED');
    assert.strictEqual(batch.ownerFarmId, 'buyerB');

    const alice = JSON.parse(await c.getBalance(world.as(ALICE.id, ALICE.msp), 'farmA'));
    assert.strictEqual(alice.available, 30000);
});

test('dispute path: arbiter splits escrow 40/60 and conserves credits', async () => {
    const world = new MockWorld();
    const c = new ProduceTradingContract();
    await setup(world, c);

    await c.purchaseBatch(world.as(BOB.id, BOB.msp), 'b1', 'buyerB', '');
    await c.flagDispute(world.as(BOB.id, BOB.msp), 'b1', 'underweight');

    // only the arbiter org may resolve
    await assert.rejects(
        () => c.resolveDispute(world.as(ALICE.id, ALICE.msp), 'b1', '40'),
        /restricted to FishProcessorsMSP/);

    const batch = JSON.parse(
        await c.resolveDispute(world.as(ARBITER.id, ARBITER.msp), 'b1', '40'));
    assert.strictEqual(batch.status, 'RESOLVED');
    assert.deepStrictEqual(batch.resolution, { buyerRefund: 12000, sellerPaid: 18000 });

    const alice = JSON.parse(await c.getBalance(world.as(ALICE.id, ALICE.msp), 'farmA'));
    const bob = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'buyerB'));
    assert.strictEqual(alice.available + bob.available + bob.locked, 50000);
    // seller was paid something, so ownership transfers
    assert.strictEqual(batch.ownerFarmId, 'buyerB');
});

test('receipt timeout flags dispute; credits stay locked until resolution', async () => {
    const world = new MockWorld();
    const c = new ProduceTradingContract();
    await setup(world, c);

    await c.purchaseBatch(world.as(BOB.id, BOB.msp), 'b1', 'buyerB', '7200');
    await assert.rejects(
        () => c.expireSale(world.as(ALICE.id, ALICE.msp), 'b1'),
        /deadline not reached/);

    world.advance(7201);
    const batch = JSON.parse(await c.expireSale(world.as(ALICE.id, ALICE.msp), 'b1'));
    assert.strictEqual(batch.status, 'DISPUTED');

    const bob = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'buyerB'));
    assert.strictEqual(bob.locked, 30000); // still escrowed

    // full refund resolution: ownership stays with seller
    const resolved = JSON.parse(
        await c.resolveDispute(world.as(ARBITER.id, ARBITER.msp), 'b1', '100'));
    assert.strictEqual(resolved.ownerFarmId, 'farmA');
    const bob2 = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'buyerB'));
    assert.deepStrictEqual({ a: bob2.available, l: bob2.locked }, { a: 50000, l: 0 });
});

test('guards: cannot list twice, cannot buy own batch, unlisted batch not purchasable', async () => {
    const world = new MockWorld();
    const c = new ProduceTradingContract();
    await setup(world, c);

    await assert.rejects(
        () => c.listBatch(world.as(ALICE.id, ALICE.msp), 'b1', '999'),
        /cannot be listed/);
    await assert.rejects(
        () => c.purchaseBatch(world.as(ALICE.id, ALICE.msp), 'b1', 'farmA', ''),
        /must differ/);

    await c.createBatch(world.as(ALICE.id, ALICE.msp), 'b2', 'farmA', 'tilapia', '5000');
    await assert.rejects(
        () => c.purchaseBatch(world.as(BOB.id, BOB.msp), 'b2', 'buyerB', ''),
        /not LISTED/);
});
