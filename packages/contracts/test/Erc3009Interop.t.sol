// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {SpendLimitEnforcer} from "../src/enforcers/SpendLimitEnforcer.sol";
import {TimeWindowEnforcer} from "../src/enforcers/TimeWindowEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {TokenAuthorization} from "../src/types/Session.sol";

/// @dev A standard x402 facilitator only knows EIP-3009: it calls `USDC.transferWithAuthorization(from, …, sig)`.
///      The account pre-approves the exact digest (after enforcing every caveat) and answers ERC-1271, so such a
///      facilitator can settle against it without any custom payload. Replay is stopped by the token's nonce.
contract Erc3009InteropTest is Test {
    AgentAccount acct;
    AgentAccount impl;
    MockUSDC usdc;
    address[] enforcers;

    address owner = makeAddr("owner");
    address payee = makeAddr("payee");
    address facilitator = makeAddr("facilitator");
    uint256 sessionPk = 0x5E55;
    address sessionKey;
    uint256 alicePk = 0xA11CE;
    address alice;

    function setUp() public {
        usdc = new MockUSDC();
        enforcers.push(address(new SpendLimitEnforcer()));
        enforcers.push(address(new TimeWindowEnforcer()));
        enforcers.push(address(new AllowedTargetsEnforcer()));
        sessionKey = vm.addr(sessionPk);
        alice = vm.addr(alicePk);
        acct = new AgentAccount(owner);
        impl = new AgentAccount(address(0));
        vm.warp(1_700_000_000);
        _setup(acct, owner);
        usdc.mint(address(acct), 5_000_000);
    }

    function _setup(AgentAccount a, address o) internal {
        address[] memory t = new address[](1);
        t[0] = payee;
        address[] memory tok = new address[](1);
        tok[0] = address(usdc);
        vm.startPrank(o);
        a.setEnforcers(enforcers);
        a.grantSession(sessionKey, 1_000_000, 300_000, 0, uint64(block.timestamp + 1 days), false, t, tok);
        vm.stopPrank();
    }

    function _auth(uint256 value, bytes32 nonce) internal view returns (TokenAuthorization memory) {
        return TokenAuthorization({
            token: address(usdc),
            to: payee,
            value: value,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce,
            intentHash: keccak256(abi.encodePacked("intent", nonce))
        });
    }

    function _sign(AgentAccount a, TokenAuthorization memory t) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(a.TOKEN_AUTHORIZATION_TYPEHASH(), t.token, t.to, t.value, t.validAfter, t.validBefore, t.nonce, t.intentHash)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", a.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _settle(AgentAccount a, TokenAuthorization memory t) internal {
        vm.prank(facilitator);
        usdc.transferWithAuthorization(address(a), t.to, t.value, t.validAfter, t.validBefore, t.nonce, hex"1271");
    }

    function test_ApproveThenStandardFacilitatorSettles() public {
        TokenAuthorization memory t = _auth(250_000, bytes32(uint256(1)));
        bytes32 digest = acct.approveAuthorization(t, _sign(acct, t));
        assertEq(digest, acct.tokenDigestFor(t));
        assertTrue(acct.approvedDigests(digest));
        assertEq(acct.isValidSignature(digest, hex""), bytes4(0x1626ba7e));
        assertEq(acct.getSession(sessionKey).spent, 250_000, "charged at approval time");

        _settle(acct, t);
        assertEq(usdc.balanceOf(payee), 250_000);
        assertEq(usdc.balanceOf(address(acct)), 4_750_000);

        // replay through the token is stopped by the token's nonce state
        vm.prank(facilitator);
        vm.expectRevert(MockUSDC.AuthorizationUsedOrCanceled.selector);
        usdc.transferWithAuthorization(address(acct), t.to, t.value, t.validAfter, t.validBefore, t.nonce, hex"1271");
        // and the account refuses to re-approve the same nonce
        bytes memory sig = _sign(acct, t);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.NonceAlreadyUsed.selector, t.nonce));
        acct.approveAuthorization(t, sig);
    }

    function test_RevertWhen_NotApproved() public {
        TokenAuthorization memory t = _auth(1, bytes32(uint256(2)));
        assertEq(acct.isValidSignature(acct.tokenDigestFor(t), hex""), bytes4(0));
        vm.prank(facilitator);
        vm.expectRevert(MockUSDC.InvalidAuthorizationSigner.selector);
        usdc.transferWithAuthorization(address(acct), t.to, t.value, t.validAfter, t.validBefore, t.nonce, hex"1271");
    }

    function test_ApprovalEnforcesCaveats() public {
        TokenAuthorization memory over = _auth(300_001, bytes32(uint256(3)));
        bytes memory sig = _sign(acct, over);
        vm.expectRevert(abi.encodeWithSelector(SpendLimitEnforcer.PerTxLimitExceeded.selector, 300_001, 300_000));
        acct.approveAuthorization(over, sig);

        TokenAuthorization memory wrongPayee = _auth(1, bytes32(uint256(4)));
        wrongPayee.to = facilitator;
        sig = _sign(acct, wrongPayee);
        vm.expectRevert(abi.encodeWithSelector(AllowedTargetsEnforcer.TargetNotAllowed.selector, facilitator));
        acct.approveAuthorization(wrongPayee, sig);

        vm.prank(owner);
        acct.pause();
        TokenAuthorization memory t = _auth(1, bytes32(uint256(5)));
        sig = _sign(acct, t);
        vm.expectRevert(AgentAccount.AccountPaused.selector);
        acct.approveAuthorization(t, sig);
    }

    function test_PausedAccountRejectsAlreadyApprovedDigest() public {
        TokenAuthorization memory t = _auth(1_000, bytes32(uint256(6)));
        bytes32 digest = acct.approveAuthorization(t, _sign(acct, t));
        vm.prank(owner);
        acct.pause();
        assertEq(acct.isValidSignature(digest, hex""), bytes4(0), "kill switch also blocks pending approvals");
        vm.prank(facilitator);
        vm.expectRevert(MockUSDC.InvalidAuthorizationSigner.selector);
        usdc.transferWithAuthorization(address(acct), t.to, t.value, t.validAfter, t.validBefore, t.nonce, hex"1271");
    }

    function test_WorksForAnEip7702Account() public {
        vm.signAndAttachDelegation(address(impl), alicePk);
        AgentAccount a = AgentAccount(payable(alice));
        vm.prank(alice);
        a.initialize(alice);
        _setup(a, alice);
        usdc.mint(alice, 1_000_000);

        TokenAuthorization memory t = _auth(100_000, bytes32(uint256(7)));
        a.approveAuthorization(t, _sign(a, t));
        vm.prank(facilitator);
        usdc.transferWithAuthorization(alice, t.to, t.value, t.validAfter, t.validBefore, t.nonce, hex"1271");
        assertEq(usdc.balanceOf(payee), 100_000);
        assertEq(usdc.balanceOf(alice), 900_000);
    }

    function test_ReclaimExpiredUnusedApproval() public {
        TokenAuthorization memory t = _auth(200_000, bytes32(uint256(9)));
        bytes32 digest = acct.approveAuthorization(t, _sign(acct, t));
        assertEq(acct.getSession(sessionKey).spent, 200_000);
        // not yet expired
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ApprovalNotExpired.selector, t.validBefore));
        acct.reclaimApproval(digest);
        // expired and unused: anyone can reclaim; spend is restored and the digest no longer validates
        vm.warp(t.validBefore + 1);
        vm.prank(facilitator);
        acct.reclaimApproval(digest);
        assertEq(acct.getSession(sessionKey).spent, 0, "charge restored");
        assertEq(acct.isValidSignature(digest, hex""), bytes4(0));
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ApprovalUnknown.selector, digest));
        acct.reclaimApproval(digest);
    }

    function test_RevertWhen_ReclaimingUsedApproval() public {
        TokenAuthorization memory t = _auth(50_000, bytes32(uint256(10)));
        bytes32 digest = acct.approveAuthorization(t, _sign(acct, t));
        _settle(acct, t); // the token used it
        vm.warp(t.validBefore + 1);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ApprovalAlreadyUsed.selector, digest));
        acct.reclaimApproval(digest);
        assertEq(acct.getSession(sessionKey).spent, 50_000, "settled spend stays charged");
    }

    function test_PlainEoaStillUsesEcrecover() public {
        uint256 bobPk = 0xB0B;
        address bob = vm.addr(bobPk);
        usdc.mint(bob, 10);
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, payee, 10, 0, block.timestamp + 60, bytes32(uint256(8)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        usdc.transferWithAuthorization(bob, payee, 10, 0, block.timestamp + 60, bytes32(uint256(8)), abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(payee), 10);
    }
}
