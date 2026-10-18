# ADR-0023: An evidence key separate from the gateway's on-chain key

Date: 18 October 2026. Status: proposed.

## Context

One key, `gatewayPrivateKey`, did two jobs. It signed every receipt, which makes it the identity auditors pin. It was also
the gateway's on-chain identity: it holds the root sessions, relays settlements and sends anchors.

1. **The testnet runner changed its evidence identity on every run.** Session keys are single-use on-chain, so every run
   uses a fresh gateway key, and with one key that meant a fresh receipt-signing key too. Each time the reclaim step wrote
   into an earlier run's chain, it added a rotation without a handover. Since ADR-0022, the runner has to declare those
   keys, and auditors have to pin both sides of each rotation.
2. **In production the on-chain key is a hot key.** It sends transactions, pays gas and holds root sessions. Whoever
   compromises it could also sign receipts.

The independent review behind ADR-0022 recommended separating the two keys as the next step.

## Decisions

1. **A separate evidence key signs receipts.**
   - It is `evidencePrivateKey` (`SPENDMARSHAL_EVIDENCE_PRIVATE_KEY`). It defaults to `gatewayPrivateKey`, so an unchanged
     configuration behaves exactly as before.
   - It never sends a transaction, so it needs no funds or nonce, and a `Signer` backed by a KMS or HSM can hold it
     (`Signer.evidenceAddress`, `receiptKeyOf()`).
   - `gatewayPrivateKey` keeps every on-chain job, anchors included. `/healthz` reports both addresses.
2. **Key history follows the evidence key.** Rotations, `previousGatewayKeys`, `previousGatewayAddresses`, handovers and
   trust pinning (ADR-0020, ADR-0022) all concern the key that signs receipts. Turning on a separate evidence key for an
   existing store is a rotation. The gateway key signed those chains until then and is still held, so it signs the handover
   itself.
3. **The chain records who sent each anchor.**
   - The gateway key sends the anchor. The `evidence.anchored` receipt, signed by the evidence key, names the sender, head,
     count and transaction.
   - `anchors.match` now requires every anchor that names a sender to match such a receipt. This replaces ADR-0020's rule
     that the sender is the key that signed the anchored receipt, which held only while one key did both jobs.
   - The gateway writes the receipt before it lists the anchor, so an export never lists an anchor its chain does not
     record. `spendmarshal verify --rpc` still looks each anchor up under its sender.
4. **The testnet runner keeps one evidence key.** It generates the key once and keeps it with its other secrets in
   `local/testnet-deploy.json`, never printed. Every run passes it, while the session key changes each run.
   - New chains never rotate.
   - A chain written before the evidence key still gets one rotation without a handover when the reclaim step touches it.
     The runner keeps declaring the keys that signed its chain heads for this (ADR-0022).

Rejected:

- **The evidence key sends anchors too** (the review's suggestion). It would then need funds and nonces, which makes it a
  hot key and keeps it out of a KMS that only signs. The signed `evidence.anchored` receipt binds the sender to the chain
  just as well.
- **A third key used only for anchoring.** Nothing needs it yet.
- **Renaming `previousGatewayKeys` and `previousGatewayAddresses`.** They now refer to the receipt-signing key; that is
  documented rather than renamed.

## Consequences

- Rotating the on-chain key no longer touches any receipt chain. That covers a new root session, a new relayer and a
  fresh testnet session key.
- When the evidence key is separate, compromising the on-chain key no longer lets anyone sign evidence. The evidence key
  only signs, so it can be kept well away from anything that transacts.
- Bundles from before this change verify as before. Anchors that name a sender were always recorded by an
  `evidence.anchored` receipt, and anchors without one are matched to their head only.
- The planned `verify --rpc` check against the registry's per-chain `latest` must query every sender that the chain's
  `evidence.anchored` receipts name. A changing on-chain key spreads one chain's anchors over several senders.
- Tests:
  - **Core:** an anchor sent by a key other than the receipt signer passes only when an `evidence.anchored` receipt
    records it. A different sender or transaction fails, and an anchor without a sender is matched to its head.
  - **Gateway, both store drivers:**
    - One evidence key across two gateway keys writes no rotation, the anchors are listed under both senders, and
      `/healthz` reports both addresses.
    - A misattributed anchor fails.
    - Turning on the evidence key hands an existing chain over, signed by the gateway key.
    - A malformed evidence key stops the gateway.
    - `LocalSigner` signs receipts with the evidence key and hands chains over with the gateway key.
  - **anvil end to end:** two runs with different gateway keys and one evidence key write no rotation. Every receipt is
    signed by the evidence key, and `--rpc` finds both anchors on-chain under their senders.
