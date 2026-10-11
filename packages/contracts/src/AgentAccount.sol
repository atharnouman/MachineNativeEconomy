// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IEnforcer} from "./interfaces/IEnforcer.sol";
import {IAccount, PackedUserOperation, IERC3009State} from "./interfaces/IAccount.sol";
import {Session, PaymentAuthorization, TokenAuthorization} from "./types/Session.sol";
import {SigLib} from "./lib/SigLib.sol";
import {IAllowlistSource} from "./enforcers/AllowedTargetsEnforcer.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IERC3009Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @title AgentAccount
/// @notice A smart account that holds an agent principal's funds and only releases them under session caveats.
///
/// Trust model: the owner (a human or organisation key) grants root sessions. Sessions form a capability chain:
/// any session key may delegate a narrower child session, spend by a descendant counts against every ancestor's
/// cap, and revoking an ancestor disables its whole subtree. A session key signs EIP-712 `PaymentAuthorization`s;
/// anyone (gateway relayer, x402 facilitator, payee) may submit one, and the account enforces every caveat
/// on-chain before moving funds. A compromised model, framework, gateway, or leaked session key can therefore
/// lose at most what its own session (and its ancestors) allow.
///
/// EIP-7702: the contract has no constructor-only state. An EOA delegates to this code with a type-4 transaction
/// and calls `initialize(owner)` on itself in the same transaction; `initialize` accepts only self-calls, so it
/// cannot be front-run. Funds stay in the EOA. Standalone deployments pass the owner to the constructor.
contract AgentAccount is IAccount, IAllowlistSource {
    using SigLib for bytes32;

    // ───────────────────────────── errors ─────────────────────────────
    error NotOwner();
    error NotAuthorized();
    error NotSelf();
    error AlreadyInitialized();
    error AccountPaused();
    error SessionUnknown(address key);
    error SessionInactive(address key);
    error SessionExists(address key);
    error InvalidSessionWindow();
    error AuthorizationNotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error NonceAlreadyUsed(bytes32 nonce);
    error SignerNotSession(address signer);
    error TransferFailed();
    error ChildExceedsParent(string field);
    error LineageCapExceeded(address ancestor, uint256 requested, uint256 remaining);
    error AncestorInactive(address ancestor);
    error LineageTooDeep();
    error AuthorizationAlreadyApproved(bytes32 digest);
    error ApprovalUnknown(bytes32 digest);
    error ApprovalNotExpired(uint256 validBefore);
    error ApprovalAlreadyUsed(bytes32 digest);
    error NotEntryPoint();
    error ZeroAddress();

    // ───────────────────────────── events ─────────────────────────────
    event Initialized(address indexed owner);
    event OwnershipTransferred(address indexed from, address indexed to);
    event SessionGranted(
        address indexed key,
        address indexed parent,
        uint256 spendCap,
        uint256 perTxMax,
        uint64 validAfter,
        uint64 validUntil,
        bool anyTarget
    );
    event SessionRevoked(address indexed key, address indexed by);
    event TargetAllowed(address indexed key, address indexed target, bool allowed);
    event TokenAllowed(address indexed key, address indexed token, bool allowed);
    event EnforcersSet(address[] enforcers);
    event PaymentExecuted(
        address indexed key, address indexed token, address indexed to, uint256 amount, bytes32 intentHash, bytes32 nonce
    );
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event AuthorizationApproved(
        address indexed key, address indexed token, address indexed to, uint256 value, bytes32 nonce, bytes32 tokenDigest, bytes32 intentHash
    );
    event ApprovalReclaimed(address indexed key, bytes32 indexed tokenDigest, uint256 value);
    event EntryPointSet(address indexed entryPoint);

    // ───────────────────────────── storage ─────────────────────────────
    address public owner;
    bool public paused;
    address[] public enforcers;
    mapping(address => Session) internal _sessions;
    mapping(address => mapping(address => bool)) internal _allowedTargets; // key => target => allowed
    mapping(address => mapping(address => bool)) internal _allowedTokens; // key => token => allowed
    mapping(bytes32 => bool) public nonceUsed;
    /// @dev EIP-3009 digests (under the token's domain) this account has approved; answered via ERC-1271.
    mapping(bytes32 => bool) public approvedDigests;

    /// @dev What was charged for a pre-approval, so an expired and unused one can be reclaimed.
    struct PendingApproval {
        address key;
        address token;
        bytes32 nonce;
        uint256 value;
        uint256 validBefore;
    }

    mapping(bytes32 => PendingApproval) public pendingApprovals;

    /// @notice ERC-4337 EntryPoint allowed to call `validateUserOp`; zero disables the 4337 path.
    address public entryPoint;

    uint256 public constant MAX_LINEAGE_DEPTH = 16;
    bytes32 public constant PAYMENT_AUTHORIZATION_TYPEHASH = keccak256(
        "PaymentAuthorization(address token,address to,uint256 amount,bytes32 intentHash,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant TOKEN_AUTHORIZATION_TYPEHASH = keccak256(
        "TokenAuthorization(address token,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes32 intentHash)"
    );
    /// @dev EIP-3009 (Circle FiatToken v2) typehash; the digest is computed under the token's own domain.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    string public constant NAME = "AgentAccount";
    string public constant VERSION = "1";

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ != address(0)) _initialize(owner_);
    }

    /// @notice EIP-7702 initialisation. Only the account itself (the delegating EOA sending a transaction to its
    ///         own address) may call this, so nobody can front-run the owner assignment.
    function initialize(address owner_) external {
        if (msg.sender != address(this)) revert NotSelf();
        _initialize(owner_);
    }

    function _initialize(address owner_) internal {
        if (owner != address(0)) revert AlreadyInitialized();
        owner = owner_;
        emit Initialized(owner_);
    }

    // ───────────────────────────── admin (owner) ─────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress(); // a zero owner could never unpause or grant again
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setEnforcers(address[] calldata list) external onlyOwner {
        delete enforcers;
        for (uint256 i = 0; i < list.length; i++) enforcers.push(list[i]);
        emit EnforcersSet(list);
    }

    /// @notice Sets the ERC-4337 EntryPoint; address(0) disables `validateUserOp` entirely.
    function setEntryPoint(address ep) external onlyOwner {
        entryPoint = ep;
        emit EntryPointSet(ep);
    }

    /// @notice Kill switch. The owner or any active ROOT session key (an operator the owner appointed directly)
    ///         may pause. Child sessions cannot: a leaked sub-agent key must not be able to halt the whole account.
    function pause() external {
        Session storage s = _sessions[msg.sender];
        bool rootSession = s.key != address(0) && s.active && s.parent == address(0);
        if (msg.sender != owner && !rootSession) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Only the owner may resume spending.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
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

    // ───────────────────────────── sessions ─────────────────────────────
    /// @notice Grant a root session (no parent). Owner only. Replacing an existing key is not allowed; revoke first.
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
        _grant(key, address(0), spendCap, perTxMax, validAfter, validUntil, anyTarget, targets, tokens);
    }

    /// @notice Grant a child session that is provably no wider than `parentKey`'s session.
    /// @dev Callable by the owner, by `parentKey` itself, or by any active ancestor of `parentKey` (so a gateway
    ///      holding a root session can delegate at any depth beneath it). Monotonic delegation is enforced here:
    ///      every caveat of the child must be at least as tight, and the child's cap cannot exceed what the parent
    ///      has left.
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
    ) external {
        Session storage p = _sessions[parentKey];
        if (p.key == address(0)) revert SessionUnknown(parentKey);
        if (!p.active) revert SessionInactive(parentKey);
        if (msg.sender != owner && !_isSelfOrActiveAncestor(msg.sender, parentKey)) revert NotAuthorized();
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
        _grant(key, parentKey, spendCap, perTxMax, validAfter, validUntil, anyTarget, targets, tokens);
    }

    function _grant(
        address key,
        address parent,
        uint256 spendCap,
        uint256 perTxMax,
        uint64 validAfter,
        uint64 validUntil,
        bool anyTarget,
        address[] calldata targets,
        address[] calldata tokens
    ) internal {
        if (validUntil == 0 || validUntil <= validAfter) revert InvalidSessionWindow();
        if (_sessions[key].key != address(0)) revert SessionExists(key);
        if (parent != address(0) && _depth(parent) + 1 >= MAX_LINEAGE_DEPTH) revert LineageTooDeep();
        _sessions[key] = Session({
            key: key,
            parent: parent,
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
        emit SessionGranted(key, parent, spendCap, perTxMax, validAfter, validUntil, anyTarget);
    }

    /// @notice Revoke a session. Callable by the owner, the key itself, or any active ancestor. Descendants become
    ///         unusable because every payment checks the whole lineage is active.
    function revokeSession(address key) external {
        if (_sessions[key].key == address(0)) revert SessionUnknown(key);
        if (msg.sender != owner && !_isSelfOrActiveAncestor(msg.sender, key)) revert NotAuthorized();
        _sessions[key].active = false;
        emit SessionRevoked(key, msg.sender);
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

        // Every enforcer must pass for the signer's own session. Reverts propagate with their typed reason.
        Session memory snapshot = s;
        uint256 n = enforcers.length;
        for (uint256 i = 0; i < n; i++) {
            IEnforcer(enforcers[i]).enforce(snapshot, auth.token, auth.to, auth.amount);
        }
        // Then the whole lineage: every ancestor must be active and have cap left.
        _checkLineage(s.parent, auth.amount);

        nonceUsed[auth.nonce] = true;
        s.spent += auth.amount;
        _chargeLineage(s.parent, auth.amount);
        emit PaymentExecuted(signer, auth.token, auth.to, auth.amount, auth.intentHash, auth.nonce);
        if (!IERC20Minimal(auth.token).transfer(auth.to, auth.amount)) revert TransferFailed();
    }

    // ───────────────────────────── EIP-3009 / ERC-1271 interop ─────────────────────────────
    /// @notice Pre-approve a standard EIP-3009 transfer from this account, authorized by a session key.
    ///         Runs exactly the checks `payWithAuthorization` runs (enforcers, lineage, caps) and charges the spend,
    ///         then records the token-domain digest so the token's `transferWithAuthorization(from = this, …)`
    ///         succeeds through ERC-1271. Any x402 facilitator that only speaks EIP-3009 can therefore settle
    ///         against this account. Callable by anyone (the gateway relays it).
    function approveAuthorization(TokenAuthorization calldata a, bytes calldata sig) external returns (bytes32 tokenDigest) {
        if (paused) revert AccountPaused();
        if (block.timestamp > a.validBefore) revert AuthorizationExpired(a.validBefore);
        if (nonceUsed[a.nonce]) revert NonceAlreadyUsed(a.nonce);

        bytes32 ours = SigLib.typedDataHash(
            domainSeparator(),
            keccak256(abi.encode(TOKEN_AUTHORIZATION_TYPEHASH, a.token, a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.intentHash))
        );
        address signer = ours.recover(sig);
        Session storage s = _sessions[signer];
        if (s.key == address(0)) revert SignerNotSession(signer);
        if (!s.active) revert SessionInactive(signer);
        Session memory snapshot = s;
        uint256 n = enforcers.length;
        for (uint256 i = 0; i < n; i++) {
            IEnforcer(enforcers[i]).enforce(snapshot, a.token, a.to, a.value);
        }
        _checkLineage(s.parent, a.value);

        tokenDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC3009Domain(a.token).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), a.to, a.value, a.validAfter, a.validBefore, a.nonce))
            )
        );
        if (approvedDigests[tokenDigest]) revert AuthorizationAlreadyApproved(tokenDigest);

        nonceUsed[a.nonce] = true;
        approvedDigests[tokenDigest] = true;
        pendingApprovals[tokenDigest] = PendingApproval({key: signer, token: a.token, nonce: a.nonce, value: a.value, validBefore: a.validBefore});
        s.spent += a.value;
        _chargeLineage(s.parent, a.value);
        emit AuthorizationApproved(signer, a.token, a.to, a.value, a.nonce, tokenDigest, a.intentHash);
    }

    /// @notice Reclaim the spend charged for a pre-approval that expired without the token ever using it
    ///         (a facilitator that never settled). Safe for anyone to call: it only touches authorizations the
    ///         token can no longer execute, and only restores what `approveAuthorization` charged.
    function reclaimApproval(bytes32 tokenDigest) external {
        PendingApproval memory p = pendingApprovals[tokenDigest];
        if (p.key == address(0)) revert ApprovalUnknown(tokenDigest);
        if (block.timestamp <= p.validBefore) revert ApprovalNotExpired(p.validBefore);
        if (IERC3009State(p.token).authorizationState(address(this), p.nonce)) revert ApprovalAlreadyUsed(tokenDigest);
        delete pendingApprovals[tokenDigest];
        delete approvedDigests[tokenDigest];
        _unchargeLineage(p.key, p.value);
        emit ApprovalReclaimed(p.key, tokenDigest, p.value);
    }

    // ───────────────────────────── ERC-4337 ─────────────────────────────
    /// @notice ERC-4337 v0.7 validation: the user operation must be signed (EIP-191 over userOpHash) by an active
    ///         session key. The operation's callData then runs with msg.sender = EntryPoint, so only permissionless
    ///         entry points (`payWithAuthorization`, `approveAuthorization`) can do anything: every caveat still
    ///         applies inside them. Returns the session's validity window as validUntil/validAfter.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        override
        returns (uint256 validationData)
    {
        if (msg.sender != entryPoint || entryPoint == address(0)) revert NotEntryPoint();
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok; // the EntryPoint verifies the deposit itself
        }
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));
        address signer = address(0);
        try this.recoverExternal(ethHash, userOp.signature) returns (address s_) {
            signer = s_;
        } catch {
            return 1; // SIG_VALIDATION_FAILED
        }
        Session storage s = _sessions[signer];
        if (s.key == address(0) || !s.active || paused) return 1;
        // authorizer = 0 (valid) | validUntil (6 bytes) | validAfter (6 bytes)
        return (uint256(uint48(s.validUntil)) << 160) | (uint256(uint48(s.validAfter)) << 208);
    }

    /// @dev External wrapper so a malformed signature can be caught in validateUserOp without reverting.
    function recoverExternal(bytes32 digest, bytes calldata sig) external pure returns (address) {
        return digest.recover(sig);
    }

    /// @notice ERC-1271. Valid only for digests this account pre-approved; the token's own nonce state prevents
    ///         replay once the transfer has executed.
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return approvedDigests[hash] && !paused ? ERC1271_MAGIC : bytes4(0);
    }

    /// @notice The EIP-3009 digest the token will check for a given authorization (for off-chain callers).
    function tokenDigestFor(TokenAuthorization calldata a) external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC3009Domain(a.token).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), a.to, a.value, a.validAfter, a.validBefore, a.nonce))
            )
        );
    }

    /// @notice Dry-run: would the account accept this authorization from `signer`? Returns the revert data it
    ///         would produce, so callers can show the exact reason without sending anything.
    function simulate(PaymentAuthorization calldata auth, address signer)
        external
        view
        returns (bool ok, bytes memory revertData)
    {
        if (paused) return (false, abi.encodeWithSelector(AccountPaused.selector));
        if (nonceUsed[auth.nonce]) return (false, abi.encodeWithSelector(NonceAlreadyUsed.selector, auth.nonce));
        Session memory s = _sessions[signer];
        if (s.key == address(0)) return (false, abi.encodeWithSelector(SignerNotSession.selector, signer));
        if (!s.active) return (false, abi.encodeWithSelector(SessionInactive.selector, signer));
        uint256 n = enforcers.length;
        for (uint256 i = 0; i < n; i++) {
            (bool success, bytes memory ret) = enforcers[i].staticcall(
                abi.encodeWithSelector(IEnforcer.enforce.selector, s, auth.token, auth.to, auth.amount)
            );
            if (!success) return (false, ret);
        }
        address cur = s.parent;
        uint256 depth;
        while (cur != address(0)) {
            Session storage a = _sessions[cur];
            if (!a.active) return (false, abi.encodeWithSelector(AncestorInactive.selector, cur));
            uint256 remaining = a.spendCap > a.spent ? a.spendCap - a.spent : 0;
            if (auth.amount > remaining) {
                return (false, abi.encodeWithSelector(LineageCapExceeded.selector, cur, auth.amount, remaining));
            }
            cur = a.parent;
            if (++depth > MAX_LINEAGE_DEPTH) return (false, abi.encodeWithSelector(LineageTooDeep.selector));
        }
        return (true, "");
    }

    // ───────────────────────────── lineage helpers ─────────────────────────────
    function _checkLineage(address cur, uint256 amount) internal view {
        uint256 depth;
        while (cur != address(0)) {
            Session storage a = _sessions[cur];
            if (!a.active) revert AncestorInactive(cur);
            uint256 remaining = a.spendCap > a.spent ? a.spendCap - a.spent : 0;
            if (amount > remaining) revert LineageCapExceeded(cur, amount, remaining);
            cur = a.parent;
            if (++depth > MAX_LINEAGE_DEPTH) revert LineageTooDeep();
        }
    }

    function _chargeLineage(address cur, uint256 amount) internal {
        while (cur != address(0)) {
            Session storage a = _sessions[cur];
            a.spent += amount;
            cur = a.parent;
        }
    }

    /// @dev Reverse of a charge for the key and its whole lineage (never below zero).
    function _unchargeLineage(address cur, uint256 amount) internal {
        while (cur != address(0)) {
            Session storage a = _sessions[cur];
            a.spent = a.spent > amount ? a.spent - amount : 0;
            cur = a.parent;
        }
    }

    function _depth(address key) internal view returns (uint256 d) {
        address cur = key;
        while (cur != address(0)) {
            cur = _sessions[cur].parent;
            d++;
            if (d > MAX_LINEAGE_DEPTH) revert LineageTooDeep();
        }
    }

    function _isActiveSession(address key) internal view returns (bool) {
        Session storage s = _sessions[key];
        return s.key != address(0) && s.active;
    }

    /// @dev True if `who` is `key` itself or an active ancestor of `key`.
    function _isSelfOrActiveAncestor(address who, address key) internal view returns (bool) {
        if (who == key) return _isActiveSession(who);
        address cur = _sessions[key].parent;
        uint256 depth;
        while (cur != address(0)) {
            if (cur == who) return _isActiveSession(who);
            cur = _sessions[cur].parent;
            if (++depth > MAX_LINEAGE_DEPTH) revert LineageTooDeep();
        }
        return false;
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
