// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {SpendLimitEnforcer} from "../src/enforcers/SpendLimitEnforcer.sol";
import {TimeWindowEnforcer} from "../src/enforcers/TimeWindowEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {PaymentAuthorization} from "../src/types/Session.sol";

/// @dev An existing EOA (Alice) that already holds USDC becomes a guarded agent account via EIP-7702 without
///      moving funds. `initialize` accepts only self-calls, so nobody can claim ownership of her account.
contract Eip7702Test is Test {
    AgentAccount impl;
    MockUSDC usdc;
    address[] enforcers;

    uint256 alicePk = 0xA11CE;
    address alice;
    uint256 sessionPk = 0x5E55;
    address sessionKey;
    address payee = makeAddr("payee");
    address stranger = makeAddr("stranger");

    function setUp() public {
        impl = new AgentAccount(address(0)); // uninitialised implementation: the delegate target
        usdc = new MockUSDC();
        enforcers.push(address(new SpendLimitEnforcer()));
        enforcers.push(address(new TimeWindowEnforcer()));
        enforcers.push(address(new AllowedTargetsEnforcer()));
        alice = vm.addr(alicePk);
        sessionKey = vm.addr(sessionPk);
        usdc.mint(alice, 5_000_000); // Alice's existing balance, in her EOA
        vm.warp(1_700_000_000);
    }

    function test_RevertWhen_ImplementationInitializedDirectly() public {
        vm.expectRevert(AgentAccount.NotSelf.selector);
        impl.initialize(stranger);
    }

    function test_DelegateInitializeAndPayFromEoa() public {
        // Alice signs an EIP-7702 authorization pointing her EOA at the implementation.
        vm.signAndAttachDelegation(address(impl), alicePk);
        AgentAccount acct = AgentAccount(payable(alice));
        assertGt(alice.code.length, 0, "EOA now carries delegation code");

        // A stranger cannot initialise Alice's account (not a self-call).
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotSelf.selector);
        acct.initialize(stranger);

        // Alice initialises herself: a transaction from the EOA to its own address is a self-call.
        vm.prank(alice);
        acct.initialize(alice);
        assertEq(acct.owner(), alice);

        // Second initialisation is impossible even for Alice.
        vm.prank(alice);
        vm.expectRevert(AgentAccount.AlreadyInitialized.selector);
        acct.initialize(alice);

        // Owner configures enforcers and grants a session; funds never moved.
        address[] memory t = new address[](1);
        t[0] = payee;
        address[] memory tok = new address[](1);
        tok[0] = address(usdc);
        vm.startPrank(alice);
        acct.setEnforcers(enforcers);
        acct.grantSession(sessionKey, 1_000_000, 300_000, 0, uint64(block.timestamp + 1 days), false, t, tok);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 5_000_000, "balance untouched by delegation");

        // A session key pays; USDC leaves Alice's EOA directly.
        PaymentAuthorization memory a = PaymentAuthorization({
            token: address(usdc),
            to: payee,
            amount: 250_000,
            intentHash: keccak256("intent-7702"),
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: bytes32(uint256(1))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, acct.hashAuthorization(a));
        vm.prank(stranger); // any relayer
        acct.payWithAuthorization(a, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(alice), 4_750_000);
        assertEq(usdc.balanceOf(payee), 250_000);

        // Over the per-tx caveat still reverts, exactly as for a standalone account.
        a.amount = 300_001;
        a.nonce = bytes32(uint256(2));
        (v, r, s) = vm.sign(sessionPk, acct.hashAuthorization(a));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(abi.encodeWithSelector(SpendLimitEnforcer.PerTxLimitExceeded.selector, 300_001, 300_000));
        acct.payWithAuthorization(a, sig);
    }

    function test_DomainSeparatorBindsToTheEoaAddress() public {
        vm.signAndAttachDelegation(address(impl), alicePk);
        AgentAccount acct = AgentAccount(payable(alice));
        assertTrue(acct.domainSeparator() != impl.domainSeparator(), "signatures for Alice cannot replay on impl");
    }
}
