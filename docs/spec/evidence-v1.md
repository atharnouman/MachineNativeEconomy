# Evidence bundle format, version 1

Status: stable. Date: 18 October 2026.

An evidence bundle is one JSON document that records a principal's payment history: a hash-chained sequence of signed
receipts, the policy versions in force over time, the public view of every credential, the keys of the people who approve
escalations, and the on-chain anchors of the chain. Anyone holding the bundle can verify it offline, with no access to the
system that produced it.

This document defines the format and the checks a verifier performs. The key words MUST, MUST NOT, SHOULD and MAY are to
be read as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

Three files accompany it:

- `evidence-v1.schema.json`: the structure of a bundle, as JSON Schema (draft-07). It is normative for structure (section
  3).
- `vectors/`: test vectors, valid bundles and deliberately broken ones, each with the report a conforming verifier
  produces (section 12).
- `verify_bundle.py`: an independent verifier written from this document, using only the Python standard library.

Informative note: the format is produced by the SpendMarshal gateway, whose TypeScript verifier is
`verifyBundle` in `@spendmarshal/core`. Nothing in the normative text depends on that implementation.

## 1. Roles

- **Producer:** the system that writes receipts, signs them and exports the bundle.
- **Principal:** the organisation whose history the bundle records. Each principal has its own chain.
- **Gateway key:** the secp256k1 key that signs receipts. It can change over time (section 5).
- **Approver:** a person whose signature resolves an escalated payment. Their keys are recorded in the chain (section 8).
- **Verifier:** anyone who checks a bundle. The verifier MAY hold a list of gateway keys it already trusts (section 5.6).

## 2. Conventions

### 2.1 JSON

A bundle is a JSON text (RFC 8259) encoded in UTF-8. Producers SHOULD use only integers between −(2^53 − 1) and 2^53 − 1
for numbers; amounts and other large values are decimal strings. Verifiers parse numbers as IEEE 754 binary64 values.

### 2.2 Canonical form

The canonical form `canonical(x)` of a JSON value is:

| Value | Canonical form |
|---|---|
| object | `{`, then its members sorted by key in ascending order of UTF-16 code units, each as `canonical(key):canonical(value)`, separated by `,`, then `}`. A member whose value is absent (undefined) is omitted. |
| array | `[`, then the canonical forms of its elements in order, separated by `,`, then `]` |
| string | `"`, the string with `"` and `\` escaped as `\"` and `\\`, U+0008, U+0009, U+000A, U+000C and U+000D as `\b`, `\t`, `\n`, `\f` and `\r`, other characters below U+0020 and lone surrogates as `\u` followed by four lowercase hex digits, and every other character as itself, then `"` |
| number | ECMAScript `Number::toString` of the value: the shortest decimal that round-trips, in fixed notation when 10^−6 ≤ \|x\| < 10^21 or x is 0 (`0`, `42`, `0.5`, `0.000001`), in exponent notation otherwise (`1e+21`, `1e-7`, `1.5e-7`); −0 is `0` |
| true, false, null | `true`, `false`, `null` |

There is no whitespace anywhere. Informative note: this is ECMAScript `JSON.stringify` applied to the value with every
object's keys sorted.

### 2.3 Hashes

`H(x)` is Keccak-256 of the UTF-8 bytes of `canonical(x)`. It is written as `0x` followed by 64 lowercase hex digits.
Keccak-256 is the hash used by Ethereum, with padding byte 0x01; it is not SHA3-256 (FIPS 202), which pads with 0x06.

### 2.4 Addresses

An address is 20 bytes, written as `0x` followed by 40 hex digits in either case. Addresses compare case-insensitively.
The address of a secp256k1 public key is the last 20 bytes of the Keccak-256 hash of the 64-byte uncompressed public key
(without its 0x04 prefix).

### 2.5 Signatures

A signature is a secp256k1 ECDSA signature of 65 bytes `r ‖ s ‖ v`, written as `0x` followed by 130 hex digits, where
`v` is 27 or 28 (0 and 1 are accepted as the same recovery ids). A signature is *made by* an address when public-key
recovery (SEC 1, section 4.1.6) over the digest yields that address. All signatures in a bundle are EIP-191 personal
messages:

- **Over a hash** `h` (32 bytes): the digest is `Keccak-256("\x19Ethereum Signed Message:\n32" ‖ h)`.
- **Over a text message** `m`: the digest is `Keccak-256("\x19Ethereum Signed Message:\n" ‖ len ‖ m)`, where `len` is the
  decimal length of `m` in bytes, in ASCII.

### 2.6 Timestamps

Timestamps are RFC 3339 date-times in UTC with the `Z` suffix, with optional fractional seconds, for example
`2026-10-18T09:00:00.000Z`. They compare as instants at millisecond precision: digits beyond milliseconds are ignored.

## 3. The bundle

A bundle is a JSON object with these members:

| Member | Type | Meaning |
|---|---|---|
| `v` | `1` | format version |
| `principalId` | string | the principal whose chain this is |
| `exportedAt` | timestamp | when the bundle was produced (informative) |
| `gateway` | object `{ address, chain }` | `address`: the gateway key in force at the end of the chain; `chain`: the CAIP-2 chain id of the anchors, e.g. `eip155:8453` |
| `gatewayKeyHistory` | array, default `[]` | every change of the gateway key in the chain (section 5.5) |
| `contracts` | object of strings | contract addresses the producer used (informative) |
| `policy` | object `{ hash, document }` | the active policy and its hash (section 6) |
| `policyVersions` | array, default `[]` | every policy version (section 6) |
| `approvers` | object, default `{}` | approver id → address, as configured when the bundle was exported (section 8.4) |
| `approverHistory` | object of arrays, default `{}` | approver id → every key the approver held in the chain (section 8.3) |
| `credentials` | array | public views of the principal's credentials (section 7) |
| `receipts` | array | the principal's receipt chain, in order (section 4) |
| `anchors` | array | on-chain anchors of the chain (section 9) |

`evidence-v1.schema.json` defines the type of every member, nested ones included. A bundle that does not conform to it
fails the `schema` check (section 11). A member with a default MAY be absent; the verifier then uses the default.

Unknown members of the bundle, and of objects other than receipts and `holder_key` caveats' `jwk`, do not fail the schema.
Checks ignore them unless an object containing them is hashed or compared as a whole: then they count, and the hash or
comparison fails.

**Every hash and every comparison in this document is computed on the bundle exactly as given.** A verifier MUST NOT
normalise a bundle first (fill defaults, drop unknown members, reorder arrays) before hashing or comparing.

## 4. Receipts

### 4.1 Members

| Member | Type | Required |
|---|---|---|
| `v` | `1` | yes |
| `id` | non-empty string, unique in practice | yes |
| `principalId` | non-empty string | yes |
| `seq` | non-negative integer | yes |
| `prev` | hash, or `null` | yes |
| `ts` | timestamp | yes |
| `kind` | one of the kinds in 4.5 | yes |
| `agentId`, `credentialId`, `intentId`, `approvalId`, `subscriptionId` | string | no |
| `intentHash`, `policyHash` | hash | no |
| `rail` | `x402`, `mpp` or `l402` | no |
| `data` | object | yes |
| `hash` | hash (lowercase hex) | yes |
| `sig` | signature (lowercase hex) | yes |

A receipt MUST NOT contain any other member: its signature would not cover it. The schema rejects a receipt with an
unknown member.

### 4.2 Hash and signature

The body of a receipt is the receipt without its `hash` and `sig` members. A receipt is intact when:

1. `hash = H(body)`, and
2. `sig` is made by the gateway key in force at the receipt's position (section 5.3), over the 32 bytes of `hash`
   (section 2.5, "over a hash").

### 4.3 The chain

The receipts of a bundle form one chain. For the receipt at position `i` (from 0):

- `seq` is the previous receipt's `seq` plus one, and 0 for the first receipt;
- `prev` is the previous receipt's `hash`, and `null` for the first receipt.

### 4.4 What the chain proves

An intact chain shows that the producer signed every receipt, in this order, and that none was changed, removed or
inserted between the first receipt and the last one exported. Whether receipts were left off the end is answered by the
anchors (section 9).

### 4.5 Kinds

`credential.issued`, `credential.registered`, `decision`, `payment.settled`, `payment.denied`, `onchain.denied`,
`preapproval.reclaimed`, `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired`,
`approval.consumed`, `approver.registered`, `approver.removed`, `policy.updated`, `subscription.created`,
`subscription.charged`, `subscription.refused`, `subscription.cancelled`, `killswitch`, `evidence.anchored`,
`gateway.key.rotated`, `external`.

The checks read these `data` members; the rest of `data` is informative and covered by the receipt's hash like everything
else:

| Kind | `data` members the checks read |
|---|---|
| `decision` | `effect`: `allow`, `deny` or `escalate` |
| `gateway.key.rotated` | `prevAddress`, `address`, `handover` (section 5) |
| `approver.registered` | `approverId`, `address`, `prevAddress` (section 8) |
| `approver.removed` | `approverId`, `prevAddress` (section 8) |
| `approval.granted`, `approval.rejected` | `approval` (`id`, `principalId`, `intentHash`, `amount`) and `approver` (`id`, `method`, optional `address` and `signature`) (section 8.6) |
| `evidence.anchored` | `head`, `count`, `party`, `txHash` (section 9) |

## 5. Gateway keys

### 5.1 Rotation receipts

A receipt of kind `gateway.key.rotated` records a change of the gateway key. It is *well-formed* when its `data` has:

- `prevAddress`: an address, the key being replaced;
- `address`: an address, the key that signs this receipt and the ones after it;
- `handover`: `null`, or a hex string `0x…`, a signature by `prevAddress` (section 5.2).

### 5.2 Handover message

A handover is `prevAddress`'s signature, over a text message (section 2.5), of these six lines joined by a single line feed
(U+000A), with no line feed at the end:

```
spendmarshal-gateway-key-handover v1
principal=<the rotation receipt's principalId>
seq=<the rotation receipt's seq, in decimal>
prev=<the rotation receipt's prev, or null>
from=<prevAddress, in lowercase>
to=<address, in lowercase>
```

The first line is a fixed domain-separation string. A handover holds for one chain at one position, and nowhere else.

### 5.3 The key in force

- Before the first well-formed rotation, the key in force is that rotation's `prevAddress`. If the chain has no
  well-formed rotation, it is `gateway.address`.
- At each well-formed rotation, the key in force becomes its `address`. The rotation receipt itself is signed by the new
  key.

### 5.4 Chain rules for rotations

Walking the chain in order, each of these is a problem:

- a `gateway.key.rotated` receipt that is not well-formed (the key in force does not change);
- a rotation whose `prevAddress` is not the key in force;
- a rotation whose `address` is already the key in force;
- a rotation whose `handover` is not `null` and is not made by `prevAddress` over the message of section 5.2;
- after the last receipt, if the chain has at least one well-formed rotation, a key in force other than `gateway.address`.

These problems, and every receipt that is not intact or not linked (sections 4.2 and 4.3), make the `receipts.chain` check
fail.

### 5.5 Key history

The key history of a chain is the list, in chain order, of one entry per well-formed rotation:

```
{ address, prevAddress, seq, effectiveFrom, receiptId, handedOver }
```

`seq`, `effectiveFrom` (the receipt's `ts`) and `receiptId` (its `id`) describe the rotation receipt. `handedOver` is
`true` when its `handover` is not `null`. The `gateway.keys` check passes when `canonical(gatewayKeyHistory)` equals the
canonical form of the computed history. The check is reported only when the chain has a well-formed rotation or the
exported history is not empty.

### 5.6 Trust

An intact chain shows which keys signed it, not that they belong to the same producer. The `gateway.trusted` check answers
that.

- **With trusted keys** (a list the verifier supplies):
  - Split the chain into segments: the first key from position 0, then each rotation's `address` from the rotation's
    position.
  - A segment is *vouched for* when its key is trusted.
  - Walking forward, a segment is also vouched for when the one before it is vouched for and the rotation into it has a
    handover.
  - Walking backward, a segment is also vouched for when the one after it is vouched for and the rotation into that next
    segment has a handover.
  - The check passes when the chain passes `receipts.chain` and every segment is vouched for. A chain with no receipts
    passes.
- **Without trusted keys:** the check is reported only when some well-formed rotation has no handover, and then it fails.
  Handovers alone link every key to the first one.

## 6. Policy

### 6.1 Active policy

The `policy.hash` check passes when `H(policy.document) = policy.hash`.

### 6.2 Versions

Sort `policyVersions` by `version`. The `policy.versions` check passes when all of these hold:

- for each version, `H(document) = hash`;
- the versions are numbered 1, 2, …, n;
- the first version's `prevHash` is `null`, and each later version's `prevHash` is the previous version's `hash`;
- no version's `activatedAt` is earlier than the previous version's;
- if there is at least one version, the last version's `hash` equals `policy.hash`.

### 6.3 Receipts cite the version in force

The version active at a time `t` is the last version whose `activatedAt` is at or before `t`; there is none when every
version is later. When `policyVersions` is empty, the active policy hash is `policy.hash` at every time.

The `receipts.policyHash` check passes when every receipt that has a `policyHash` cites the hash of the version active at
its `ts`.

## 7. Credentials

### 7.1 Public view

A credential's public view has the members `v` (1), `id`, `rootId`, `principalId`, `agentId`, `parentId` (string or
`null`) and `caveats`. A caveat is an object whose `type` is one of:

| `type` | other members |
|---|---|
| `delegate` | `agentId`, `nonce` (strings) |
| `spend_cap`, `per_tx_max` | `value`: decimal string |
| `expires_at`, `not_before` | `value`: timestamp |
| `allowed_payees`, `purposes` | `value`: non-empty array of non-empty strings |
| `allowed_rails` | `value`: non-empty array of `x402`, `mpp`, `l402` |
| `chains` | `value`: non-empty array of `eip155:<decimal>` |
| `rate_limit` | `window` (duration such as `10m`), optional `max_count` (positive integer), optional `max_amount` (decimal string) |
| `holder_key` | `jwk`: exactly `{ kty: "OKP", crv: "Ed25519", x }` |

### 7.2 Identifiers

The `credentials.ids` check passes when, for every credential, `id` is `rootId`, then `:`, then the first 16 hex digits of
`H(caveats)` after the `0x`.

### 7.3 Delegation only narrows

The effective limits of a list of caveats are:

| Dimension | Value | Unrestricted when |
|---|---|---|
| spend cap, per-transaction maximum | the smallest `value` of that type | no caveat of that type |
| expiry | the earliest `expires_at` | none |
| not-before | the latest `not_before` | none |
| payees | the intersection of every `allowed_payees` list, compared in lowercase | none |
| rails, purposes, chains | the intersection of every list of that type | none |
| rate limits | the set of distinct `rate_limit` caveats, compared by the canonical form of their `type`, `window`, `max_count` and `max_amount` | (an empty set) |
| holder key | the `jwk` of the last `holder_key` caveat | none |

A child's limits are within its parent's when, for every dimension the parent restricts:

- spend cap and per-transaction maximum: the child restricts it to a value no greater than the parent's;
- expiry: the child restricts it to a time no later than the parent's;
- not-before: the child restricts it to a time no earlier than the parent's;
- payees, rails, purposes, chains: the child restricts it to a subset of the parent's;
- rate limits: every parent rate limit is among the child's;
- holder key: the child has one.

The `credentials.monotonic` check passes when every credential with a `parentId`:

- has its parent in the bundle,
- has limits within its parent's, and
- extends its parent's caveats: the parent's caveats are a prefix of the child's, caveat by caveat, compared by canonical
  form.

## 8. Approvers and approvals

### 8.1 Approver receipts

- `approver.registered`: from this position, `data.address` signs for `data.approverId`. `data.prevAddress` is the key it
  replaces, or `null` for the approver's first key.
- `approver.removed`: from this position, `data.approverId` has no key. `data.prevAddress` is the key it held.

Either is *well-formed* when `approverId` is a non-empty string and, for `approver.registered`, `address` is an address.

### 8.2 History rules

Walk the chain keeping, for each approver id, the key it holds (initially none). Each of these is a problem:

- an approver receipt that is not well-formed;
- an `approver.removed` for an approver that holds no key;
- a `prevAddress` (read as none when it is not a string) other than the key the approver held.

After each well-formed receipt the approver holds its `address`, or no key after a removal.

### 8.3 History

An approver's history is the list, in chain order, of one entry per well-formed approver receipt for it:

```
{ address, seq, effectiveFrom, receiptId }
```

`address` is `null` for a removal. The `approvers.history` check passes when there is no problem under 8.2 and, for every
approver id in either, the exported `approverHistory` entry (an empty list when missing) equals the computed history by
canonical form.

### 8.4 The key an approver held at a position

For approver `a` and position `p` (a receipt's `seq`):

1. If `a` has a history entry with `seq < p`, the last such entry decides: its `address`, or no key when it is `null`.
2. Otherwise, if any approver's first history entry has `seq < p`, `a` has no key: the chain kept approver keys by then.
3. Otherwise, if `a` has a history, its first entry's `address` (a resolution from before the chain kept keys).
4. Otherwise, `approvers[a]`, if `approvers` has `a` as its own member.
5. Otherwise, no key.

### 8.5 Approval message

An approver signs, over a text message (section 2.5), these six lines joined by a single line feed, with no line feed at
the end:

```
spendmarshal-approval v1
id=<approval.id>
principal=<approval.principalId>
intentHash=<approval.intentHash>
amount=<approval.amount>
verdict=<approve or reject>
```

The first line is a fixed domain-separation string.

### 8.6 The approvals check

Walk the chain. The check fails on any of these problems:

- An `approval.consumed` receipt whose `approvalId` is missing, or names no approval granted earlier in the chain.
- An `approval.granted` or `approval.rejected` receipt whose `data.approver.method` is `signature`, when any of these
  holds:
  - its approver (`data.approver.id`) has no key at the receipt's `seq` (8.4);
  - `data.approver.signature` is not a string, or `data.approval` is missing;
  - `data.approver.address` is present and is not that key;
  - the signature is not made by that key over the approval message of `data.approval` (8.5), with verdict `approve` for a
    grant and `reject` for a rejection.

An `approval.granted` receipt with an `approvalId` grants that approval, whatever its method.

## 9. Anchors

### 9.1 Members

An anchor has:

- `head`: a receipt hash;
- `count`: the number of receipts it covers;
- `txHash`: the transaction that sent it;
- `blockNumber`: a decimal string;
- `registry`: the registry contract's address;
- `party` (optional): the address that sent the anchor.

Unknown members are ignored.

### 9.2 The anchors check

The `anchors.match` check passes when every anchor:

- has a receipt at position `count − 1` whose `hash` is `head`, and
- if it names a `party`, is recorded by an `evidence.anchored` receipt in the chain. That receipt's `data` has the same
  `head`, `count`, `party` and `txHash`: `head`, `party` and `txHash` compare case-insensitively, `count` as a decimal
  number.

Informative: an anchor is confirmed on-chain, outside this offline report, by calling `anchoredAt(party, head)` on the
registry and getting a non-zero block. An anchor without a `party` was sent by the gateway key in force at position
`count − 1`.

## 10. Settlements

The `settlements.have_allow_decision` check passes when every `payment.settled` receipt has an `intentId`, and a
`decision` receipt with `data.effect` equal to `allow` and the same `intentId` comes earlier in the chain.

## 11. The report

A verifier produces a report: an ordered list of checks, each passed or failed, with an optional detail for people. These
are the checks, in this order:

| # | Check | Section | Reported |
|---|---|---|---|
| 1 | `schema` | 3 | always |
| 2 | `policy.hash` | 6.1 | always |
| 3 | `policy.versions` | 6.2 | always |
| 4 | `receipts.chain` | 4.2, 4.3, 5.4 | always |
| 5 | `gateway.keys` | 5.5 | when the chain has a well-formed rotation, or the exported history is not empty |
| 6 | `gateway.trusted` | 5.6 | with trusted keys always; without them only when a rotation has no handover |
| 7 | `receipts.policyHash` | 6.3 | always |
| 8 | `credentials.ids` | 7.2 | always |
| 9 | `credentials.monotonic` | 7.3 | always |
| 10 | `anchors.match` | 9.2 | always |
| 11 | `settlements.have_allow_decision` | 10 | always |
| 12 | `approvers.history` | 8.3 | always |
| 13 | `approvals` | 8.6 | always |

If `schema` fails, the report holds only that check. A bundle verifies when every check in its report passes. Details are
informative and differ between verifiers.

## 12. Test vectors

`vectors/` holds one JSON file per vector, with these members:

- `format`: `"evidence-v1"`;
- `name` and `description`;
- `options` (optional): `{ trustedGatewayKeys: [...] }`;
- `expected`: `{ ok, checks: [{ check, ok }, …] }`;
- `bundle`: the bundle.

A conforming verifier, given the bundle and the options, produces exactly the expected checks: the same names, in the same
order, with the same results.

The vectors are generated from the producer itself, with a fixed clock and fixed ids, so regenerating them yields the same
bytes:

```
npx tsx packages/gateway/scripts/gen-evidence-spec.ts
```

Every broken vector changes one thing and states which checks it is meant to fail; generation stops if the reference
verifier disagrees. The signing keys are well-known development keys that hold nothing.

Running the verifiers against the vectors:

```
pnpm --filter @spendmarshal/core exec vitest run test/evidence-vectors.test.ts
python docs/spec/verify_bundle.py --vectors docs/spec/vectors
```

## 13. Versioning

This is version 1 (`v: 1`). Within version 1, members, hashes, messages, receipt kinds and checks do not change. Anything
that would change a verifier's report for an existing bundle, including a new receipt kind, which version 1 verifiers
reject, needs version 2 and new vectors. A verifier MUST refuse a bundle whose `v` it does not implement.

## 14. Security considerations (informative)

- **Keys.** The format proves which keys signed what; trusting those keys is the verifier's decision. Pin the producer's
  published keys (section 5.6). A chain continued without a handover is consistent but unvouched until its keys are pinned.
- **Completeness.** The chain proves nothing about receipts after the last one exported. An anchor proves that a prefix of
  the chain existed by a block; receipts after the last anchor rest on the producer's signature alone.
- **Binding.** Handover and approval messages name the principal, position or intent, and amount they apply to, so a
  signature cannot be replayed elsewhere. Receipts carry no member their signature does not cover.
- **Confidentiality.** A bundle is evidence, not a secret: it holds no credential signatures or private keys, but it
  reveals payees, amounts and policies. Share it accordingly.
- **Time.** Timestamps are the producer's claim. Anchors bound them from above by block time.
