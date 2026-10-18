#!/usr/bin/env python3
"""Independent verifier for evidence bundles, format version 1 (evidence-v1.md).

Written from the specification alone, with nothing but the Python standard library: Keccak-256 and secp256k1 public-key
recovery are implemented below. It shows that the format can be verified without the producer's code, and checks the
test vectors. Pure-Python arithmetic makes it slow: fine for checking evidence, not for throughput.

    python verify_bundle.py BUNDLE.json [--trust 0xADDRESS ...]    # verify one bundle; exit 0 when it verifies
    python verify_bundle.py --vectors vectors/                      # check every test vector; exit 0 when all agree

Requires Python 3.8 or later.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

# ───────────────────────────── Keccak-256 (section 2.3) ─────────────────────────────

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800A, 0x800000008000000A, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
# rotation offsets r[x][y]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M64 = (1 << 64) - 1


def _keccak_f(a: list[int]) -> list[int]:
    for rc in _RC:
        c = [a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] for x in range(5)]
        d = [c[(x - 1) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & _M64) for x in range(5)]
        a = [a[i] ^ d[i % 5] for i in range(25)]
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                r = _ROT[x][y]
                v = a[x + 5 * y]
                b[y + 5 * ((2 * x + 3 * y) % 5)] = ((v << r) | (v >> (64 - r))) & _M64 if r else v
        a = [b[i] ^ ((~b[(i % 5 + 1) % 5 + 5 * (i // 5)]) & b[(i % 5 + 2) % 5 + 5 * (i // 5)]) for i in range(25)]
        a[0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    """Keccak-256 as Ethereum uses it: padding byte 0x01, not SHA3-256's 0x06."""
    rate = 136
    msg = bytearray(data)
    msg.append(0x01)
    while len(msg) % rate:
        msg.append(0)
    msg[-1] |= 0x80
    state = [0] * 25
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            state[i] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
        state = _keccak_f(state)
    return b"".join(state[i].to_bytes(8, "little") for i in range(4))


# ───────────────────────────── secp256k1 recovery (section 2.5) ─────────────────────────────

_P = 2**256 - 2**32 - 977
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def _jac_double(p):
    x, y, z = p
    if y == 0:
        return (0, 1, 0)
    s = 4 * x * y * y % _P
    m = 3 * x * x % _P
    nx = (m * m - 2 * s) % _P
    return (nx, (m * (s - nx) - 8 * pow(y, 4, _P)) % _P, 2 * y * z % _P)


def _jac_add(p, q):
    if p[2] == 0:
        return q
    if q[2] == 0:
        return p
    x1, y1, z1 = p
    x2, y2, z2 = q
    z1z1, z2z2 = z1 * z1 % _P, z2 * z2 % _P
    u1, u2 = x1 * z2z2 % _P, x2 * z1z1 % _P
    s1, s2 = y1 * z2 * z2z2 % _P, y2 * z1 * z1z1 % _P
    if u1 == u2:
        return _jac_double(p) if s1 == s2 else (0, 1, 0)
    h, r = (u2 - u1) % _P, (s2 - s1) % _P
    hh = h * h % _P
    hhh = h * hh % _P
    v = u1 * hh % _P
    nx = (r * r - hhh - 2 * v) % _P
    return (nx, (r * (v - nx) - s1 * hhh) % _P, h * z1 * z2 % _P)


def _mul(point, k: int):
    acc = (0, 1, 0)
    add = (point[0], point[1], 1)
    while k:
        if k & 1:
            acc = _jac_add(acc, add)
        add = _jac_double(add)
        k >>= 1
    return acc


def _affine(p):
    if p[2] == 0:
        return None
    zi = pow(p[2], -1, _P)
    return (p[0] * zi * zi % _P, p[1] * zi * zi * zi % _P)


def recover_address(digest: bytes, signature: str) -> str | None:
    """The address whose key made `signature` over `digest`, or None when the signature is malformed."""
    if not isinstance(signature, str) or not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature, re.ASCII):
        return None
    raw = bytes.fromhex(signature[2:])
    r, s, v = int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:64], "big"), raw[64]
    rec = v - 27 if v in (27, 28) else v if v in (0, 1) else None
    if rec is None or not (1 <= r < _N and 1 <= s < _N):
        return None
    y2 = (pow(r, 3, _P) + 7) % _P
    y = pow(y2, (_P + 1) // 4, _P)
    if y * y % _P != y2:
        return None
    if y % 2 != rec:
        y = _P - y
    e = int.from_bytes(digest, "big") % _N
    ri = pow(r, -1, _N)
    q = _affine(_jac_add(_mul((r, y), s * ri % _N), _mul(_G, (-e * ri) % _N)))
    if q is None:
        return None
    return "0x" + keccak256(q[0].to_bytes(32, "big") + q[1].to_bytes(32, "big"))[-20:].hex()


def digest_of_hash(h: str) -> bytes:
    return keccak256(b"\x19Ethereum Signed Message:\n32" + bytes.fromhex(h[2:]))


def digest_of_text(message: str) -> bytes:
    m = message.encode("utf-8")
    return keccak256(b"\x19Ethereum Signed Message:\n" + str(len(m)).encode() + m)


def same(a, b) -> bool:
    """Addresses compare case-insensitively (section 2.4); a missing address equals only another missing one."""
    return (a or "").lower() == (b or "").lower()


# ───────────────────────────── canonical JSON (section 2.2) ─────────────────────────────

def js_number(x) -> str:
    """ECMAScript Number::toString for the binary64 value of x."""
    if isinstance(x, int) and abs(x) < 2**53:
        return str(x)
    x = float(x)
    if x != x or x in (float("inf"), float("-inf")):
        return "null"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    text = repr(abs(x))  # the shortest decimal that round-trips
    mant, _, exp = text.partition("e")
    whole, _, frac = mant.partition(".")
    digits = (whole + frac).lstrip("0")
    e10 = (int(exp) if exp else 0) - len(frac)
    stripped = digits.rstrip("0")
    e10 += len(digits) - len(stripped)
    digits = stripped
    k, n = len(digits), len(digits) + e10
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def js_string(s: str) -> str:
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch in "\b\f\n\r\t":
            out.append({"\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}[ch])
        elif c < 0x20 or 0xD800 <= c <= 0xDFFF:
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical(v) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return js_number(v)
    if isinstance(v, str):
        return js_string(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be", "surrogatepass"))  # UTF-16 code unit order
        return "{" + ",".join(js_string(k) + ":" + canonical(v[k]) for k in keys) + "}"
    raise TypeError(f"not JSON: {type(v)}")


def H(v) -> str:
    return "0x" + keccak256(canonical(v).encode("utf-8")).hex()


def js_text(v, present: bool = True) -> str:
    """How ECMAScript turns a value into text inside a template or String(): for the signed messages and anchor ids."""
    if not present:
        return "undefined"
    if v is None:
        return "null"
    if v is True or v is False:
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return js_number(v)
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ",".join("" if x is None else js_text(x) for x in v)
    return "[object Object]"


def parse_json(text: str):
    """Numbers become binary64 values as in ECMAScript; NaN and Infinity are not JSON."""

    def integer(s: str):
        i = int(s)
        return i if abs(i) < 2**53 else float(i)

    def constant(s: str):
        raise ValueError(f"{s} is not JSON")

    return json.loads(text, parse_int=integer, parse_constant=constant)


# ───────────────────────────── timestamps (section 2.6) ─────────────────────────────

_UTC = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z", re.ASCII)


def ms(ts: str) -> int:
    m = _UTC.fullmatch(ts)
    if not m:
        raise ValueError(f"not a UTC timestamp: {ts}")
    y, mo, d, h, mi, s, frac = m.groups()
    dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), tzinfo=timezone.utc)
    return int(dt.timestamp()) * 1000 + int(((frac or "") + "000")[:3])


def valid_timestamp(ts) -> bool:
    try:
        return isinstance(ts, str) and int(ts[11:13]) < 24 and ms(ts) is not None
    except (ValueError, IndexError):
        return False


# ───────────────────────────── structure (section 3; evidence-v1.schema.json) ─────────────────────────────

class SchemaError(Exception):
    pass


def _json_type(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int) or (isinstance(v, float) and v == int(v) and abs(v) < 2**63):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    raise SchemaError("not JSON")


def validate(v, s: dict, path: str = "$") -> None:
    """The draft-07 keywords the format's schema uses; any other keyword is an error in this verifier, not in the bundle."""
    for kw in s:
        if kw not in {"$schema", "$id", "title", "description", "default", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "pattern", "minLength", "minItems", "minimum", "exclusiveMinimum", "anyOf", "format"}:
            raise NotImplementedError(f"schema keyword {kw}")
    if "anyOf" in s:
        for alt in s["anyOf"]:
            try:
                validate(v, alt, path)
                break
            except SchemaError:
                continue
        else:
            raise SchemaError(f"{path}: matches none of the allowed forms")
    if "type" in s:
        t = _json_type(v)
        allowed = s["type"] if isinstance(s["type"], list) else [s["type"]]
        if not (t in allowed or (t == "integer" and "number" in allowed)):
            raise SchemaError(f"{path}: expected {'/'.join(allowed)}, got {t}")
    if "const" in s and not (v == s["const"] and type(v) is not bool or v is s["const"]):
        raise SchemaError(f"{path}: must be {s['const']!r}")
    if "enum" in s and v not in s["enum"]:
        raise SchemaError(f"{path}: must be one of {s['enum']}")
    if isinstance(v, str):
        if "minLength" in s and len(v) < s["minLength"]:
            raise SchemaError(f"{path}: shorter than {s['minLength']}")
        if "pattern" in s and not re.search(s["pattern"], v, re.ASCII):
            raise SchemaError(f"{path}: does not match {s['pattern']}")
        if s.get("format") == "date-time" and not valid_timestamp(v):
            raise SchemaError(f"{path}: not a UTC date-time")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in s and v < s["minimum"]:
            raise SchemaError(f"{path}: below {s['minimum']}")
        if "exclusiveMinimum" in s and v <= s["exclusiveMinimum"]:
            raise SchemaError(f"{path}: not above {s['exclusiveMinimum']}")
    if isinstance(v, list):
        if "minItems" in s and len(v) < s["minItems"]:
            raise SchemaError(f"{path}: fewer than {s['minItems']} items")
        if "items" in s:
            for i, x in enumerate(v):
                validate(x, s["items"], f"{path}[{i}]")
    if isinstance(v, dict):
        props = s.get("properties", {})
        for name in s.get("required", []):
            if name not in v:
                raise SchemaError(f"{path}: missing {name}")
        for name, x in v.items():
            if name in props:
                validate(x, props[name], f"{path}.{name}")
            else:
                extra = s.get("additionalProperties", True)
                if extra is False:
                    raise SchemaError(f"{path}: unknown member {name}")
                if isinstance(extra, dict):
                    validate(x, extra, f"{path}.{name}")


# ───────────────────────────── the checks ─────────────────────────────

ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}", re.ASCII)
HEX = re.compile(r"0x[0-9a-fA-F]+", re.ASCII)


def is_address(v) -> bool:
    return isinstance(v, str) and ADDRESS.fullmatch(v) is not None


def rotation_of(r: dict):
    """A well-formed gateway.key.rotated receipt's data, or None (section 5.1)."""
    if r.get("kind") != "gateway.key.rotated":
        return None
    d = r["data"]
    if not is_address(d.get("prevAddress")) or not is_address(d.get("address")):
        return None
    if "handover" not in d or not (d["handover"] is None or (isinstance(d["handover"], str) and HEX.fullmatch(d["handover"]))):
        return None
    return d


def key_history(receipts: list) -> list:
    out = []
    for r in receipts:
        d = rotation_of(r)
        if d is not None:
            out.append({"address": d["address"], "prevAddress": d["prevAddress"], "seq": r["seq"], "effectiveFrom": r["ts"], "receiptId": r["id"], "handedOver": d["handover"] is not None})
    return out


def handover_message(r: dict, d: dict) -> str:
    return "\n".join(["spendmarshal-gateway-key-handover v1", f"principal={r['principalId']}", f"seq={js_number(r['seq'])}", f"prev={js_text(r['prev'])}", f"from={d['prevAddress'].lower()}", f"to={d['address'].lower()}"])


def verify_chain(receipts: list, gateway: str) -> tuple[bool, list, list]:
    """Sections 4.2, 4.3 and 5.4: every receipt intact, linked, and signed by the key in force at its position."""
    problems: list[str] = []
    keys = key_history(receipts)
    in_force = keys[0]["prevAddress"] if keys else gateway
    prev, seq = None, -1
    for r in receipts:
        if r["kind"] == "gateway.key.rotated":
            d = rotation_of(r)
            if d is None:
                problems.append(f"{r['id']}: malformed gateway.key.rotated")
            else:
                if not same(d["prevAddress"], in_force):
                    problems.append(f"{r['id']}: hands over from {d['prevAddress']}, but {in_force} was in force")
                elif same(d["address"], in_force):
                    problems.append(f"{r['id']}: rotates to the key already in force")
                if d["handover"] is not None and not same(recover_address(digest_of_text(handover_message(r, d)), d["handover"]), d["prevAddress"]):
                    problems.append(f"{r['id']}: handover is not signed by {d['prevAddress']}")
                in_force = d["address"]
        body = {k: x for k, x in r.items() if k not in ("hash", "sig")}
        if H(body) != r["hash"]:
            problems.append(f"{r['id']}: hash mismatch")
        else:
            signer = recover_address(digest_of_hash(r["hash"]), r["sig"])
            if signer is None:
                problems.append(f"{r['id']}: signature is malformed")
            elif not same(signer, in_force):
                problems.append(f"{r['id']}: signer {signer} is not the key in force")
        if r["prev"] != prev:
            problems.append(f"{r['id']}: prev link broken")
        if r["seq"] != seq + 1:
            problems.append(f"{r['id']}: seq {r['seq']} expected {seq + 1}")
        prev, seq = r["hash"], r["seq"]
    if keys and not same(in_force, gateway):
        problems.append(f"chain ends with key {in_force}, expected {gateway}")
    return not problems, problems, keys


def trusted(chain_ok: bool, keys: list, gateway: str, count: int, pinned: list) -> tuple[bool, str]:
    """Section 5.6 with trusted keys."""
    if not chain_ok:
        return False, "the receipt chain does not verify"
    if count == 0:
        return True, "no receipts"
    trust = {k.lower() for k in pinned}
    segments = [keys[0]["prevAddress"] if keys else gateway] + [k["address"] for k in keys]
    vouched = [s.lower() in trust for s in segments]
    for i in range(1, len(segments)):
        if not vouched[i] and vouched[i - 1] and keys[i - 1]["handedOver"]:
            vouched[i] = True
    for i in range(len(segments) - 2, -1, -1):
        if not vouched[i] and vouched[i + 1] and keys[i]["handedOver"]:
            vouched[i] = True
    if all(vouched):
        return True, "every key trusted or handed over from a trusted key"
    return False, f"key {segments[vouched.index(False)]} is neither trusted nor linked to a trusted key by handovers"


def effective_limits(caveats: list) -> dict:
    """Section 7.3."""
    e = {"spendCap": None, "perTxMax": None, "expiresAt": None, "notBefore": None, "payees": None, "rails": None, "purposes": None, "chains": None, "rateLimits": set(), "holderKey": None}

    def meet(cur, values):
        s = set(values)
        return s if cur is None else cur & s

    for c in caveats:
        t = c["type"]
        if t in ("spend_cap", "per_tx_max"):
            k = "spendCap" if t == "spend_cap" else "perTxMax"
            v = int(c["value"])
            e[k] = v if e[k] is None else min(e[k], v)
        elif t == "expires_at":
            d = ms(c["value"])
            e["expiresAt"] = d if e["expiresAt"] is None or d < e["expiresAt"] else e["expiresAt"]
        elif t == "not_before":
            d = ms(c["value"])
            e["notBefore"] = d if e["notBefore"] is None or d > e["notBefore"] else e["notBefore"]
        elif t == "allowed_payees":
            e["payees"] = meet(e["payees"], [x.lower() for x in c["value"]])
        elif t == "allowed_rails":
            e["rails"] = meet(e["rails"], c["value"])
        elif t == "purposes":
            e["purposes"] = meet(e["purposes"], c["value"])
        elif t == "chains":
            e["chains"] = meet(e["chains"], c["value"])
        elif t == "rate_limit":
            e["rateLimits"].add(canonical({k: c[k] for k in ("type", "window", "max_count", "max_amount") if k in c}))
        elif t == "holder_key":
            e["holderKey"] = c["jwk"]
    return e


def within(child: dict, parent: dict) -> list:
    """The dimensions in which a child's limits are not within its parent's (section 7.3)."""
    v = []
    for k in ("spendCap", "perTxMax"):
        if parent[k] is not None and (child[k] is None or child[k] > parent[k]):
            v.append(k)
    if parent["expiresAt"] is not None and (child["expiresAt"] is None or child["expiresAt"] > parent["expiresAt"]):
        v.append("expiresAt")
    if parent["notBefore"] is not None and (child["notBefore"] is None or child["notBefore"] < parent["notBefore"]):
        v.append("notBefore")
    for k in ("payees", "rails", "purposes", "chains"):
        if parent[k] is not None and (child[k] is None or not child[k] <= parent[k]):
            v.append(k)
    if not parent["rateLimits"] <= child["rateLimits"]:
        v.append("rateLimits")
    if parent["holderKey"] is not None and child["holderKey"] is None:
        v.append("holderKey")
    return v


def approver_key_of(r: dict):
    """Section 8.1: (approverId, history entry) for a well-formed approver receipt, else None."""
    if r["kind"] not in ("approver.registered", "approver.removed"):
        return None
    d = r["data"]
    aid = d.get("approverId")
    if not isinstance(aid, str) or not aid:
        return None
    address = d.get("address") if r["kind"] == "approver.registered" else None
    if r["kind"] == "approver.registered" and not is_address(address):
        return None
    return aid, {"address": address, "seq": r["seq"], "effectiveFrom": r["ts"], "receiptId": r["id"]}


def approval_message(a: dict, verdict: str) -> str:
    f = lambda k: js_text(a.get(k), k in a)  # noqa: E731
    return "\n".join(["spendmarshal-approval v1", f"id={f('id')}", f"principal={f('principalId')}", f"intentHash={f('intentHash')}", f"amount={f('amount')}", f"verdict={verdict}"])


def verify_bundle(bundle, schema: dict, trusted_keys: list | None = None) -> list:
    """The report of section 11: [(check, ok, detail), ...] in order."""
    checks: list = []
    push = lambda name, ok, detail="": checks.append((name, bool(ok), detail))  # noqa: E731
    try:
        validate(bundle, schema)
    except SchemaError as err:
        push("schema", False, str(err))
        return checks
    push("schema", True)

    receipts = bundle["receipts"]
    gateway = bundle["gateway"]["address"]
    versions_raw = bundle.get("policyVersions", [])

    # 6.1 and 6.2
    push("policy.hash", H(bundle["policy"]["document"]) == bundle["policy"]["hash"])
    versions = sorted(versions_raw, key=lambda v: v["version"])
    problems = []
    for i, v in enumerate(versions):
        if H(v["document"]) != v["hash"]:
            problems.append(f"v{v['version']}: hash mismatch")
        if v["version"] != i + 1:
            problems.append(f"v{v['version']}: expected v{i + 1}")
        if v["prevHash"] != (None if i == 0 else versions[i - 1]["hash"]):
            problems.append(f"v{v['version']}: prevHash link broken")
        if i > 0 and ms(v["activatedAt"]) < ms(versions[i - 1]["activatedAt"]):
            problems.append(f"v{v['version']}: activated before its predecessor")
    if versions and versions[-1]["hash"] != bundle["policy"]["hash"]:
        problems.append("active policy is not the latest version")
    push("policy.versions", not problems, "; ".join(problems))

    # 4 and 5
    chain_ok, chain_problems, keys = verify_chain(receipts, gateway)
    push("receipts.chain", chain_ok, "; ".join(chain_problems[:5]))
    exported_keys = bundle.get("gatewayKeyHistory", [])
    if keys or exported_keys:
        push("gateway.keys", canonical(exported_keys) == canonical(keys))
    if trusted_keys is not None:
        push("gateway.trusted", *trusted(chain_ok, keys, gateway, len(receipts), trusted_keys))
    else:
        gap = next((k for k in keys if not k["handedOver"]), None)
        if gap is not None:
            push("gateway.trusted", False, f"rotation without a handover at #{gap['seq']}: pin the gateway keys you trust")

    # 6.3
    def active_at(ts: str):
        if not versions:
            return bundle["policy"]["hash"]
        t, cur = ms(ts), None
        for v in versions:
            if ms(v["activatedAt"]) <= t:
                cur = v
        return cur["hash"] if cur else None

    stale = [r["id"] for r in receipts if r.get("policyHash") and r["policyHash"] != active_at(r["ts"])]
    push("receipts.policyHash", not stale, ", ".join(stale))

    # 7
    credentials = bundle["credentials"]
    push("credentials.ids", all(c["id"] == f"{c['rootId']}:{H(c['caveats'])[2:18]}" for c in credentials))
    by_id = {c["id"]: c for c in credentials}
    problems = []
    for c in credentials:
        if not c.get("parentId"):
            continue
        p = by_id.get(c["parentId"])
        if p is None:
            problems.append(f"{c['id']}: parent missing")
            continue
        wider = within(effective_limits(c["caveats"]), effective_limits(p["caveats"]))
        if wider:
            problems.append(f"{c['id']}: wider than parent in {','.join(wider)}")
        mine = c["caveats"]
        if not all(i < len(mine) and canonical(pc) == canonical(mine[i]) for i, pc in enumerate(p["caveats"])):
            problems.append(f"{c['id']}: caveat chain does not extend parent")
    push("credentials.monotonic", not problems, "; ".join(problems))

    # 9
    def anchor_id(x: dict) -> str:
        return "|".join([js_text(x.get("head"), "head" in x).lower(), js_text(x.get("count"), "count" in x), js_text(x.get("party"), "party" in x).lower(), js_text(x.get("txHash"), "txHash" in x).lower()])

    recorded = {anchor_id(r["data"]) for r in receipts if r["kind"] == "evidence.anchored"}
    problems = []
    for a in bundle["anchors"]:
        at = a["count"] - 1
        if not (0 <= at < len(receipts)) or receipts[at]["hash"] != a["head"]:
            problems.append(f"anchor {a['head'][:10]} does not match receipt #{a['count']}")
        elif "party" in a and anchor_id(a) not in recorded:
            problems.append(f"anchor {a['head'][:10]} sent by {a['party']} is not recorded by an evidence.anchored receipt")
    push("anchors.match", not problems, "; ".join(problems))

    # 10
    allowed_from: dict = {}
    for i, r in enumerate(receipts):
        if r["kind"] == "decision" and r["data"].get("effect") == "allow" and r.get("intentId") and r["intentId"] not in allowed_from:
            allowed_from[r["intentId"]] = i
    orphan = [r["id"] for i, r in enumerate(receipts) if r["kind"] == "payment.settled" and not (r.get("intentId") and allowed_from.get(r["intentId"], float("inf")) < i)]
    push("settlements.have_allow_decision", not orphan, ",".join(orphan))

    # 8.2 and 8.3
    history: dict = {}
    for r in receipts:
        k = approver_key_of(r)
        if k is not None:
            history.setdefault(k[0], []).append(k[1])
    problems = []
    held: dict = {}
    for r in receipts:
        if r["kind"] not in ("approver.registered", "approver.removed"):
            continue
        k = approver_key_of(r)
        if k is None:
            problems.append(f"{r['id']}: malformed {r['kind']}")
            continue
        aid, entry = k
        before = held.get(aid)
        prev = r["data"].get("prevAddress")
        if r["kind"] == "approver.removed" and before is None:
            problems.append(f"{r['id']}: removes {aid}, which has no key")
        elif not same(prev if isinstance(prev, str) else None, before):
            problems.append(f"{r['id']}: prevAddress is not the key {aid} held before it")
        held[aid] = entry["address"]
    exported = bundle.get("approverHistory", {})
    for aid in set(history) | set(exported):
        if canonical(exported.get(aid, [])) != canonical(history.get(aid, [])):
            problems.append(f"approverHistory.{aid} does not match the receipts")
    push("approvers.history", not problems, "; ".join(problems))

    # 8.4 and 8.6
    first_seq = min((ks[0]["seq"] for ks in history.values() if ks), default=float("inf"))
    approvers = bundle.get("approvers", {})

    def key_at(aid: str, seq: int):
        ks = history.get(aid, [])
        before = [k for k in ks if k["seq"] < seq]
        if before:
            return before[-1]["address"]
        if first_seq < seq:
            return None
        if ks:
            return ks[0]["address"]
        return approvers.get(aid) or None

    problems = []
    granted: set = set()
    consumed_without_grant = 0
    for r in receipts:
        if r["kind"] == "approval.consumed" and (not r.get("approvalId") or r["approvalId"] not in granted):
            consumed_without_grant += 1
        if r["kind"] not in ("approval.granted", "approval.rejected"):
            continue
        d = r["data"]
        if r["kind"] == "approval.granted" and r.get("approvalId"):
            granted.add(r["approvalId"])
        approver, approval = d.get("approver"), d.get("approval")
        if not isinstance(approver, dict) or approver.get("method") != "signature":
            continue
        aid = approver.get("id") if isinstance(approver.get("id"), str) else ""
        key = key_at(aid, r["seq"])
        verdict = "approve" if r["kind"] == "approval.granted" else "reject"
        if key is None:
            problems.append(f"{r['id']}: approver {aid} had no key at #{r['seq']}")
        elif not isinstance(approver.get("signature"), str) or not approval:
            problems.append(f"{r['id']}: missing signature or approval data")
        elif "address" in approver and not (isinstance(approver["address"], str) and same(approver["address"], key)):
            problems.append(f"{r['id']}: approver address mismatch")
        elif not isinstance(approval, dict) or not same(recover_address(digest_of_text(approval_message(approval, verdict)), approver["signature"]), key):
            problems.append(f"{r['id']}: approver signature invalid")
    if consumed_without_grant:
        problems.append(f"{consumed_without_grant} approvals consumed without a grant")
    push("approvals", not problems, "; ".join(problems))
    return checks


# ───────────────────────────── command line ─────────────────────────────

def _schema(path: str | None) -> dict:
    here = os.path.dirname(os.path.abspath(__file__))
    with open(path or os.path.join(here, "evidence-v1.schema.json"), encoding="utf-8") as f:
        return json.load(f)


def _report(checks: list) -> str:
    ok = all(c[1] for c in checks)
    lines = [f"{'VERIFIED' if ok else 'FAILED'}: {sum(c[1] for c in checks)}/{len(checks)} checks"]
    lines += [f"  {'PASS' if c[1] else 'FAIL'}  {c[0]}" + (f"  ({c[2]})" if c[2] else "") for c in checks]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    schema_path = None
    if "--schema" in argv:
        i = argv.index("--schema")
        schema_path = argv[i + 1]
        del argv[i: i + 2]
    schema = _schema(schema_path)
    if argv[:1] == ["--vectors"]:
        directory = argv[1]
        files = sorted(f for f in os.listdir(directory) if f.endswith(".json"))
        failures = 0
        for name in files:
            with open(os.path.join(directory, name), encoding="utf-8") as f:
                vector = parse_json(f.read())
            pinned = vector.get("options", {}).get("trustedGatewayKeys")
            got = [{"check": c[0], "ok": c[1]} for c in verify_bundle(vector["bundle"], schema, pinned)]
            agrees = got == vector["expected"]["checks"] and all(c["ok"] for c in got) == vector["expected"]["ok"]
            failures += not agrees
            print(f"{'agree' if agrees else 'DISAGREE'}  {name}")
            if not agrees:
                print(f"    expected {vector['expected']['checks']}\n    got      {got}")
        print(f"{len(files) - failures}/{len(files)} vectors agree")
        return 0 if failures == 0 and files else 1
    trust = []
    while "--trust" in argv:
        i = argv.index("--trust")
        trust.append(argv[i + 1])
        del argv[i: i + 2]
    if len(argv) != 1:
        print(__doc__.strip().splitlines()[0] + "\n\nusage: verify_bundle.py BUNDLE.json [--trust 0xADDRESS ...] | --vectors DIR", file=sys.stderr)
        return 2
    with open(argv[0], encoding="utf-8") as f:
        bundle = parse_json(f.read())
    checks = verify_bundle(bundle, schema, trust or None)
    print(_report(checks))
    return 0 if all(c[1] for c in checks) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
