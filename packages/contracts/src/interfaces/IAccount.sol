// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice ERC-4337 v0.7 packed user operation (eth-infinitism EntryPoint v0.7 layout).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits; // verificationGasLimit (16 bytes) | callGasLimit (16 bytes)
    uint256 preVerificationGas;
    bytes32 gasFees; // maxPriorityFeePerGas (16 bytes) | maxFeePerGas (16 bytes)
    bytes paymasterAndData;
    bytes signature;
}

/// @notice ERC-4337 account interface (v0.7).
interface IAccount {
    /// @return validationData packed (authorizer 20 bytes | validUntil 6 bytes | validAfter 6 bytes);
    ///         authorizer 0 = valid signature, 1 = invalid signature.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);
}

interface IERC3009State {
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
