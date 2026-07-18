'use strict';

/**
 * Minimal in-memory mock of the Fabric chaincode Context, sufficient for
 * unit-testing contract business logic (state, tx timestamp, identity,
 * events). It does NOT simulate endorsement, MVCC, or channels.
 */
class MockStub {
    constructor(state) {
        this.state = state; // shared Map so multiple "transactions" see the ledger
        this.txTimestampSeconds = 1_700_000_000;
        this.events = [];
    }

    async getState(key) {
        return this.state.has(key) ? Buffer.from(this.state.get(key)) : Buffer.from('');
    }

    async putState(key, value) {
        this.state.set(key, value.toString());
    }

    async deleteState(key) {
        this.state.delete(key);
    }

    getTxTimestamp() {
        return { seconds: this.txTimestampSeconds, nanos: 0 };
    }

    setEvent(name, payload) {
        this.events.push({ name, payload: payload.toString() });
    }
}

class MockClientIdentity {
    constructor(id, msp) {
        this.id = id;
        this.msp = msp;
    }

    getID() { return this.id; }
    getMSPID() { return this.msp; }
}

class MockContext {
    constructor(state, identityId, msp) {
        this.stub = new MockStub(state);
        this.clientIdentity = new MockClientIdentity(identityId, msp);
    }
}

/** A tiny world that mints per-caller contexts over one shared ledger. */
class MockWorld {
    constructor() {
        this.state = new Map();
        this.clock = 1_700_000_000;
    }

    /** Get a ctx acting as `identityId` from `msp`, at the world clock. */
    as(identityId, msp) {
        const ctx = new MockContext(this.state, identityId, msp);
        ctx.stub.txTimestampSeconds = this.clock;
        return ctx;
    }

    advance(seconds) {
        this.clock += seconds;
    }
}

module.exports = { MockWorld };
