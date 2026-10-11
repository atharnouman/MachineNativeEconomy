// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {SpendLimitEnforcer} from "../src/enforcers/SpendLimitEnforcer.sol";
import {TimeWindowEnforcer} from "../src/enforcers/TimeWindowEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {Session, PaymentAuthorization} from "../src/types/Session.sol";

contract AgentAccountTest is Test {
    AgentAccount acct;
    MockUSDC usdc;
    SpendLimitEnforcer spend;
    TimeWindowEnforcer time;
    AllowedTargetsEnforcer targets;

    address owner = makeAddr("owner");
    address payee = makeAddr("payee");
    address stranger = makeAddr("stranger");
    uint256 sessionPk = 0xA11CE;
    address sessionKey;
    uint256 childPk = 0xB0B;
    address childKey;
    uint256 grandPk = 0xC0C;
    address grandKey;

    uint256 constant CAP = 1_000_000; // 1.00 USDC
    uint256 constant PER_TX = 300_000; // 0.30 USDC

    function setUp() public {
        sessionKey = vm.addr(sessionPk);
        childKey = vm.addr(childPk);
        grandKey = vm.addr(grandPk);
        usdc = new MockUSDC();
        acct = new AgentAccount(owner);
        spend = new SpendLimitEnforcer();
        time = new TimeWindowEnforcer();
        targets = new AllowedTargetsEnforcer();
        address[] memory e = new address[](3);
        e[0] = address(spend);
        e[1] = address(time);
        e[2] = address(targets);
        vm.prank(owner);
        acct.setEnforcers(e);
        usdc.mint(address(acct), 10_000_000);
        vm.warp(1_700_000_000);
        _grant(sessionKey, CAP, PER_TX, false);
    }

    function _lists() internal view returns (address[] memory t, address[] memory tok) {
        t = new address[](1);
        t[0] = payee;
        tok = new address[](1);
        tok[0] = address(usdc);
    }

    function _grant(address key, uint256 cap, uint256 perTx, bool anyTarget) internal {
        (address[] memory t, address[] memory tok) = _lists();
        vm.prank(owner);
        acct.grantSession(key, cap, perTx, uint64(block.timestamp), uint64(block.timestamp + 1 days), anyTarget, t, tok);
    }

    function _grantChild(address by, address parent, address key, uint256 cap, uint256 perTx) internal {
        (address[] memory t, address[] memory tok) = _lists();
        vm.prank(by);
        acct.grantChildSession(parent, key, cap, perTx, uint64(block.timestamp), uint64(block.timestamp + 1 hours), false, t, tok);
    }

    function _auth(address to, uint256 amount, bytes32 nonce) internal view returns (PaymentAuthorization memory) {
        return PaymentAuthorization({
            token: address(usdc),
            to: to,
            amount: amount,
            intentHash: keccak256(abi.encodePacked("intent", nonce)),
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce
        });
    }

    function _sign(uint256 pk, PaymentAuthorization memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, acct.hashAuthorization(a));
        return abi.encodePacked(r, s, v);
    }

    function _pay(uint256 pk, uint256 amount, uint256 nonce) internal {
        PaymentAuthorization memory a = _auth(payee, amount, bytes32(nonce));
        acct.payWithAuthorization(a, _sign(pk, a));
    }

    // ───────────── happy path ─────────────
    function test_PayWithinCaveats() public {
        PaymentAuthorization memory a = _auth(payee, 100_000, bytes32(uint256(1)));
        vm.prank(stranger); // anyone can relay
        acct.payWithAuthorization(a, _sign(sessionPk, a));
        assertEq(usdc.balanceOf(payee), 100_000);
        assertEq(acct.getSession(sessionKey).spent, 100_000);
    }

    // ───────────── denials ─────────────
    function test_RevertWhen_PerTxExceeded() public {
        PaymentAuthorization memory a = _auth(payee, PER_TX + 1, bytes32(uint256(2)));
        bytes memory sig = _sign(sessionPk, a);
        vm.expectRevert(abi.encodeWithSelector(SpendLimitEnforcer.PerTxLimitExceeded.selector, PER_TX + 1, PER_TX));
        acct.payWithAuthorization(a, sig);
    }

    function test_RevertWhen_CapExceededCumulatively() public {
        for (uint256 i = 0; i < 3; i++) _pay(sessionPk, PER_TX, 10 + i);
        PaymentAuthorization memory b = _auth(payee, 200_000, bytes32(uint256(99)));
        bytes memory sig = _sign(sessionPk, b);
        vm.expectRevert(abi.encodeWithSelector(SpendLimitEnforcer.SpendCapExceeded.selector, 200_000, 100_000));
        acct.payWithAuthorization(b, sig);
    }

    function test_RevertWhen_TargetNotAllowed() public {
        PaymentAuthorization memory a = _auth(stranger, 1, bytes32(uint256(3)));
        bytes memory sig = _sign(sessionPk, a);
        vm.expectRevert(abi.encodeWithSelector(AllowedTargetsEnforcer.TargetNotAllowed.selector, stranger));
        acct.payWithAuthorization(a, sig);
    }

    function test_RevertWhen_SessionExpired() public {
        vm.warp(block.timestamp + 2 days);
        PaymentAuthorization memory a = _auth(payee, 1, bytes32(uint256(4)));
        a.validBefore = block.timestamp + 1;
        bytes memory sig = _sign(sessionPk, a);
        vm.expectRevert();
        acct.payWithAuthorization(a, sig);
    }

    function test_RevertWhen_Replay() public {
        PaymentAuthorization memory a = _auth(payee, 1, bytes32(uint256(5)));
        bytes memory sig = _sign(sessionPk, a);
        acct.payWithAuthorization(a, sig);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.NonceAlreadyUsed.selector, a.nonce));
        acct.payWithAuthorization(a, sig);
    }

    function test_RevertWhen_UnknownSigner() public {
        PaymentAuthorization memory a = _auth(payee, 1, bytes32(uint256(6)));
        bytes memory sig = _sign(0xDEAD, a);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.SignerNotSession.selector, vm.addr(0xDEAD)));
        acct.payWithAuthorization(a, sig);
    }

    function test_RevertWhen_Revoked() public {
        vm.prank(owner);
        acct.revokeSession(sessionKey);
        PaymentAuthorization memory a = _auth(payee, 1, bytes32(uint256(8)));
        bytes memory sig = _sign(sessionPk, a);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.SessionInactive.selector, sessionKey));
        acct.payWithAuthorization(a, sig);
    }

    function test_RevertWhen_SessionExists() public {
        (address[] memory t, address[] memory tok) = _lists();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.SessionExists.selector, sessionKey));
        acct.grantSession(sessionKey, 1, 1, 0, uint64(block.timestamp + 1), true, t, tok);
    }

    function test_TransferOwnershipRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ZeroAddress.selector);
        acct.transferOwnership(address(0));
    }

    // ───────────── kill switch ─────────────
    function test_PauseBySessionKey_UnpauseOwnerOnly() public {
        vm.prank(sessionKey);
        acct.pause();
        assertTrue(acct.paused());
        PaymentAuthorization memory a = _auth(payee, 1, bytes32(uint256(7)));
        bytes memory sig = _sign(sessionPk, a);
        vm.expectRevert(AgentAccount.AccountPaused.selector);
        acct.payWithAuthorization(a, sig);
        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.unpause();
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.pause();
        vm.prank(owner);
        acct.unpause();
        acct.payWithAuthorization(a, sig);
        // a child session key cannot pause the whole account
        _grantChild(sessionKey, sessionKey, childKey, 1, 1);
        vm.prank(childKey);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.pause();
    }

    // ───────────── simulate ─────────────
    function test_SimulateReportsEnforcerReason() public view {
        PaymentAuthorization memory a = _auth(payee, PER_TX + 1, bytes32(uint256(9)));
        (bool ok, bytes memory ret) = acct.simulate(a, sessionKey);
        assertFalse(ok);
        assertEq(bytes4(ret), SpendLimitEnforcer.PerTxLimitExceeded.selector);
        (ok,) = acct.simulate(_auth(payee, 1, bytes32(uint256(10))), sessionKey);
        assertTrue(ok);
    }

    // ───────────── capability chain ─────────────
    function test_OwnerGrantsChildWithinParent() public {
        _grantChild(owner, sessionKey, childKey, CAP / 2, PER_TX / 2);
        assertEq(acct.getSession(childKey).parent, sessionKey);
        _pay(childPk, PER_TX / 2, 11);
        assertEq(usdc.balanceOf(payee), PER_TX / 2);
    }

    function test_SessionKeyDelegatesChild_StrangerCannot() public {
        _grantChild(sessionKey, sessionKey, childKey, CAP / 2, PER_TX / 2);
        assertTrue(acct.getSession(childKey).active);
        (address[] memory t, address[] memory tok) = _lists();
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.grantChildSession(sessionKey, grandKey, 1, 1, uint64(block.timestamp), uint64(block.timestamp + 1), false, t, tok);
    }

    function test_AncestorDelegatesGrandchild() public {
        _grantChild(sessionKey, sessionKey, childKey, CAP / 2, PER_TX / 2);
        // the root session key (an ancestor of childKey) may delegate beneath childKey
        _grantChild(sessionKey, childKey, grandKey, CAP / 4, PER_TX / 4);
        assertEq(acct.getSession(grandKey).parent, childKey);
        // a sibling-level key with no ancestry cannot
        (address[] memory t, address[] memory tok) = _lists();
        vm.prank(grandKey);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.grantChildSession(sessionKey, makeAddr("x"), 1, 1, uint64(block.timestamp), uint64(block.timestamp + 1), false, t, tok);
    }

    function test_LineageSpendPropagatesAndRootCapBoundsSubtree() public {
        // root cap 1.0; two children each cap 0.8 (each <= root remaining at grant time)
        uint256 bPk = 0xB1;
        address bKey = vm.addr(bPk);
        _grantChild(sessionKey, sessionKey, childKey, 800_000, PER_TX);
        _grantChild(sessionKey, sessionKey, bKey, 800_000, PER_TX);
        _pay(childPk, 300_000, 21);
        _pay(childPk, 300_000, 22); // child A: 0.6
        _pay(bPk, 300_000, 23); // child B: 0.3 -> root 0.9
        assertEq(acct.getSession(sessionKey).spent, 900_000, "root charged for descendants");
        assertEq(acct.getSession(childKey).spent, 600_000);
        // child B has 0.5 of its own cap left, but the root has only 0.1
        PaymentAuthorization memory a = _auth(payee, 300_000, bytes32(uint256(24)));
        bytes memory sig = _sign(bPk, a);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.LineageCapExceeded.selector, sessionKey, 300_000, 100_000));
        acct.payWithAuthorization(a, sig);
        (bool ok, bytes memory ret) = acct.simulate(a, bKey);
        assertFalse(ok);
        assertEq(bytes4(ret), AgentAccount.LineageCapExceeded.selector);
        // and a new child cannot be granted more than the root has left
        (address[] memory t, address[] memory tok) = _lists();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ChildExceedsParent.selector, "spendCap"));
        acct.grantChildSession(sessionKey, grandKey, 100_001, 1, uint64(block.timestamp), uint64(block.timestamp + 1), false, t, tok);
    }

    function test_AncestorRevocationDisablesDescendants() public {
        _grantChild(sessionKey, sessionKey, childKey, CAP / 2, PER_TX / 2);
        _grantChild(sessionKey, childKey, grandKey, CAP / 4, PER_TX / 4);
        vm.prank(sessionKey); // the root key revokes its child
        acct.revokeSession(childKey);
        PaymentAuthorization memory a = _auth(payee, 1, bytes32(uint256(31)));
        bytes memory sig = _sign(grandPk, a);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.AncestorInactive.selector, childKey));
        acct.payWithAuthorization(a, sig);
        // self-revocation works; strangers cannot revoke
        vm.prank(grandKey);
        acct.revokeSession(grandKey);
        assertFalse(acct.getSession(grandKey).active);
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.revokeSession(sessionKey);
    }

    function test_RevertWhen_ChildWiderThanParent_Cap() public {
        (address[] memory t, address[] memory tok) = _lists();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ChildExceedsParent.selector, "spendCap"));
        acct.grantChildSession(sessionKey, childKey, CAP + 1, PER_TX, uint64(block.timestamp), uint64(block.timestamp + 1 hours), false, t, tok);
    }

    function test_RevertWhen_ChildWiderThanParent_Target() public {
        address[] memory t = new address[](1);
        t[0] = stranger;
        address[] memory tok = new address[](1);
        tok[0] = address(usdc);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ChildExceedsParent.selector, "targets"));
        acct.grantChildSession(sessionKey, childKey, 1, 1, uint64(block.timestamp), uint64(block.timestamp + 1 hours), false, t, tok);
    }

    function test_RevertWhen_ChildWiderThanParent_Time() public {
        address[] memory t = new address[](0);
        address[] memory tok = new address[](1);
        tok[0] = address(usdc);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ChildExceedsParent.selector, "validUntil"));
        acct.grantChildSession(sessionKey, childKey, 1, 1, uint64(block.timestamp), uint64(block.timestamp + 2 days), false, t, tok);
    }

    // ───────────── fuzz ─────────────
    function testFuzz_NeverExceedsCap(uint256[8] memory amounts) public {
        uint256 total;
        for (uint256 i = 0; i < 8; i++) {
            uint256 amt = bound(amounts[i], 0, PER_TX * 2);
            PaymentAuthorization memory a = _auth(payee, amt, bytes32(uint256(1000 + i)));
            bytes memory sig = _sign(sessionPk, a);
            bool shouldPass = amt <= PER_TX && total + amt <= CAP;
            if (!shouldPass) vm.expectRevert();
            acct.payWithAuthorization(a, sig);
            if (shouldPass) total += amt;
        }
        assertLe(acct.getSession(sessionKey).spent, CAP);
        assertEq(usdc.balanceOf(payee), total);
    }

    // ───────────── owner path ─────────────
    function test_OnlyOwnerCanGrantRoot() public {
        address[] memory t = new address[](0);
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.grantSession(stranger, 1, 1, 0, uint64(block.timestamp + 1), true, t, t);
    }

    function test_InitializeIsSelfOnly() public {
        AgentAccount fresh = new AgentAccount(address(0));
        vm.expectRevert(AgentAccount.NotSelf.selector);
        fresh.initialize(owner);
        assertEq(fresh.owner(), address(0));
        vm.prank(owner);
        acct.transferOwnership(stranger);
        assertEq(acct.owner(), stranger);
    }
}
