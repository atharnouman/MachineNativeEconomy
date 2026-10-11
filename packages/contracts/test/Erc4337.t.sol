// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {SpendLimitEnforcer} from "../src/enforcers/SpendLimitEnforcer.sol";
import {TimeWindowEnforcer} from "../src/enforcers/TimeWindowEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {PackedUserOperation} from "../src/interfaces/IAccount.sol";
import {PaymentAuthorization} from "../src/types/Session.sol";

/// @dev Minimal stand-in for the EntryPoint: validates, then executes callData on the account, as handleOps does.
contract MockEntryPoint {
    function handleOp(AgentAccount acct, PackedUserOperation calldata op, bytes32 opHash, uint256 prefund)
        external
        returns (uint256 validationData, bool execOk, bytes memory ret)
    {
        validationData = acct.validateUserOp(op, opHash, prefund);
        (execOk, ret) = address(acct).call(op.callData);
    }

    receive() external payable {}
}

contract Erc4337Test is Test {
    AgentAccount acct;
    MockUSDC usdc;
    MockEntryPoint ep;
    address owner = makeAddr("owner");
    address payee = makeAddr("payee");
    uint256 sessionPk = 0x5E55;
    address sessionKey;
    uint64 validUntil;

    function setUp() public {
        usdc = new MockUSDC();
        ep = new MockEntryPoint();
        acct = new AgentAccount(owner);
        sessionKey = vm.addr(sessionPk);
        vm.warp(1_700_000_000);
        validUntil = uint64(block.timestamp + 1 days);
        address[] memory e = new address[](3);
        e[0] = address(new SpendLimitEnforcer());
        e[1] = address(new TimeWindowEnforcer());
        e[2] = address(new AllowedTargetsEnforcer());
        address[] memory t = new address[](1);
        t[0] = payee;
        address[] memory tok = new address[](1);
        tok[0] = address(usdc);
        vm.startPrank(owner);
        acct.setEnforcers(e);
        acct.setEntryPoint(address(ep));
        acct.grantSession(sessionKey, 1_000_000, 300_000, 0, validUntil, false, t, tok);
        vm.stopPrank();
        usdc.mint(address(acct), 5_000_000);
        vm.deal(address(acct), 1 ether);
    }

    function _op(bytes memory callData, uint256 pk) internal pure returns (PackedUserOperation memory op, bytes32 opHash) {
        op = PackedUserOperation({sender: address(0), nonce: 0, initCode: "", callData: callData, accountGasLimits: 0, preVerificationGas: 0, gasFees: 0, paymasterAndData: "", signature: ""});
        opHash = keccak256(abi.encode(callData, pk));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", opHash)));
        op.signature = abi.encodePacked(r, s, v);
    }

    function _payCallData(uint256 amount, bytes32 nonce) internal view returns (bytes memory) {
        PaymentAuthorization memory a = PaymentAuthorization({token: address(usdc), to: payee, amount: amount, intentHash: nonce, validAfter: 0, validBefore: block.timestamp + 1 hours, nonce: nonce});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, acct.hashAuthorization(a));
        return abi.encodeCall(AgentAccount.payWithAuthorization, (a, abi.encodePacked(r, s, v)));
    }

    function test_SessionKeySignedUserOpValidatesAndExecutes() public {
        (PackedUserOperation memory op, bytes32 h) = _op(_payCallData(100_000, bytes32(uint256(1))), sessionPk);
        uint256 before = address(ep).balance;
        (uint256 vd, bool ok, ) = ep.handleOp(acct, op, h, 0.01 ether);
        assertTrue(ok, "callData executed through the entry point");
        assertEq(usdc.balanceOf(payee), 100_000);
        assertEq(address(ep).balance - before, 0.01 ether, "prefund paid");
        // validationData: authorizer 0, validUntil / validAfter from the session
        assertEq(uint160(vd), 0, "signature valid");
        assertEq(uint48(vd >> 160), validUntil);
        assertEq(uint48(vd >> 208), 0);
    }

    function test_UnknownSignerFailsValidation() public {
        (PackedUserOperation memory op, bytes32 h) = _op(_payCallData(1, bytes32(uint256(2))), 0xDEAD);
        (uint256 vd,,) = ep.handleOp(acct, op, h, 0);
        assertEq(vd, 1, "SIG_VALIDATION_FAILED");
    }

    function test_GarbageSignatureFailsValidationWithoutRevert() public {
        (PackedUserOperation memory op, bytes32 h) = _op(_payCallData(1, bytes32(uint256(3))), sessionPk);
        op.signature = hex"1234";
        (uint256 vd,,) = ep.handleOp(acct, op, h, 0);
        assertEq(vd, 1);
    }

    function test_OnlyEntryPointMayValidate() public {
        (PackedUserOperation memory op, bytes32 h) = _op(_payCallData(1, bytes32(uint256(4))), sessionPk);
        vm.expectRevert(AgentAccount.NotEntryPoint.selector);
        acct.validateUserOp(op, h, 0);
    }

    function test_OwnerOnlyCallsStillFailThroughEntryPoint() public {
        // a session key cannot escalate by routing an owner-only call through the EntryPoint
        bytes memory cd = abi.encodeCall(AgentAccount.transferOwnership, (sessionKey));
        (PackedUserOperation memory op, bytes32 h) = _op(cd, sessionPk);
        (uint256 vd, bool ok, ) = ep.handleOp(acct, op, h, 0);
        assertEq(uint160(vd), 0, "validation passes (the key is a session)");
        assertFalse(ok, "but the owner-only call reverts: msg.sender is the EntryPoint");
        assertEq(acct.owner(), owner);
    }

    function test_PausedAccountFailsValidation() public {
        vm.prank(owner);
        acct.pause();
        (PackedUserOperation memory op, bytes32 h) = _op(_payCallData(1, bytes32(uint256(5))), sessionPk);
        (uint256 vd,,) = ep.handleOp(acct, op, h, 0);
        assertEq(vd, 1);
    }
}
