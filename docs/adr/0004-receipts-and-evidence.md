# ADR-0004: Hash-chained, gateway-signed receipts; anchored heads; offline-verifiable bundles

**Status:** accepted (Phase 0)

## Context
x402 and L402 have no native audit trail; "the protocol is half the answer". Disputes, accounting and compliance all need evidence that binds intent → policy decision → settlement.

## Decision
Every decision (allow / deny / escalate), settlement, denial, credential event, kill-switch flip and anchor is a `Receipt`: canonical JSON, `hash = keccak256(body)`, `sig = EIP-191 sign(hash)` by the gateway key, `prev` = previous receipt hash, `seq` strictly increasing per principal. The head is anchored in `ReceiptRegistry` on demand. The `EvidenceBundle` carries policy (+hash), public credentials, receipts and anchors. `verifyBundle()` needs only the gateway address; `--rpc` adds anchor existence.

Receipts record the `policyHash` so a later policy edit cannot be passed off as the one in force. Settlement receipts cite the on-chain tx and the `intentHash`, which is also inside the authorization the chain executed.

Rejected: on-chain receipts for every event (cost, privacy); third-party timestamping (adds a trusted party); unsigned logs (not evidence).

## Consequences
* Receipts are the raw material for reputation (Phase 2: feedback only against `payment.settled`), accounting exports and disputes.
* Bundles omit bearer secrets; they are safe to hand to an auditor.
* Chain privacy: only hashes go on-chain.
