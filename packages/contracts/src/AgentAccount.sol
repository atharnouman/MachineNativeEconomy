// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IEnforcer} from "./interfaces/IEnforcer.sol";
import {Session, PaymentAuthorization} from "./types/Session.sol";
import {SigLib} from "./lib/SigLib.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title AgentAccount
/// @notice A smart account that holds an agent's funds and only releases them under session caveats.
///
/// Trust model: the owner (a human or organisation key, or the gateway acting for them) grants sessions.
/// A session key signs EIP-712 `PaymentAuthorization`s. Anyone (gateway relayer, x402 facilitator, payee)
/// may submit an authorization; the account enforces every caveat on-chain before moving funds, so a
/// compromised model, framework, or even a leaked session key cannot exceed the caveats.
///
/// EIP-7702 compatibility: the contract has no constructor-only state. `initialize(owner)` sets the owner, so
/// the same bytecode can be the delegate target of an EOA under EIP-7702 or deployed standalone (as in tests).
contract AgentAccount {
    using SigLib for bytes32;

    // ───────────────────────────── errors ─────────────────────────────
    error NotOwner();
    error AlreadyInitialized();
    error AccountPaused();
    error SessionUnknown(address key);
    error SessionInactive(address key);
    error InvalidSessionWindow();
    error AuthorizationNotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error NonceAlreadyUsed(bytes32 nonce);
    error SignerNotSession(address signer);
    error TransferFailed();
    error ChildExceedsParent(string field);

    // ───────────────────────────── events ─────────────────────────────
    event Initialized(address indexed owner);
    event SessionGranted(
        address indexed key, uint256 spendCap, uint256 perTxMax, uint64 validAfter, uint64 validUntil, bool anyTarget
    );
    event SessionRevoked(address indexed key);
    event TargetAllowed(address indexed key, address indexed target, bool allowed);
    event TokenAllowed(address indexed key, address indexed token, bool allowed);
    event EnforcersSet(address[] enforcers);
    event PaymentExecuted(
        address indexed key, address indexed token, address indexed to, uint256 amount, bytes32 intentHash, bytes32 nonce
    );
    event Paused(address by);
    event Unpaused(address by);

    // ───────────────────────────── storage ─────────────────────────────
    address public owner;
    bool public paused;
    address[] public enforcers;
    mapping(address => Session) internal _sessions;
    mapping(address => mapping(address => bool)) internal _allowedTargets; // key => target => allowed
    mapping(address => mapping(address => bool)) internal _allowedTokens; // key => token => allowed
    mapping(bytes32 => bool) public nonceUsed;

    bytes32 public constant PAYMENT_AUTHORIZATION_TYPEHASH = keccak256(
        "PaymentAuthorization(address token,address to,uint256 amount,bytes32 intentHash,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    string public constant NAME = "AgentAccount";
    string public constant VERSION = "1";

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ != address(0)) _initialize(owner_);
    }

    function initialize(address owner_) external {
        _initialize(owner_);
    }

    function _initialize(address owner_) internal {
        if (owner != address(0)) revert AlreadyInitialized();
        owner = owner_;
        emit Initialized(owner_);
    }

    // ───────────────────────────── admin ─────────────────────────────
    function setEnforcers(address[] calldata list) external onlyOwner {
        delete enforcers;
        for (uint256 i = 0; i < list.length; i++) enforcers.push(list[i]);
        emit EnforcersSet(list);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Grant (or replace) a session for `key`. `spent` resets to zero.
    function grantSession(
        address key,
        uint256 spendCap,
        uint256 perTxMax,
        uint64 validAfter,
        uint64 validUntil,
        bool anyTarget,
        address[] calldata targets,
        address[] calldata tokens
    ) external onlyOwner {
        _grant(key, spendCap, perTxMax, validAfter, validUntil, anyTarget, targets, tokens);
    }

    /// @notice Grant a child session that is provably no wider than `parentKey`'s session.
    /// @dev Monotonic delegation, enforced on-chain: every caveat of the child must be at least as tight.
    function grantChildSession(
        address parentKey,
        address key,
        uint256 spendCap,
        uint256 perTxMax,
        uint64 validAfter,
        uint64 validUntil,
        bool anyTarget,
        address[] calldata targets,
        address[] calldata tokens
    ) external onlyOwner {
        Session storage p = _sessions[parentKey];
        if (p.key == address(0)) revert SessionUnknown(parentKey);
        if (!p.active) revert SessionInactive(parentKey);
        uint256 parentRemaining = p.spendCap > p.spent ? p.spendCap - p.spent : 0;
        if (spendCap > parentRemaining) revert ChildExceedsParent("spendCap");
        if (perTxMax > p.perTxMax) revert ChildExceedsParent("perTxMax");
        if (validAfter < p.validAfter) revert ChildExceedsParent("validAfter");
        if (validUntil > p.validUntil) revert ChildExceedsParent("validUntil");
        if (anyTarget && !p.anyTarget) revert ChildExceedsParent("anyTarget");
        for (uint256 i = 0; i < targets.length; i++) {
            if (!p.anyTarget && !_allowedTargets[parentKey][targets[i]]) revert ChildExceedsParent("targets");
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            if (!_allowedTokens[parentKey][tokens[i]]) revert ChildExceedsParent("tokens");
        }
        _grant(key, spendCap, perTxMax, validAfter, validUntil, anyTarget, targets, tokens);
    }

    function _grant(
        address key,
        uint256 spendCap,
        uint256 perTxMax,
        uint64 validAfter,
        uint64 validUntil,
        bool anyTarget,
        address[] calldata targets,
        address[] calldata tokens
    ) internal {
        if (validUntil == 0 || validUntil <= validAfter) revert InvalidSessionWindow();
        _sessions[key] = Session({
            key: key,
            spendCap: spendCap,
            spent: 0,
            perTxMax: perTxMax,
            validAfter: validAfter,
            validUntil: validUntil,
            anyTarget: anyTarget,
            active: true
        });
        for (uint256 i = 0; i < targets.length; i++) {
            _allowedTargets[key][targets[i]] = true;
            emit TargetAllowed(key, targets[i], true);
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            _allowedTokens[key][tokens[i]] = true;
            emit TokenAllowed(key, tokens[i], true);
        }
        emit SessionGranted(key, spendCap, perTxMax, validAfter, validUntil, anyTarget);
    }

    function revokeSession(address key) external onlyOwner {
        _sessions[key].active = false;
        emit SessionRevoked(key);
    }

    /// @notice Owner escape hatch for arbitrary calls (treasury operations). Not reachable by session keys.
    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    // ───────────────────────────── payment ─────────────────────────────
    /// @notice Execute a payment authorized by a session key. Callable by anyone (relayer, facilitator, payee).
    function payWithAuthorization(PaymentAuthorization calldata auth, bytes calldata sig) external {
        if (paused) revert AccountPaused();
        if (block.timestamp < auth.validAfter) revert AuthorizationNotYetValid(auth.validAfter);
        if (block.timestamp > auth.validBefore) revert AuthorizationExpired(auth.validBefore);
        if (nonceUsed[auth.nonce]) revert NonceAlreadyUsed(auth.nonce);

        bytes32 digest = hashAuthorization(auth);
        address signer = digest.recover(sig);
        Session storage s = _sessions[signer];
        if (s.key == address(0)) revert SignerNotSession(signer);
        if (!s.active) revert SessionInactive(signer);

        // Every enforcer must pass. Reverts propagate with their typed reason (used as on-chain denial evidence).
        Session memory snapshot = s;
        for (uint256 i = 0; i < enforcers.length; i++) {
            IEnforcer(enforcers[i]).enforce(snapshot, auth.token, auth.to, auth.amount);
        }

        nonceUsed[auth.nonce] = true;
        s.spent += auth.amount;
        emit PaymentExecuted(signer, auth.token, auth.to, auth.amount, auth.intentHash, auth.nonce);
        if (!IERC20Minimal(auth.token).transfer(auth.to, auth.amount)) revert TransferFailed();
    }

    /// @notice Dry-run: returns the enforcer that would reject the payment, or address(0) if it would pass.
    function simulate(PaymentAuthorization calldata auth, address signer)
        external
        view
        returns (bool ok, bytes memory revertData)
    {
        if (paused) return (false, abi.encodeWithSelector(AccountPaused.selector));
        Session memory s = _sessions[signer];
        if (s.key == address(0)) return (false, abi.encodeWithSelector(SignerNotSession.selector, signer));
        if (!s.active) return (false, abi.encodeWithSelector(SessionInactive.selector, signer));
        for (uint256 i = 0; i < enforcers.length; i++) {
            (bool success, bytes memory ret) = enforcers[i].staticcall(
                abi.encodeWithSelector(IEnforcer.enforce.selector, s, auth.token, auth.to, auth.amount)
            );
            if (!success) return (false, ret);
        }
        return (true, "");
    }

    // ───────────────────────────── views ─────────────────────────────
    function getSession(address key) external view returns (Session memory) {
        return _sessions[key];
    }

    function isTargetAllowed(address key, address target) external view returns (bool) {
        return _allowedTargets[key][target];
    }

    function isTokenAllowed(address key, address token) external view returns (bool) {
        return _allowedTokens[key][token];
    }

    function enforcerCount() external view returns (uint256) {
        return enforcers.length;
    }

    function domainSeparator() public view returns (bytes32) {
        return SigLib.domainSeparator(NAME, VERSION, address(this));
    }

    function hashAuthorization(PaymentAuthorization calldata auth) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_AUTHORIZATION_TYPEHASH,
                auth.token,
                auth.to,
                auth.amount,
                auth.intentHash,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );
        return SigLib.typedDataHash(domainSeparator(), structHash);
    }

    receive() external payable {}
}
