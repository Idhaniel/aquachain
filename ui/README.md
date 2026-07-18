# AquaChain Console (web UI)

A minimal ops/demo console for the AquaChain network. Node.js + Express
backend using the official `@hyperledger/fabric-gateway` SDK (the Fabric
v2.5 client path), vanilla HTML/CSS/JS frontend, zero build step.

## How it links to the network

The browser never touches Fabric — it can't hold private keys or speak
gRPC. Instead:

```
Browser ──HTTP──▶ Express (server.js)
                    │  loads cert + key from ../network/organizations/...
                    │  signs transactions as the selected identity
                    ▼
              Gateway peer (localhost:7051 / 8051 / 9051, gRPC+TLS)
                    │  collects endorsements from BOTH orgs (AND policy)
                    ▼
              Orderers ──▶ blocks ──▶ all peers commit
```

- `lib/fabric.js` maps five UI identities to the cryptogen users you
  already generated (FishFarmers User1–3, EnergyProvider User1,
  FishProcessors User1) and opens one cached Gateway connection per
  identity, each to its own org's peer on localhost.
- `server.js` exposes `/api/invoke` and `/api/query`, which call
  `submitTransaction` / `evaluateTransaction` on the right channel +
  chaincode, and `/api/overview/:domain` for the tables.
- `lib/registry.js` remembers *which IDs exist* (chaincode has no
  "list all" functions) in `data/registry.json`; every displayed value is
  still read fresh from the ledger.

No configuration is needed if `ui/` sits inside the `aquachain/` repo next
to `network/`. If you move it, set `AQUACHAIN_ORG_ROOT` to the absolute
path of `network/organizations`.

## Run

The network must already be up (`./network.sh all` done). Then:

```bash
cd ~/aquachain/ui
npm install
npm start
# → AquaChain UI on http://localhost:3000
```

Open http://localhost:3000 in your browser (on WSL2, Windows browsers
reach WSL's localhost directly).

## Five-minute demo script

1. **Acting as Farm operator 1** → Energy tab → Register farm `farm-eze`.
2. Switch to **Farm operator 2** → Register farm `farm-ada`.
3. Switch to **Energy cooperative admin** → Deposit 100000 to `farm-ada`.
   (Try depositing as a farm operator first — watch the chaincode reject
   it. Rejections are the demo.)
4. Back to **operator 1** → Log production: farm-eze, 25200 Wh →
   Create offer: 10000 Wh at 150 kobo/kWh.
5. Switch to **operator 2** → click **Accept…** on the offer → buyer farm
   `farm-ada` → watch 1,500 kobo move to *Locked* in the balances table.
6. Still operator 2 → **Confirm…** on the trade, but type **7333** Wh —
   partial delivery: seller gets 1,099, buyer refunded 401
   (the α ratio from the manuscript, live).
7. Produce tab: operator 1 records water quality, creates + lists a batch;
   the batch row shows pH/temp/DO captured at harvest. Operator 2 buys it,
   then **Dispute…**; switch to **Processor / arbiter** → **Resolve…** at
   40% refund and watch the escrow split.

## Notes & troubleshooting

- **"ENOENT ... tlsca..."** — the server can't find crypto material:
  network not generated yet, or `ui/` moved (set `AQUACHAIN_ORG_ROOT`).
- **"no such host / connection refused"** — containers down; `docker ps`.
- **Endorsement errors on submit** — both orgs' peers must be reachable;
  check `docker logs peer0.energyprovider.aquachain.com`.
- **Empty tables after a restart** — assets created outside this UI
  (e.g. by Caliper) aren't in the registry; the ledger still has them.
  Delete `data/registry.json` to reset the UI's memory.
- This is a localhost demo console: a generic invoke endpoint + dev keys
  on disk. Don't expose it beyond your machine as-is.
