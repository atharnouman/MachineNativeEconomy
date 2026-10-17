# ADR-0022: Fixes from the review of key history and anchors

Date: 17 October 2026. Status: proposed.

## Context

An independent review of ADR-0019 to ADR-0021, run after they were pushed, found three faults. The first is serious and
comes from ADR-0020 itself.

1. **The gateway continued any chain, whoever had signed its head.**
   - `ReceiptLog` wrote a `gateway.key.rotated` receipt whenever another key had signed a chain's head, with
     `handover: null` when it did not hold that key.
   - The verifier then let a key that was pinned later cover a gap without a handover.
   - So someone with write access to the store but no gateway key could append receipts under a key of their own, for
     example a fake `payment.settled`. The next time the gateway wrote to that chain, it signed over them.
   - The bundle then verified, even with the gateway's own key pinned. This was reproduced against the built packages.
     Before ADR-0020, the same tampering failed `receipts.chain`.

   Trusting only the key a chain ends with was the flaw in the trust model. That key's signatures do cover the whole
   chain before it through the hash links. But a gateway that never checked the head was vouching for receipts it did
   not write.
2. **`verify --rpc` looked up older anchors under the wrong key.** An anchor record from before ADR-0020 names no sender,
   and the CLI looked it up under `gateway.address`, which after a rotation is the newest key. The anchor exists, but
   `anchors.onchain` failed. The testnet runner's earlier principals would have hit this once the reclaim step had
   rotated their chains.
3. **Anchoring the same head again moved its first block.** `ReceiptRegistry` let a party re-anchor its current head
   (same count, `prevHead` = head) and overwrote `anchoredAt`. That value is meant to prove the earliest block at which
   the head existed.

## Decisions

1. **The gateway continues a chain only from a key it was told about.** When another key signed a chain's head, the
   gateway hands the chain over only in two cases:
   - its signer holds that key (`previousGatewayKeys`), which signs the handover;
   - the operator declared the key's address in the new `previousGatewayAddresses`
     (`SPENDMARSHAL_PREVIOUS_GATEWAY_ADDRESSES`), for a key that is lost or destroyed. That rotation has no handover.

   Any other chain is refused:
   - The append fails with 409 and writes nothing. The refusal is logged and counted in
     `spendmarshal_receipt_chain_refusals_total`.
   - If a configured principal is refused at startup, the gateway does not start.
   - The reclaim job checks the chain before it sends anything on-chain. A refused principal's pre-approval is left
     alone, rather than reclaimed without a receipt.

   Every rotation is logged, as a warning when it has no handover, and counted in
   `spendmarshal_gateway_key_rotations_total{handover}`. An entry in `previousGatewayAddresses` that is not an address
   stops `buildGateway` before anything is receipted.
2. **Trust covers every key that signed the chain.** With `trustedGatewayKeys` (CLI `--gateway-key`), `gateway.trusted`
   now requires every key that signed part of the chain to be pinned, or linked to a pinned key by an unbroken run of
   handovers in either direction.
   - A valid handover is the old key's signature inside a receipt the new key signed. So it vouches for the key on its
     other side, whichever of the two is pinned.
   - A rotation without a handover vouches for neither side, so both keys have to be pinned.

   The detail names the first receipts nobody vouched for, for example
   `receipts #2–#4 were signed by 0x15d3…6A65, which is neither trusted nor linked to a trusted key by handovers`.
3. **Without pins, a rotation without a handover fails.** When the chain has such a rotation and no keys are pinned,
   `gateway.trusted` is reported anyway and fails, for example
   `rotation without a handover at #3 (0x7099…79C8 → 0x3C44…93BC): pin the gateway keys you trust`. A bundle with no
   rotation, or with only rotations that carry a handover, gets the report it got before.
4. **An anchor without a sender is looked up under the key that signed the receipt it anchors.** Core exports
   `gatewayKeyAt(keys, gatewayAddress, seq)`, and the CLI uses it for anchors that record no `party`. Before ADR-0020 the
   anchoring key was the gateway's only key, so it had signed every receipt up to the anchor.
5. **`anchoredAt` keeps the first block.** The registry sets it only while it is zero; `latest` still moves.
6. **The testnet runner declares its own earlier keys.** The runner is the only writer of its store and uses a fresh
   session key per run. Before the gateway starts, it reads the signer of every chain head in its store and passes them
   as `previousGatewayAddresses`. The reclaim step then continues earlier runs' chains with a rotation that has no
   handover, and those bundles verify when both keys are pinned.

Rejected:

- **Keeping the lenient default and documenting pinning.** The attack passed even with the gateway's own key pinned.
- **Trust that only flows forward from a pinned key.** An auditor who knows only the current key could not accept a
  chain that was handed over properly from an earlier key.
- **Refusing chains whose head signature cannot be read.** Unchanged: the gateway continues them as it did before key
  history, and the verifier fails the broken receipt.
- **Separating the receipt-signing key from the per-run session key in this change.** That would remove the testnet
  rotations altogether, but it is the next step, not part of this fix.

## Consequences

- The review's attack now fails at both ends. The gateway refuses to continue the chain. A chain that an older gateway
  continued blindly fails `gateway.trusted`, whether unpinned or pinned to the gateway's key; it passes only for an
  auditor who also pins the attacker's key.
- An operator who rotates without the old key must now declare its address. A forgotten declaration stops the gateway at
  startup, with a message that names the chain, the head and the key.
- An auditor who pins only the newest key of a chain rotated without handovers now sees which earlier keys to pin.
- Pinning a key still trusts every key it hands over to, including a thief's. A key that may have leaked should
  therefore be retired by a rotation with a handover. A strict mode that trusts only pinned keys is possible follow-up
  work.
- Tests:
  - **Core:**
    - The review's attack (attacker receipts in the middle, then a blind takeover) fails unpinned and pinned to the
      gateway key, and passes only with both keys pinned.
    - An attacker-made start of a chain also fails.
    - Trust flows in both directions through handovers, and a handover to a thief is trusted.
    - The default failure without pins, and `gatewayKeyAt`.
  - **Gateway, both store drivers:**
    - An undeclared head stops startup, is refused over HTTP (409) and by the reclaim job (no transaction sent), and is
      counted.
    - A declared address gives a rotation without a handover, which verifies with both keys pinned.
    - A `ReceiptLog` that refuses writes nothing until the key is declared.
    - A malformed address stops the gateway.
  - **anvil end to end:** after the gateway key changes, an anchor recorded without its sender is found on-chain under
    the key that sent it.
  - **Foundry:** re-anchoring a head, here or under another chain id, keeps its first block.
