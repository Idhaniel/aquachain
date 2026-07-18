# AquaChain — Design Notes & Manuscript Deltas

This document records where the implementation had to make decisions the
manuscript leaves open, ambiguous, or technically infeasible as written —
and what we recommend changing in the paper. Each item notes the manuscript
location, the issue, the decision taken here, and the suggested edit.

---

## 1. Farms are client identities, not Fabric organizations

**Manuscript:** Section 3.1 says both "The network is divided into multiple
organizations, which represent different stakeholder categories.
FishFarmers represents the individual urban farms" *and* "Each urban fish
farm is treated as a unique Fabric organization, maintaining one or more
peer nodes and a Certificate Authority." These two statements contradict
each other.

**Issue:** One-org-per-farm means every smallholder farm runs its own peer,
CA, and MSP — operationally and economically unrealistic for the target
users, and it makes the network topology unbounded.

**Decision:** Farms are **client identities within FishFarmersMSP**. Each
farm binds its enrolled identity to a `farmId` on-chain via
`registerFarm(farmId)`; every farm-scoped chaincode function then verifies
`ctx.clientIdentity.getID()` against that binding. Farm-level authorization
is enforced *in chaincode*, org-level trust is enforced *by Fabric*.

**Suggested edit:** Remove the "unique Fabric organization" sentence;
state that farms are registered client identities under the FishFarmers
organization, with farm-level access control enforced by the chaincode
identity binding.

---

## 2. Endorsement policy: "buyer AND seller organization" doesn't work for farm-to-farm trades

**Manuscript:** Section 3.1: "specific endorsement policies require
signatures from both the buyer and seller organizations on any trade
transaction."

**Issue:** Fabric endorsement policies are expressed over *organizations*
(MSPs), not individual clients. When buyer and seller are both farms inside
FishFarmersMSP (the dominant case), "buyer org AND seller org" collapses to
a single-org policy — the stated guarantee is unachievable at the policy
layer.

**Decision:** Chaincode-level endorsement policy is
`AND('FishFarmersMSP.peer','EnergyProviderMSP.peer')` on energychannel and
`AND('FishFarmersMSP.peer','FishProcessorsMSP.peer')` on producechannel:
every trade is independently simulated and signed by two distinct
organizations, which is the real trust property the manuscript is after.
Buyer/seller *individual* authorization is enforced deterministically in
chaincode (item 1). Deploy with `CC_POLICY_MODE=OR` to measure the
endorsement-overhead axis in Caliper.

**Suggested edit:** Rephrase to "endorsement policies require signatures
from peers of both organizations on each channel (e.g. FishFarmers AND
EnergyProvider), while buyer- and seller-level authorization is enforced by
identity checks within the chaincode." Optionally cite Fabric's
state-based endorsement as future work for per-trade policies.

---

## 3. Timeouts must be externally triggered — Fabric has no scheduler

**Manuscript:** Section 3.4 Step 6 / 3.5 Step 6: trades "become EXPIRED"
after 24 h; produce sales are "flagged for dispute by the system" after 48 h.

**Issue:** Chaincode only executes when invoked; there is no cron inside
Fabric, and chaincode must be deterministic (no `Date.now()`).

**Decision:** `expireTrade` / `expireSale` are invocable by *anyone* after
the deadline; the chaincode validates the deadline against the
transaction's own timestamp (`getTxTimestamp()`), which is deterministic
across endorsers. In production the middleware would run a watchdog that
submits expiry transactions.

**Suggested edit:** State that expiry is enforced on-chain against the
transaction timestamp but *triggered* by an off-chain watchdog in the
middleware layer.

---

## 4. All chaincode arithmetic is integer

Credits are minor units (e.g. kobo), energy is watt-hours, water-quality
values are scaled ×100 (pH 7.25 → 725). Floating point in chaincode risks
cross-language non-determinism and rounding drift in escrow settlement.
The partial-settlement math (Eq. 4–6) uses integer floor division with an
explicit conservation check: `paid + refund === locked` always.

**Suggested edit:** One sentence in 3.3 noting fixed-point integer
representation for credits and measurements.

---

## 5. Credits are per-channel pools

**Issue:** The dual-channel design means the energy ledger and produce
ledger are separate databases. A single farm balance spanning both channels
would require cross-channel atomicity, which Fabric does not provide.

**Decision:** Each channel maintains its own credit ledger (a farm has an
energy-credit balance and a produce-credit balance). This is a genuine
architectural consequence of the dual-channel privacy design and worth
stating in the paper as a trade-off (privacy isolation ⇄ split liquidity).

**Suggested edit:** Add to 3.3 or Limitations: credits are scoped per
channel; consolidating balances across channels is an off-chain (cooperative
treasury) operation.

---

## 6. Who mints credits / arbitrates disputes

**Manuscript:** "an administrator then reflects on-chain by invoking a
depositCredits function" — the administrator is unspecified; dispute
resolution has no specified arbiter.

**Decision:** `depositCredits` (and `resolveDispute` on producechannel) are
restricted to the counterpart organization on each channel:
EnergyProviderMSP on energychannel, FishProcessorsMSP on producechannel.
They act as the cooperative administrator/arbiter role. This is a policy
choice — swap in a dedicated Cooperative org if preferred.

**Suggested edit:** Name the administrator/arbiter role explicitly in 3.3
and 3.5 Step 6.

---

## 7. Asset IDs are client-supplied

The chaincode validates uniqueness but does not generate IDs (generation
would need randomness → non-determinism, or tx-ID-derived IDs → awkward for
clients). Client-supplied IDs also make Caliper workloads deterministic.

---

## 8. MVCC read conflicts are the real throughput ceiling — measure them

Fabric's optimistic concurrency means two transactions in the same block
that touch the same key (a buyer's balance, a hot offer) produce
`MVCC_READ_CONFLICT` failures for all but the first. The escrow design
concentrates writes on balance keys, so **contention — not raw ordering
throughput — will bound the settlement TPS**. The Caliper workloads expose
this deliberately: the `farms` argument controls how many distinct
buyer/seller accounts each worker cycles through. Running the same round
with `farms: 5` vs `farms: 50` quantifies the contention effect — a much
stronger empirical finding than a single headline TPS number.

**Suggested edit:** Section 4 should report failed-tx rates alongside
throughput and discuss key-level contention as the scaling constraint.

---

## 9. LevelDB, cryptogen, and other prototype simplifications

- **LevelDB** (default) state DB — faster than CouchDB and sufficient since
  all queries are key-based. If you later want rich JSON queries, switch to
  CouchDB and note the throughput cost.
- **cryptogen** issues identities for the benchmark network; a pilot should
  run one **Fabric CA per org** (as the manuscript's Fig. 1 shows).
- **Water quality is logged on producechannel** so `createBatch` can read
  it — Fabric chaincode cannot write across channels, and cross-channel
  reads don't return committed guarantees. The manuscript's "chaincode
  automatically fetches the latest readings" is implemented as: middleware
  writes `updateWaterQuality` to producechannel; `createBatch` embeds the
  latest on-chain snapshot.

---

## 10. What the Caliper campaign should measure (replacing projected Table 4)

1. **Per-function throughput & latency** at fixed rates (the provided
   rounds: log/offer/lock/settle + reads) on both channels.
2. **Saturation scan:** repeat rounds at 25 → 50 → 100 → 200 TPS; report
   the knee where latency departs sub-second.
3. **Endorsement policy axis:** redeploy with `CC_POLICY_MODE=OR` vs `AND`
   and compare (quantifies the manuscript's ε_policy in Eq. 9).
4. **Contention axis:** `farms: 5 / 25 / 50` on the escrow rounds
   (quantifies MVCC failure rates, item 8).
5. **Block-cutting axis:** `BatchTimeout` 2s→500ms and `MaxMessageCount`
   in configtx.yaml (affects latency vs throughput trade-off, Eq. 10).
6. **Resource footprint:** the docker monitor records CPU/RAM per node —
   evidence for the "runs on modest cooperative hardware" argument.

These give the paper a real Results section: measured TPS/latency tables
per function, a latency-vs-load curve, and an endorsement/contention
sensitivity analysis — all directly tied to Eq. 9–10.
