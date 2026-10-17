# ADR-0019: Approver key history in the receipt chain

Date: 11 October 2026. Status: proposed.

## Context

The evidence verifier checked every signed approval (`approval.granted` or `approval.rejected` with
`method: "signature"`) against `bundle.approvers[approverId]`, and the gateway filled that map from its current
configuration when it exported the bundle. One map stood for the whole history. When an approver's key changed, every
approval the old key had signed failed with "approver address mismatch", so an honest bundle failed `verifyBundle`. The
live Base Sepolia run met this on 11 October 2026: the runner generates a fresh approver key per run, and when the store
held several runs, one check of ten failed for exactly this reason. Real deployments rotate keys too: a lost device, a
departing approver, a scheduled rotation.

The map also proved less than it seemed. It is the exporter's statement at export time, not a record of which key the
gateway accepted when it accepted a resolution, so a back-dated approval signed with today's key verified.

## Decisions

1. **Approver keys are receipts.** Two receipt kinds join the chain. `approver.registered` `{ approverId, address,
   prevAddress }` says that from this position on, `address` signs for `approverId`. `approver.removed` `{ approverId,
   prevAddress }` says the approver has no key from here on. They go into each principal's own chain, hash-linked,
   gateway-signed and anchored like every other receipt. A registration takes effect at its position: its `seq` and
   timestamp are the effective-from point. A separate effective-from field would repeat the timestamp, or contradict
   the order the chain proves.
2. **The gateway receipts every difference between its configuration and the chain.** `ApproverKeys.sync(principal)`
   compares the configured approvers with the last key registered for each one in that principal's chain, and receipts
   each difference: a new key, a rotated key, or an approver that left the configuration. It runs for every configured
   principal before the gateway serves (`ready`, which `listen()` awaits), and again right before a signed resolution
   is receipted. The second call covers a principal the gateway no longer serves whose pending approvals can still be
   resolved. Startup leaves the chains of other principals alone. The keys in force are read from the chain once per
   principal through the indexed `Store.receiptsOfKind` (SQLite index `receipts_principal_kind`) and then kept in
   memory. Syncs for one principal run one at a time, so a rotation is never registered twice. A configured approver
   key that is not an address stops `buildGateway` before anything is receipted.
3. **Each signed resolution verifies against the key in force at its position.** The verifier reads the registrations
   from the receipts, not from anything the exporter asserts, and checks a resolution at `#n` against the last
   registration of its approver before `#n`. The resolution fails if that registration is a removal, or if the chain
   already had key history at `#n` and the approver had no key. A new key therefore cannot sign for approvals made
   before it was registered, and a removed approver cannot sign at all.
4. **Bundles from before key history verify as before.** When no approver has a registration before a resolution, a
   gateway without key history wrote it. It is checked against the first key registered for its approver later in the
   chain. An upgraded gateway registers the key it was started with, and that is the key that signed those
   approvals unless it changed before the upgrade. When the chain never registered the approver, the resolution is
   checked against the `approvers` map, exactly as before. The approvals check says how many resolutions were verified
   either way.
5. **The bundle exports the history, and the verifier checks the export.** `approverHistory` maps each approver id to
   its keys in chain order: `address` (null after a removal), `seq`, `effectiveFrom` (the receipt's timestamp) and
   `receiptId`. It defaults to `{}`, so older bundles still parse. A new check, `approvers.history`, recomputes the
   history from the receipts, requires the export to match it entry for entry, and requires every registration to name
   the key it replaces. `approvers` stays as it was: the configuration at export time.

Rejected: a history built from the configuration or a store table and placed in the bundle (unsigned, editable after
the fact); trusting the address each approval receipt embeds (the gateway's own claim at the moment it accepted the
signature, so a key change would never be a separate, visible event); a store table of current keys (a second source of
truth that a crash between two writes can split from the chain); writing at startup into every principal that has a
policy (it rewrites dormant tenants' chains on every restart, and breaks chains signed by an earlier gateway key).

## Consequences

- A bundle verifies after any number of rotations, and its chain shows when each key came into force and which key it
  replaced. An auditor can hold that against the organisation's own record of key changes.
- Startup writes one receipt per configured principal for each approver whose key changed, and nothing on a deployment
  without approver keys. The Phase 1 demo's chain gains one `approver.registered` at startup.
- `verifyBundle` has one more check. The CLI's `verify` prints it with the history, for example
  `PASS  approvers.history  (cfo: 0x90F7…b906 from #1, 0x15d3…6A65 from #4)`. The committed sample bundles and
  `docs/testnet-evidence.json` predate key history and still verify 11/11, against the `approvers` map.
- Approvals signed before an upgrade by a key that had already been replaced before the upgrade still fail. That
  history was never recorded, and the verifier does not guess it.
- `Store` implementations need `receiptsOfKind`; both drivers have it.
- The gateway's own key has no history yet. A bundle names one gateway address, so a chain whose receipts were signed
  by an earlier gateway key fails `receipts.chain`. That is why the testnet runner keeps one principal per run: it
  generates a fresh session key every run. Gateway key history (a rotation receipt signed by the old key naming the new
  one) is follow-up work.
- Tests: core unit tests cover a rotation, and show that the same approvals without history reproduce the live-run
  failure. They also cover forgeries with the new key at an old position (claiming either key, and before key
  history), removal, an approver missing from a chain with history, an upgraded store, and a tampered or missing
  export. A gateway test runs five gateways on one store in both drivers: it rotates the key twice, resolves a pending
  approval on a gateway that no longer serves the principal, and removes the approver. Every bundle verifies.
