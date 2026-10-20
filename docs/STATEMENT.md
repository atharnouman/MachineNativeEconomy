# statement: a client's month-end statement from its evidence bundle

`spendmarshal statement BUNDLE` turns one client's evidence bundle (the format in `docs/spec/evidence-v1.md`) into a
statement the client can read and check: what its agents paid, to whom, under which policy, who approved what, what the
gateway refused, and, when the provider's figure is given, how the two totals reconcile. Every number on the statement is
read from a receipt. Nothing is estimated, converted or rounded.

One bundle holds one principal, so a statement is per client: export each client's bundle (`spendmarshal export-evidence`
or `GET /v1/evidence/:principalId`) and run the command once per bundle.

## What it prints

| Section | Source in the bundle | What it says |
|---|---|---|
| Header | `principalId`, `exportedAt`, the receipts, `gateway`, `gatewayKeyHistory`, `anchors` | The period, the number of receipts (and how many fall in the period), the chain head, the gateway key, the key that signed the last receipt, every key that signed the chain, and the latest anchor with whether it covers the end of the period |
| Verification | the offline checks the command runs first | Passed, or the checks that failed when `--unverified` was used |
| Settled | `payment.settled` receipts in the period | Count and total, split by rail, by agent and by payee (with the resources paid for); the part that was subscription charges (those settlements carry a `subscriptionId`, so they are inside the total, never added to it) |
| Approvals | `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired` in the period; `approval.consumed` anywhere | One row per approval touched in the period: outcome, when, the approver (id, method, key), the amount, the payee and resource, the policy version in force, and whether a payment consumed it |
| Denied | `payment.denied` and `onchain.denied` in the period | Attempts grouped by the recorded reason, with the amount when the receipt carries one |
| Allowed but not settled | `decision` receipts with effect `allow` at the quote or charge stage in the period | Intents the gateway allowed that no `payment.settled` ever followed and no denial came after: the place a provider's charge for an undelivered or unrecorded payment would show |
| Reclaimed | `preapproval.reclaimed` in the period | Expired, unused pre-approvals whose charge was restored on-chain |
| Policy | `policyVersions` | The versions in force at any time during the period, with activation time and who activated them |
| Mandates | `credentials` | What each agent was allowed: spend cap, per-payment maximum, number of payees, purposes, rails, expiry, and which agent delegated to it |
| Events | `killswitch`, `policy.updated`, `approver.*`, `gateway.key.rotated`, `evidence.anchored`, `subscription.created`, `subscription.cancelled` in the period | One line each |
| Reconciliation | the settlements plus the items above, and `--provider-total` | See below |
| Verify | the keys and the file | The exact `spendmarshal verify` command, with every key that signed the chain pinned, and the SHA-256 of the bundle file as received |

Amounts are shown in the bundle's currency (`policy.document.currency`, by default USDC with 6 decimals) with every
decimal place, exactly as the receipts record them. Lightning (L402) settlements are recorded by the gateway in the same
currency at the rate it used; the statement shows that recorded amount and marks the payee line `lightning`.

## Reconciliation

With `--provider-total AMOUNT` the statement compares the provider's figure for the period with what the bundle settled
(to one payee when `--payee ADDRESS` names it; otherwise to all payees). The difference is `provider minus statement`.
The record can account for a difference in three ways, each with a fixed direction:

| Item | Direction | Why a provider's figure may differ |
|---|---|---|
| subscription charges in the period | subtracted | a provider may invoice subscriptions separately from usage |
| settlements within `--boundary-days` (default 2) before or after the period | added | a provider may bill by its own clock |
| payments allowed at the quote or charge stage but never settled | added | a provider may have delivered and billed anyway |

The verdict is one of three: **matches** (no difference); **explained**, when the difference equals one of these items or
a combination of them, named so the client can confirm with the provider that its figure treats them that way; or
**unexplained**, when it does not. An unexplained difference is reported whole as the remainder, with the items listed as
the places to look. Nothing is allocated partially and no figure is adjusted to fit.

## Usage

```bash
spendmarshal statement client-a.json --period 2026-10
spendmarshal statement client-a.json --period 2026-10 --provider-total 0.18 --payee 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --format html --out client-a-2026-10.html
```

| Option | Meaning |
|---|---|
| `--period 2026-10` or `--period 2026-10-01/2026-10-31` | A calendar month, or a date range with both days inclusive, in UTC. Without it the statement covers every receipt in the bundle and says so |
| `--provider-total AMOUNT` | The provider's figure in human units of the statement currency, with at most the currency's decimals |
| `--payee ADDRESS` | Reconcile one payee only, matched case-insensitively against the payee the receipts record |
| `--boundary-days N` | How far outside the period a settlement still counts as a boundary item (default 2; 0 turns it off) |
| `--format text`, `html` or `json`; `--out FILE` | Plain text (default), a self-contained page with no external assets, or the statement as data |
| `--gateway-key ADDRESS` (repeatable) | Keys the client trusts, passed to the verification exactly as `spendmarshal verify` takes them |
| `--unverified` | Produce the statement even when the bundle fails verification; the statement then carries NOT VERIFIED and names the failed checks |

Exit codes: 0 on success, 1 for usage, 2 when the file is not a bundle, the bundle does not verify (without
`--unverified`), or an option cannot be read.

## What it does not do

- It does not verify anchors on-chain; `spendmarshal verify --rpc URL` does. The statement says whether the latest anchor
  covers the period's last receipt.
- It does not read the provider's invoice. The provider's total is typed in, and the statement says what the record can
  and cannot account for.
- It does not convert currencies or guess at anything a receipt does not carry: a settlement without a readable amount is
  counted and noted, a denial without an amount is listed as such.
- It prints nothing a receipt does not already hold, and a bundle holds no prompts, responses or secrets (see the
  confidentiality note in the format specification).
