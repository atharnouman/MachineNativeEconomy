# ADR-0020: Gateway key history in the receipt chain

Date: 17 October 2026. Status: proposed; decisions 2, 3, 7 and 8 amended by ADR-0022, and decision 8's sender rule replaced by ADR-0023.

## Context

The verifier checked every receipt in a principal's chain against one address, `bundle.gateway.address`, and the gateway
filled it with the key it held at export time. That key changes: a scheduled rotation, a lost or leaked key, a move to a
KMS, a new relayer. After a change, every receipt the old key had signed failed with "signer … is not gateway", so an
honest bundle failed `verifyBundle`. The testnet runner meets this on every run. A session key is single-use on-chain, so
the runner generates a fresh one per run and uses it as the gateway key. It keeps one principal per run, but its reclaim
step still writes into earlier runs' principals with the new key, and an export of an earlier principal names the wrong
key.

Three facts shaped the design:

1. **A key change has to be visible.** If the signer simply changes partway through a chain, that chain looks exactly like
   one that someone with access to the store, but without the key, extended under a key of their own.
2. **The old key may be gone.** The testnet runner never stores its session keys, and a lost or destroyed key is the
   usual reason to rotate. Requiring the old key would leave such a principal with a chain nobody can extend.
3. **Anchors are per sender.** `ReceiptRegistry` chains anchors per sending address, and the gateway sends them with its
   own key. The bundle's anchors did not say who sent them. `spendmarshal verify --rpc` looked each one up under
   `gateway.address`, so after a rotation it would not find the anchors an earlier key had sent.

## Decisions

1. **A key change is a receipt.** `gateway.key.rotated` `{ prevAddress, address, handover }` joins the chain. It is
   signed by `address`, the key it brings into force, and every receipt after it is signed by that key until the next
   rotation. Like ADR-0019's approver registrations, it takes effect at its own position. Signing the rotation proves the
   new key is held, and through the hash links that signature covers the whole chain before it.
2. **The old key signs the handover when the gateway still holds it.** `handover` is the previous key's EIP-191 signature
   over `gatewayKeyHandoverMessage()`. That text names the principal, the rotation's `seq`, the hash of the receipt before
   it, and both addresses, so the signature is valid for that chain at that position only. When the gateway no longer
   holds the previous key, `handover` is null and the rotation is still written. Writing under the new key without a
   rotation is the failure this ADR fixes, and refusing to write would leave a principal whose key was lost without
   receipts.
3. **The receipt log writes the rotation before anything else the new key signs.** `ReceiptLog` reads the signer of each
   chain's head once, with the new synchronous `receiptSigner()` in core. If the head was signed by another key, the log
   writes the rotation inside the principal's append queue, so a key change is recorded once however many appends race.
   `ReceiptLog.handOver(principal)` does only that.
   - The gateway calls `handOver` for every configured principal before it serves (part of `ready`), and before every
     anchor.
   - Any other chain is handed over by its next receipt, for example the reclaim job writing into an earlier testnet
     principal, a late approval, or an operator's external receipt.
   - As in ADR-0019, startup leaves other principals' chains alone, so a dormant tenant's chain changes only when the
     gateway writes to it.
4. **Earlier keys are needed only while rotating.** They are listed in `previousGatewayKeys`
   (`SPENDMARSHAL_PREVIOUS_GATEWAY_PRIVATE_KEYS`), and `LocalSigner` uses them only in `signKeyHandover`. That method is
   optional on `Signer`: a KMS or HSM signer without it records rotations without a handover. An entry that is not a
   32-byte hex key stops `buildGateway` before anything is receipted. To rotate:
   1. Start the gateway with the new key, and the old one in `previousGatewayKeys`.
   2. Let startup hand the served principals over. Any dormant principal that matters is handed over by a receipt, for
      example an anchor.
   3. Remove the old key from the configuration and destroy it.
5. **The verifier follows the key in force.** `verifyChain(receipts, gatewayAddress)` checks each receipt against the key
   in force at its position.
   - Without rotations that is `gatewayAddress` throughout, exactly as before.
   - With rotations it is the first rotation's `prevAddress` up to that rotation, then each rotation's `address` from
     there on.
   - Each rotation must name the key it replaces, and must not rotate to the key already in force.
   - A handover must recover to `prevAddress`.
   - The chain must end with `gatewayAddress`.

   A rotation without a handover passes these checks. It is part of the history, and decision 7 decides what it is worth.
6. **The bundle names the key the chain ends with, and exports the history.** The export reads `gateway.address` from
   the chain's head: normally the exporting gateway's own key, or the key that signed the chain if it has not been written
   since the key changed. `gatewayKeyHistory` lists each rotation as
   `{ address, prevAddress, seq, effectiveFrom, receiptId, handedOver }` and defaults to `[]`, so older bundles still
   parse. A new check, `gateway.keys`, recomputes the history from the receipts and requires the export to match. Its
   detail lists every key and whether it was handed over, for example
   `0xf39F…2266 from #0; 0x7099…79C8 from #2 (handed over); 0x3C44…93BC from #3 (no handover)`. The check appears only
   when the chain has a rotation or the export lists one, so a bundle with neither gets exactly the report it got before.
7. **The auditor pins trust, and handovers carry it forward.** A bundle has always been consistent only on its own terms,
   under the key it names. Deciding that this key belongs to the operator was the auditor's step, done outside the
   verifier. `verifyBundle(bundle, { trustedGatewayKeys })` and `spendmarshal verify --gateway-key ADDRESS` make that
   step part of verification, through a new check, `gateway.trusted`:
   - It passes when the key the chain ends with is trusted, or descends from a trusted key through handovers.
   - A rotation without a handover breaks the descent. From there on, only a key the auditor pins directly counts.
   - Trusting the final key is enough for the whole chain, because its signatures cover every earlier receipt through
     the hash links.

   That answers who may introduce a new key. The holder of the key in force can, with a handover, for anyone who trusts
   that key. Anyone else can only extend a chain under a key the auditor has to trust on its own.
8. **Anchors name their sender.** Anchor records, the `evidence.anchored` receipt and the bundle carry `party`, the
   address that sent the anchor transaction. `spendmarshal verify --rpc` looks each anchor up under its `party`, or under
   `gateway.address` for older bundles. The gateway hands the chain over before it anchors, so the sender signed the head
   it anchors, and `anchors.match` now checks that for every anchor that names a `party`. The registry's per-sender
   chaining needs nothing new: a rotated key reads its own previous head from the registry (ADR-0018) and starts its own
   anchor chain.

Rejected:

- **The old key signing the rotation receipt itself.** The old key still signs every handover it can (decision 2). But
  without the old key only the new key can sign, so that shape needs two signing rules for one receipt kind. It also
  never shows that the new key is held, and the receipt log could no longer read the key in force from the head's
  signer.
- **A key list in the bundle or the configuration.** It would be unsigned and the exporter's own claim, the same reason
  ADR-0019 gives.
- **Refusing to write without the old key.** A principal whose key was lost could never be written to again.
- **Rotating every chain in the store at startup.** Every start would have to recover the head signer of every
  principal, and dormant tenants' chains would change on restarts.
- **A receipt-signing key kept apart from the relayer and root-session key.** It would let the testnet runner keep one
  evidence key while it rotates session keys. But it changes who sends anchors and the bounded-operator model, so it is
  left as possible follow-up work.
- **An async `exportEvidence` that recovers the signer with viem.** Core instead declares `@noble/curves`, already
  installed through viem, for a synchronous `receiptSigner()`, and `Gateway.exportEvidence` keeps its signature.

## Consequences

- A bundle verifies after any number of gateway key changes, and its chain shows when each key took over and whether the
  previous key handed over.
- An auditor who pinned the first key keeps that trust across rotations with a handover. After a rotation without one,
  the new key needs a source of its own, for example:
  - the key the operator publishes;
  - the root session the account owner granted that key on-chain (`ownerIsGateway: false`);
  - the anchors it sent, checked with `--rpc`.
- After a key change, startup writes one rotation per configured principal; otherwise it writes nothing. The thin slice
  and the Phase 1 demo use one key, so they gain no rotation and their verification reports are unchanged. Their anchor
  records and `evidence.anchored` receipts now carry `party`.
- The committed sample bundles and `docs/testnet-evidence.json` predate key history. `spendmarshal verify` prints
  byte-identical reports for them before and after this change, and for tampered copies of them too (a wrong gateway
  address, an edited receipt, a misplaced anchor).
- The testnet runner still uses one principal per run, because the run's budget and its approver key belong to that run.
  What changes: the reclaim step's receipts in an earlier run's principal now follow a rotation without a handover,
  since that run's session key is gone, and that principal's bundle verifies.
- API changes:
  - `verifyChain` also returns `keys`, and `verifyBundle` takes options.
  - `Signer` gains the optional `signKeyHandover`, and `LocalSigner` takes `previousGatewayKeys`.
  - The anchor response carries `party`, and core depends on `@noble/curves` directly.
- `ReceiptRegistry` keeps one anchor chain per sender across all principals and requires its count never to decrease. A
  gateway that anchors a long chain for one principal and then a shorter one for another is refused with
  `NonMonotonicCount`. Key history does not cause this, and it did not show up because every demo and run anchors a
  single principal per key. ADR-0021 fixes it by keeping anchors per receipt chain.
- Tests:
  - **Core unit tests:** chains across three keys, with and without a handover. Without rotation receipts, the same keys
    reproduce the live-run failure. A bundle without rotations gets the same report as before. Trust pins work, and
    break at a rotation without a handover.
  - **Core forgery tests:** a rotation that names the wrong key, a handover signed by the new key, a handover replayed at
    another position or in another principal's chain, the old key signing after a rotation, and a bundle that names the
    old key. Also: an exported history that does not match, anchors from the wrong sender, and synchronous signer
    recovery.
  - **Gateway tests, both drivers:** gateways with three keys run in turn on one store. They hand the served principal
    over with and without the old key, leave a dormant principal alone until an external receipt hands it over, and hand
    a chain over before anchoring it. Ten appends that race after a key change write one rotation, and a malformed
    previous key stops the gateway before it writes anything.
