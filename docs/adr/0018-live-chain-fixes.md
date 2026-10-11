# ADR-0018: Fixes from the live Base Sepolia run

Date: 11 October 2026. Status: accepted.

## Context

Running the gateway against Base Sepolia, Circle's USDC and the public x402 facilitator ([TESTNET.md](../TESTNET.md))
surfaced five faults that no local test had shown. Each would also have hit a production deployment.

1. **Receipts arrived before the state was readable.** Base's public RPC serves Flashblocks preconfirmations:
   `eth_getTransactionReceipt` answers for transactions in the block still being built, one ahead of `eth_blockNumber`
   (checked against `https://sepolia.base.org` on 11 October 2026), while `eth_call` at `latest` reads the last sealed
   block. viem's `waitForTransactionReceipt` resolves on that early receipt, so the gateway sent the paid retry before
   the pre-approval was readable and the facilitator's ERC-1271 check missed it. Earlier runs had met the same thing
   after grants, delegations and settlements and called it "RPC lag".
2. **Spend and anchors leaked between principals.** The ledger summed spend by budget id and by root agent id across
   every principal in the store, so two principals that both call a budget `org` drew on one counter, and a run with a
   fresh principal was denied by a budget it had never used. The evidence export listed every principal's anchors, so a
   bundle carried other tenants' anchors and failed its own `anchors.match` check. On a hosted gateway, one tenant's
   spending would have denied another tenant's payments.
3. **Anchoring assumed one relayer key forever.** The registry chains anchors per sending address, but the gateway took
   the previous head from its own store. The first anchor from a new relayer key reverted with `PrevHeadMismatch`, and
   so would a key rotation, a relayer pool or a restored store.
4. **The placeholder signature was malformed.** A pre-approved standard payload carried 65 zero bytes as its signature,
   since the account answers ERC-1271 from the approved digest. The public facilitator splits a 65-byte signature into
   (v, r, s) to simulate USDC's split-signature `transferWithAuthorization`, and its secp256k1 parser refuses r = 0
   ("expected valid r"). Together with the first fault this looked like a facilitator that rejects contract payers. It
   does not: with both fixed it verifies and settles payments from the EIP-7702 delegated account.
5. **The public facilitator sometimes fails to send.** One settlement came back `invalid_exact_evm_transaction_failed`
   with no transaction on chain; the same payment settled when asked again a minute later.

## Decisions

1. **Writes wait for inclusion.** `waitForInclusion(client, hash)` in core waits for the receipt, then until the chain's
   latest block reaches the receipt's block. It gives up after 30 seconds and returns the receipt anyway, so a stalled
   node degrades to the old behaviour instead of hanging a payment. Every write in the gateway's chain client, both
   settle paths of the facilitator and the devnet helpers use it. On a local chain it returns at once.
2. **Ledger views and anchors belong to one principal.** `Store.ledgerView(principalId)` and `Store.spent(principalId)`
   scope every sum to that principal in both store drivers; budget names and agent ids only need to be unique within a
   principal. Anchor records carry their principal, and the evidence export lists only the principal's own. Anchor
   records written before this change have no principal and are left out of per-principal exports.
3. **Anchors chain from the registry.** The gateway reads the previous head from `ReceiptRegistry.latest(relayer)` and
   sends anchors one at a time. The store's anchor list is the evidence record, not the chaining source.
4. **Pre-approved payloads carry a well-formed placeholder.** `PREAPPROVED_SIGNATURE` in core is 65 bytes every
   secp256k1 parser accepts and no key produced: r is the x-coordinate of the curve's generator, s = 1, v = 27. The
   account still ignores it.
5. **The payee retries one transient settle failure.** On `transaction_failed`, a 5xx or a dropped connection, the
   payee asks the facilitator once more after two seconds. The EIP-3009 nonce lets the transfer happen at most once,
   and a retry after a transfer that did land is refused as already used. The payee also passes the facilitator's
   `invalidMessage` or `errorMessage` through in its 402, since the reason code alone hid faults 4 and 5.

## Consequences

- Contract payers settle through the public x402 facilitator with standard payloads. The bundled facilitator stays the
  default for local development and for chains without a public facilitator.
- On Base a standard payment waits about one block, two seconds, between its pre-approval and the paid retry. The
  gateway cannot know which block tag a payee's facilitator reads, so it waits for `latest`.
- If a facilitator's transfer lands after it reported failure, the payee answers 402 while the funds moved. The gateway
  then records a denial whose pre-approval later reclaims as already used. A settlement receipt for that case needs
  the gateway to watch the token's `AuthorizationUsed` event; that is follow-up work.
- Tests: store tests open two principals with the same budget name and agent id, and anchor both, in both drivers; core
  unit tests drive the inclusion wait with a client whose receipt is ahead of the chain head, and check that the
  placeholder parses while an all-zero one does not.
