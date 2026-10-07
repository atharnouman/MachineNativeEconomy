// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title SigLib
/// @notice Minimal ECDSA recovery and EIP-712 helpers. Kept dependency-free so the repo builds from a clean clone.
library SigLib {
    error InvalidSignatureLength(uint256 length);
    error InvalidSignatureS();
    error InvalidSignatureV();
    error InvalidSigner();

    /// @dev secp256k1 half order; signatures with s above this are rejected (malleability).
    bytes32 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function recover(bytes32 digest, bytes memory sig) internal pure returns (address signer) {
        if (sig.length != 65) revert InvalidSignatureLength(sig.length);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (uint256(s) > uint256(HALF_ORDER)) revert InvalidSignatureS();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignatureV();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSigner();
    }

    function domainSeparator(string memory name, string memory version, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                verifyingContract
            )
        );
    }

    function typedDataHash(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
