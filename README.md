# AquaChain — Fabric v2.5 Dual-Channel Trading Network

Implementation of the manuscript *"Enterprise Blockchain Platform for
Energy and Produce Trading Among Urban Fish Farms"*: a Hyperledger Fabric
v2.5 network with two channels (energychannel, producechannel), three peer
organizations, three Raft orderers, JavaScript chaincode implementing
credit-based escrow with IoT-style delivery verification, and a Hyperledger
Caliper benchmarking workspace.

```
aquachain/
├── chaincode/
│   ├── energy-trading/     # Section 3.4 lifecycle (unit tests included)
│   └── produce-trading/    # Section 3.5 lifecycle (unit tests included)
├── network/
│   ├── organizations/cryptogen/   # crypto-config.yaml
│   ├── configtx/configtx.yaml     # 2 channel profiles, Raft, no system channel
│   ├── compose/docker-compose.yaml
│   ├── scripts/prepare-caliper-identities.sh
│   └── network.sh                 # up | channels | deploy | all | down
├── caliper/
│   ├── network-config.yaml        # PeerGateway connector
│   ├── benchmarks/                # energy + produce benchmark configs
│   └── workload/                  # 9 workload modules
├── DESIGN_NOTES.md                # manuscript ↔ implementation deltas
└── README.md
```

## Prerequisites

- **Docker** with the compose plugin (`docker compose version` works).
  On Windows: use **WSL2** (Ubuntu) with Docker Desktop's WSL integration,
  and keep this repo inside the WSL filesystem (e.g. `~/aquachain`), not
  under `/mnt/c` — bind mounts and the Docker socket are far more reliable
  there.
- **Node.js 18+** and npm (Node 18/20/22 all fine).
- `curl`, `jq`, `tar`.
- ~4 GB free RAM for the 7 Fabric containers plus chaincode containers.

## Step 1 — Install Fabric v2.5 binaries and Docker images

From the directory **containing** `aquachain/` (i.e. its parent):

```bash
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh --fabric-version 2.5.10 binary docker
```

This creates `bin/` (peer, orderer, configtxgen, cryptogen, osnadmin) and
`config/` (core.yaml etc.) in the current directory and pulls the 2.5
Docker images. Then, in **every terminal** you use for the next steps:

```bash
export PATH=$PWD/bin:$PATH
export FABRIC_CFG_PATH=$PWD/config
peer version   # should print 2.5.x
```

(Any 2.5.x patch version is fine; 2.5.10+ recommended.)

## Step 2 — Bring the network up

```bash
cd aquachain/network
./network.sh all
```

`all` runs three phases (also runnable individually):

1. `up` — cryptogen generates identities for OrdererOrg (3 orderers),
   FishFarmers (2 peers, 3 users), EnergyProvider and FishProcessors
   (1 peer, 1 user each); docker compose starts all 7 nodes.
2. `channels` — configtxgen creates each channel's genesis block, all
   three orderers join via `osnadmin channel join` (the v2.5 channel
   participation flow — there is no system channel), then peers join:
   energychannel ← FishFarmers + EnergyProvider peers,
   producechannel ← FishFarmers + FishProcessors peers. Anchor peers are
   embedded in the genesis config, so no config-update step is needed.
3. `deploy` — packages, installs, approves and commits both chaincodes
   with endorsement policy `AND('FishFarmersMSP.peer','<partner>MSP.peer')`.
   The peer builds the Node.js chaincode images on first deploy — allow a
   few minutes.

To compare endorsement policies later (Caliper experiment axis):

```bash
./network.sh down && ./network.sh up && ./network.sh channels
CC_POLICY_MODE=OR ./network.sh deploy
```

## Step 3 — CLI smoke test

Still in `aquachain/network`, acting as a FishFarmers user
(exports mirror the `as_org` helper inside network.sh):

```bash
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=FishFarmersMSP
export CORE_PEER_ADDRESS=localhost:7051
export CORE_PEER_TLS_ROOTCERT_FILE=$PWD/organizations/peerOrganizations/fishfarmers.aquachain.com/peers/peer0.fishfarmers.aquachain.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/fishfarmers.aquachain.com/users/User1@fishfarmers.aquachain.com/msp
export ORDERER_CA=$PWD/organizations/ordererOrganizations/aquachain.com/tlsca/tlsca.aquachain.com-cert.pem
PEER_FF=$CORE_PEER_TLS_ROOTCERT_FILE
PEER_EP=$PWD/organizations/peerOrganizations/energyprovider.aquachain.com/peers/peer0.energyprovider.aquachain.com/tls/ca.crt

INVOKE="peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer1.aquachain.com --tls --cafile $ORDERER_CA -C energychannel -n energy-trading --peerAddresses localhost:7051 --tlsRootCertFiles $PEER_FF --peerAddresses localhost:8051 --tlsRootCertFiles $PEER_EP --waitForEvent"

$INVOKE -c '{"function":"registerFarm","Args":["farm1"]}'
$INVOKE -c '{"function":"logEnergyProduction","Args":["p1","farm1","25200"]}'
$INVOKE -c '{"function":"createOffer","Args":["o1","p1","10000","150"]}'
peer chaincode query -C energychannel -n energy-trading -c '{"function":"getOffer","Args":["o1"]}'
```

You should see the offer JSON with `"status":"OPEN"`. (Both
`--peerAddresses` are required because the endorsement policy is AND of
both orgs.) A full trade additionally needs a second farm registered by a
different identity (e.g. `User2`) plus a `depositCredits` call made with
the EnergyProvider user's MSP — the Caliper workloads automate exactly
this choreography.

## Step 4 — Run the Caliper benchmarks

```bash
cd ../caliper
../network/scripts/prepare-caliper-identities.sh   # normalize cert/key names
npm install
npx caliper bind --caliper-bind-sut fabric:2.5     # installs @hyperledger/fabric-gateway
npm run bench:energy     # -> reports/energy-report.html
npm run bench:produce    # -> reports/produce-report.html
```

Each report contains, per lifecycle function: send rate, min/avg/max
latency, throughput, success/fail counts, and per-container CPU/RAM. The
failed-transaction counts on the escrow rounds are meaningful data, not
noise — see DESIGN_NOTES.md §8 and §10 for the experiment matrix that
turns these runs into the manuscript's Results section.

## Step 5 — Reset

```bash
cd ../network && ./network.sh down
```

## Chaincode unit tests (no network needed)

```bash
cd chaincode/energy-trading  && npm install && npm test   # 5 tests
cd ../produce-trading        && npm install && npm test   # 4 tests
```

## Troubleshooting

- **`osnadmin` connection refused** — orderers not up yet; wait a few
  seconds after `up`, or check `docker logs orderer1.aquachain.com`.
- **TLS handshake errors from host CLI/Caliper** — certificates include a
  `localhost` SAN via crypto-config; if you changed hostnames/ports, keep
  cert SANs and endpoints in sync.
- **Chaincode container build fails** — the peer needs the Docker socket
  (mounted in compose) and internet access to build the Node chaincode
  image on first deploy.
- **Endorsement policy failure on invoke** — with the default AND policy
  you must target one peer from each org (`--peerAddresses` twice), as in
  the smoke test.
- **Many failed txs in acceptOffer/purchase rounds** — MVCC contention on
  balance keys; raise the `farms` argument in the benchmark yaml (and
  report the effect — it's a finding).
