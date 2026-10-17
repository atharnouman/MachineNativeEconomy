# ADR-0021: Anchors per receipt chain

Date: 17 October 2026. Status: proposed; decision 3 amended by ADR-0022 (`anchoredAt` keeps a head's first block).

## Context

`ReceiptRegistry` kept one anchor record per sending address. `anchor(head, prevHead, count)` required `prevHead` to be
the sender's last anchored head and `count` never to drop below the sender's last count. One gateway key anchors the
chains of every principal it serves, and passes each principal's own receipt count. So a gateway that anchored a long
chain and then a shorter one for another principal was refused with `NonMonotonicCount`. Anchoring a principal with
seven receipts and then one with a single receipt reverts with `NonMonotonicCount(7, 1)`; this was reproduced on the
old bytecode. The `prevHead` check also tied unrelated principals together: each anchor had to name whichever head the
key had anchored last, for any principal.

It never showed up, because every demo anchors one principal, and the testnet runner uses a fresh key per run with one
principal per run. On a gateway that serves several principals, one tenant's long chain would stop every shorter
tenant's evidence from being anchored. The contract's own comment assumed one party per principal ("gateway for a
principal").

## Decisions

1. **The registry keeps anchors per sender and receipt chain.** `anchor(chain, head, prevHead, count)` and
   `latest(party, chain)` replace the per-sender versions. The checks themselves are unchanged, but they now hold within
   one chain: `prevHead` is the head this sender last anchored for this chain, and `count` never drops below its last
   count for it. Anchors of different chains never constrain each other, in any order of length.
2. **A chain is named by the hash of its first receipt.** That hash never changes for the life of the chain and needs no
   new state. Any verifier can recompute it from a bundle (`receipts[0].hash`). It also names no principal, so the
   registry still holds only hashes (ADR-0004). It does let an observer group anchors by chain, but the counts already
   disclosed each chain's length.
3. **`anchoredAt(party, head)` keeps its shape.** Heads are receipt hashes, unique across chains. So
   `spendmarshal verify --rpc` checks anchors the same way in old and new registries, and bundles anchored in an old
   registry still verify against it. The `Anchored` event now carries `chain`, indexed with `party` and `head`;
   `prevHead` moves to the event data.
4. **The gateway names the chain on every anchor.** `ChainClient.latestAnchorHead(registry, receiptChain)` and
   `anchor(registry, receiptChain, …)` take the principal's first receipt hash. Anchors still go one at a time.
5. **Deployed registries are replaced, not migrated.** The old contract has no per-chain functions, so a gateway with
   this change cannot anchor in it. The testnet runner checks its cached registry: `registryAnchorsPerChain` in devnet
   looks for the selector of `latest(address, bytes32)` in the deployed code. If the registry is from before this change,
   the operator deploys a new one once (`deployReceiptRegistry`), and the runner updates `local/testnet-deploy.json`.
   Earlier testnet bundles keep verifying against the old registry, because each anchor names its registry.

Rejected:

- **Dropping the count check.** The sender's anchors would stay one log across principals: `prevHead` would still chain
  unrelated tenants, and the count would mean nothing.
- **Naming the chain by its principal id, or a hash of it.** Anyone could confirm a guessed tenant name.
- **One registry per principal.** That means a deployment per tenant.
- **A fallback in the gateway for old registries.** The only deployment is a testnet registry that the runner replaces,
  and the fallback would have to be kept forever.

## Consequences

- One gateway key anchors any number of principals, in any order. A rotated key (ADR-0020) starts its own sequence for
  each chain, just as it started its own per-sender sequence before.
- Per-chain state would let a verifier with an RPC check that a bundle contains the latest head each gateway key
  anchored for its chain. That check would catch a bundle that leaves out anchored receipts even when it also drops the
  anchors that name them. It is not done here, for three reasons:
  - It needs the gateway keys and the registry pinned.
  - A bundle exported before a later anchor must not fail it.
  - `exportedAt` is the exporter's own claim.
- The next live testnet run deploys one contract more than usual from the operator, so it needs slightly more operator
  ETH that one time.
- Tests:
  - **Foundry:** per-chain chaining. A short chain is anchored after a long one, and a fuzz test covers any two lengths
    in either order. Also covered: `prevHead` is per chain, a second sender is independent, the event, and the existing
    revert cases.
  - **anvil end to end:** one gateway key anchors two principals, the longer chain first, then the longer one again.
    The registry's `latest` for each chain matches that principal's head, and both bundles verify with `--rpc`.
  - **One-off check (not committed):** the same scenario against the old bytecode reverted with
    `NonMonotonicCount(7, 1)`, and `registryAnchorsPerChain` tells the old registry from the new one.
  - **Demos:** both still anchor and verify against the new registry.
