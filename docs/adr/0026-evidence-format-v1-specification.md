# ADR-0026: The evidence bundle as a specification, with test vectors and a second verifier

Date: 18 October 2026. Status: accepted.

## Context

The evidence bundle was defined only by the TypeScript verifier, `verifyBundle` in core. A format that auditors and other
systems are meant to check, and perhaps emit, needs a written specification, test vectors and an implementation that
shares no code with the producer.

Writing the specification exposed four places where the verifier's behaviour came from its implementation rather than
from a rule anyone could restate.

1. **It hashed a normalised copy.** It parsed the bundle with zod, which drops unknown members and fills defaults, and then
   computed policy hashes, credential ids and history comparisons on that copy. Another implementation could only agree by
   copying zod's behaviour. A default added to the policy schema in a later version would also change the hash of every
   older document that lacked it.
2. **Unsigned data could ride inside a receipt.** Unknown top-level members of a receipt were dropped before hashing, so a
   bundle could carry data next to a signed receipt that the signature did not cover, and verify.
3. **Order was not checked.** A settlement needed an allow decision for its intent somewhere in the bundle, not before it.
   A consumed approval needed a grant anywhere, even after the consumption.
4. **A malformed signature crashed it.** A receipt signature of the wrong length made the verifier throw instead of failing
   a check.

## Decisions

1. **Four files in `docs/spec` define format version 1.**
   - `evidence-v1.md` is the specification: canonical JSON, Keccak-256, EIP-191 signatures, receipts and the chain,
     gateway key history and trust, policy versions, credentials, approver key history and approvals, anchors,
     settlements, and the report of 13 checks in a fixed order. Its normative text names no product; the two signed
     message headers are fixed domain-separation strings.
   - `evidence-v1.schema.json` is the bundle's structure as JSON Schema. It is generated from the verifier's zod schemas,
     with timestamps restricted to UTC and unknown members allowed wherever zod ignores them.
   - `vectors/` holds 34 vectors: 10 valid bundles and 24 broken ones, each with the exact report a conforming verifier
     produces.
   - `verify_bundle.py` is an independent verifier, written from the specification, using only the Python standard
     library, with Keccak-256 and secp256k1 recovery implemented inline.
2. **Every hash and every comparison reads the bundle exactly as given.** The schema check only checks types. Policy
   hashes, credential ids, the caveat-prefix rule and both key-history comparisons now run on the input, not on zod's copy.
3. **A receipt may hold only the members the format defines.** The schema rejects any other member, so nothing unsigned
   travels inside a receipt.
4. **Order counts.** A settlement needs an allow decision for its intent earlier in the chain, and a consumed approval
   needs a grant earlier in the chain.
5. **A malformed signature is a failed check,** never an exception.
6. **Conformance is tested on every run.** Both verifiers must produce, for every vector, the same checks in the same order
   with the same results. Core's tests run the TypeScript verifier against the vectors, and the Python verifier wherever
   Python 3.8 or later is installed.
7. **The vectors come from the producer itself.** `packages/gateway/scripts/gen-evidence-spec.ts` builds them with the real
   gateway, a fixed clock and seeded ids, so regenerating them writes the same bytes. Each broken vector changes one thing
   and states the checks it is meant to fail; generation stops if the reference verifier disagrees.
8. **Version 1 is frozen.** Any change to members, hashing, messages, receipt kinds or checks that would change a report
   for an existing bundle needs version 2 and new vectors.

Rejected:

- **Specifying the normalisation instead:** every implementer would have to reproduce zod's semantics, and defaults added
  later would still rewrite old hashes.
- **A Python verifier built on libraries** (eth-hash, coincurve): with the standard library only, the verifier is short,
  auditable and has no supply chain. Its speed is irrelevant for evidence; it checks all 34 vectors in about two seconds.
- **A hand-written schema:** generating it from the verifier's own types keeps the two from drifting apart.

## Consequences

- The three committed sample bundles (thin slice, Phase 1 and the live Base Sepolia run) give byte-identical reports with
  the TypeScript CLI before and after the change. The Python verifier also verifies all three (11 of 11 checks).
- A bundle the old verifier accepted now fails if it has any of these:
  - an unknown member in a receipt;
  - a policy document, credential or key history that differs from its hashed or exported form;
  - a settlement before its allow decision;
  - a consumption before its grant.

  The gateway never produced such bundles.
- After any change to the verifier or the export, regenerate the vectors and review the diff:
  `npx tsx packages/gateway/scripts/gen-evidence-spec.ts`.
- New tests:
  - `evidence-as-given.test.ts` (6) for the rules above;
  - `evidence-vectors.test.ts` (35) for the TypeScript verifier against every vector;
  - `evidence-python.test.ts` (1) for the Python verifier against every vector.
