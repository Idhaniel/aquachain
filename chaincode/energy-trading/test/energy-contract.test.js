'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const EnergyTradingContract = require('../lib/energy-contract');
const { MockWorld } = require('./mock-context');

const ADMIN = { id: 'x509::/CN=coopadmin', msp: 'EnergyProviderMSP' };
const ALICE = { id: 'x509::/CN=alice', msp: 'FishFarmersMSP' };
const BOB = { id: 'x509::/CN=bob', msp: 'FishFarmersMSP' };

async function setupMarket(world, c) {
    await c.registerFarm(world.as(ALICE.id, ALICE.msp), 'farmA');
    await c.registerFarm(world.as(BOB.id, BOB.msp), 'farmB');
    // Alice: seller with surplus; Bob: buyer with 100,000 credits
    await c.depositCredits(world.as(ADMIN.id, ADMIN.msp), 'farmB', '100000');
    // 30 kWh surplus logged by Alice's meter pipeline
    await c.logEnergyProduction(world.as(ALICE.id, ALICE.msp), 'p1', 'farmA', '30000');
    // Offer 20 kWh at 150 credits/kWh
    await c.createOffer(world.as(ALICE.id, ALICE.msp), 'o1', 'p1', '20000', '150');
}

test('full lifecycle: offer -> accept -> full delivery settles seller', async () => {
    const world = new MockWorld();
    const c = new EnergyTradingContract();
    await setupMarket(world, c);

    // production surplus reduced by the offer
    const prod = JSON.parse(await c.getProduction(world.as(ALICE.id, ALICE.msp), 'p1'));
    assert.strictEqual(prod.remainingWh, 10000);

    // Bob accepts 10 kWh => locks floor(10000*150/1000) = 1500 credits
    await c.acceptOffer(world.as(BOB.id, BOB.msp), 't1', 'o1', 'farmB', '10000', '');
    let bal = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'farmB'));
    assert.deepStrictEqual({ a: bal.available, l: bal.locked }, { a: 98500, l: 1500 });

    // Buyer's meter confirms full delivery
    const trade = JSON.parse(
        await c.confirmDelivery(world.as(BOB.id, BOB.msp), 't1', '10000'));
    assert.strictEqual(trade.status, 'SETTLED');
    assert.strictEqual(trade.paidAmount, 1500);
    assert.strictEqual(trade.refundedAmount, 0);

    const alice = JSON.parse(await c.getBalance(world.as(ALICE.id, ALICE.msp), 'farmA'));
    assert.strictEqual(alice.available, 1500);
    bal = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'farmB'));
    assert.deepStrictEqual({ a: bal.available, l: bal.locked }, { a: 98500, l: 0 });
});

test('partial delivery settles proportionally (Eq. 4-6) and conserves credits', async () => {
    const world = new MockWorld();
    const c = new EnergyTradingContract();
    await setupMarket(world, c);

    await c.acceptOffer(world.as(BOB.id, BOB.msp), 't1', 'o1', 'farmB', '10000', '');
    // only 7,333 Wh delivered => alpha = 0.7333, paid = floor(1500*7333/10000) = 1099
    const trade = JSON.parse(
        await c.confirmDelivery(world.as(BOB.id, BOB.msp), 't1', '7333'));
    assert.strictEqual(trade.status, 'PARTIALLY_SETTLED');
    assert.strictEqual(trade.paidAmount, 1099);
    assert.strictEqual(trade.refundedAmount, 401);
    assert.strictEqual(trade.paidAmount + trade.refundedAmount, trade.lockedAmount);

    const alice = JSON.parse(await c.getBalance(world.as(ALICE.id, ALICE.msp), 'farmA'));
    const bob = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'farmB'));
    // conservation: 100000 total in the system
    assert.strictEqual(alice.available + bob.available + bob.locked, 100000);
});

test('timeout refunds buyer in full, only after the deadline', async () => {
    const world = new MockWorld();
    const c = new EnergyTradingContract();
    await setupMarket(world, c);

    await c.acceptOffer(world.as(BOB.id, BOB.msp), 't1', 'o1', 'farmB', '10000', '3600');

    // before the deadline: rejected
    await assert.rejects(
        () => c.expireTrade(world.as(ALICE.id, ALICE.msp), 't1'),
        /deadline not reached/);

    world.advance(3601);
    const trade = JSON.parse(await c.expireTrade(world.as(ALICE.id, ALICE.msp), 't1'));
    assert.strictEqual(trade.status, 'EXPIRED');
    const bob = JSON.parse(await c.getBalance(world.as(BOB.id, BOB.msp), 'farmB'));
    assert.deepStrictEqual({ a: bob.available, l: bob.locked }, { a: 100000, l: 0 });
});

test('authorization: only farm owner can offer/confirm; only settlement MSP deposits', async () => {
    const world = new MockWorld();
    const c = new EnergyTradingContract();
    await setupMarket(world, c);

    // Bob cannot create an offer against Alice's production
    await assert.rejects(
        () => c.createOffer(world.as(BOB.id, BOB.msp), 'o2', 'p1', '1000', '150'),
        /not the registered owner/);

    await c.acceptOffer(world.as(BOB.id, BOB.msp), 't1', 'o1', 'farmB', '10000', '');
    // Alice (seller) cannot confirm delivery on the buyer's behalf
    await assert.rejects(
        () => c.confirmDelivery(world.as(ALICE.id, ALICE.msp), 't1', '10000'),
        /not the registered owner/);

    // a farmer cannot mint credits
    await assert.rejects(
        () => c.depositCredits(world.as(ALICE.id, ALICE.msp), 'farmA', '5000'),
        /restricted to EnergyProviderMSP/);
});

test('guards: insufficient credits, oversubscription, self-trade, double accept', async () => {
    const world = new MockWorld();
    const c = new EnergyTradingContract();
    await setupMarket(world, c);

    // register a broke buyer
    const CARO = { id: 'x509::/CN=caro', msp: 'FishFarmersMSP' };
    await c.registerFarm(world.as(CARO.id, CARO.msp), 'farmC');
    await assert.rejects(
        () => c.acceptOffer(world.as(CARO.id, CARO.msp), 'tX', 'o1', 'farmC', '10000', ''),
        /Insufficient credits/);

    // cannot offer more than remaining surplus (10,000 Wh left on p1)
    await assert.rejects(
        () => c.createOffer(world.as(ALICE.id, ALICE.msp), 'o2', 'p1', '20000', '150'),
        /exceeds remaining surplus/);

    // seller cannot buy own offer
    await assert.rejects(
        () => c.acceptOffer(world.as(ALICE.id, ALICE.msp), 'tY', 'o1', 'farmA', '1000', ''),
        /must differ/);

    // accepting more than offer remaining
    await assert.rejects(
        () => c.acceptOffer(world.as(BOB.id, BOB.msp), 'tZ', 'o1', 'farmB', '25000', ''),
        /exceeds offer remaining/);

    // fill the offer, then try again
    await c.acceptOffer(world.as(BOB.id, BOB.msp), 't1', 'o1', 'farmB', '20000', '');
    await assert.rejects(
        () => c.acceptOffer(world.as(BOB.id, BOB.msp), 't2', 'o1', 'farmB', '1', ''),
        /not OPEN/);
});
