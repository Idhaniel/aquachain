'use strict';

/**
 * Fabric Gateway connection layer for the AquaChain UI.
 *
 * Each UI "identity" maps to a cryptogen-issued user of one of the three
 * organizations. Connections are created lazily and cached. Every identity
 * connects to its own organization's gateway peer on localhost; the peer's
 * Gateway service handles cross-org endorsement (our chaincodes use an
 * AND policy, so the gateway collects a second endorsement from the
 * partner org's peer over the Docker network).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

// Root of network/organizations — override with env if the ui/ folder moves.
const ORG_ROOT = process.env.AQUACHAIN_ORG_ROOT ||
    path.resolve(__dirname, '..', '..', 'network', 'organizations');

const PEER_ORG = (domain) => path.join(ORG_ROOT, 'peerOrganizations', domain);

const IDENTITIES = {
    'ff-user1': {
        label: 'Farm operator 1 (FishFarmers / User1)',
        mspId: 'FishFarmersMSP',
        domain: 'fishfarmers.aquachain.com',
        user: 'User1',
        peerEndpoint: 'localhost:7051',
        peerHost: 'peer0.fishfarmers.aquachain.com',
        role: 'farmer',
    },
    'ff-user2': {
        label: 'Farm operator 2 (FishFarmers / User2)',
        mspId: 'FishFarmersMSP',
        domain: 'fishfarmers.aquachain.com',
        user: 'User2',
        peerEndpoint: 'localhost:7051',
        peerHost: 'peer0.fishfarmers.aquachain.com',
        role: 'farmer',
    },
    'ff-user3': {
        label: 'Farm operator 3 (FishFarmers / User3)',
        mspId: 'FishFarmersMSP',
        domain: 'fishfarmers.aquachain.com',
        user: 'User3',
        peerEndpoint: 'localhost:7051',
        peerHost: 'peer0.fishfarmers.aquachain.com',
        role: 'farmer',
    },
    'ep-user1': {
        label: 'Energy cooperative admin (EnergyProvider / User1)',
        mspId: 'EnergyProviderMSP',
        domain: 'energyprovider.aquachain.com',
        user: 'User1',
        peerEndpoint: 'localhost:8051',
        peerHost: 'peer0.energyprovider.aquachain.com',
        role: 'energy-admin',
    },
    'fp-user1': {
        label: 'Processor / arbiter (FishProcessors / User1)',
        mspId: 'FishProcessorsMSP',
        domain: 'fishprocessors.aquachain.com',
        user: 'User1',
        peerEndpoint: 'localhost:9051',
        peerHost: 'peer0.fishprocessors.aquachain.com',
        role: 'processor-admin',
    },
};

const CHANNELS = {
    energy: { channel: 'energychannel', chaincode: 'energy-trading' },
    produce: { channel: 'producechannel', chaincode: 'produce-trading' },
};

const gateways = new Map(); // identityKey -> { gateway, client }

function firstFile(dir) {
    const entries = fs.readdirSync(dir);
    if (!entries.length) { throw new Error(`No files in ${dir}`); }
    return path.join(dir, entries[0]);
}

function userMspDir(def) {
    return path.join(PEER_ORG(def.domain), 'users',
        `${def.user}@${def.domain}`, 'msp');
}

function orgTlsCaPath(def) {
    return path.join(PEER_ORG(def.domain), 'tlsca',
        `tlsca.${def.domain}-cert.pem`);
}

async function getGateway(identityKey) {
    if (gateways.has(identityKey)) { return gateways.get(identityKey).gateway; }
    const def = IDENTITIES[identityKey];
    if (!def) { throw new Error(`Unknown identity: ${identityKey}`); }

    const tlsRootCert = fs.readFileSync(orgTlsCaPath(def));
    const client = new grpc.Client(def.peerEndpoint,
        grpc.credentials.createSsl(tlsRootCert),
        { 'grpc.ssl_target_name_override': def.peerHost });

    const msp = userMspDir(def);
    const credentials = fs.readFileSync(firstFile(path.join(msp, 'signcerts')));
    const privateKeyPem = fs.readFileSync(firstFile(path.join(msp, 'keystore')));
    const signer = signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem));

    const gateway = connect({
        client,
        identity: { mspId: def.mspId, credentials },
        signer,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 15000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });
    gateways.set(identityKey, { gateway, client });
    return gateway;
}

async function getContract(identityKey, domain) {
    const ch = CHANNELS[domain];
    if (!ch) { throw new Error(`Unknown domain: ${domain}`); }
    const gateway = await getGateway(identityKey);
    return gateway.getNetwork(ch.channel).getContract(ch.chaincode);
}

function closeAll() {
    for (const { gateway, client } of gateways.values()) {
        try { gateway.close(); } catch { /* ignore */ }
        try { client.close(); } catch { /* ignore */ }
    }
    gateways.clear();
}

module.exports = { IDENTITIES, CHANNELS, getContract, closeAll, ORG_ROOT };
