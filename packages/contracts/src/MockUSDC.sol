// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {SigLib} from "./lib/SigLib.sol";

/// @title MockUSDC
/// @notice Local-development stablecoin: ERC-20 with 6 decimals plus EIP-3009 (transferWithAuthorization /
///         receiveWithAuthorization), which is what x402's `exact` scheme and Circle Nanopayments sign.
///         Anyone may mint on a dev chain. Never deploy to a public network.
contract MockUSDC {
    using SigLib for bytes32;

    string public constant name = "USD Coin (mock)";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error InsufficientBalance(uint256 have, uint256 want);
    error InsufficientAllowance();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationUsedOrCanceled();
    error InvalidAuthorizationSigner();
    error CallerMustBePayee();

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return SigLib.domainSeparator(name, "2", address(this));
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _useAuthorization(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (msg.sender != to) revert CallerMustBePayee();
        _useAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _transfer(from, to, value);
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) internal {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationUsedOrCanceled();
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = SigLib.typedDataHash(DOMAIN_SEPARATOR(), structHash);
        if (from.code.length > 0) {
            // ERC-1271, as Circle's FiatToken v2.2 does for contract authorizers (incl. EIP-7702-delegated EOAs)
            (bool ok, bytes memory ret) = from.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, signature));
            if (!ok || ret.length < 32 || abi.decode(ret, (bytes4)) != bytes4(0x1626ba7e)) revert InvalidAuthorizationSigner();
        } else if (digest.recover(signature) != from) {
            revert InvalidAuthorizationSigner();
        }
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 b = balanceOf[from];
        if (b < amount) revert InsufficientBalance(b, amount);
        balanceOf[from] = b - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
