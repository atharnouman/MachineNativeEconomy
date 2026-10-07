// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {SigLib} from "../src/lib/SigLib.sol";

contract MockUSDCTest is Test {
    MockUSDC usdc;
    uint256 pk = 0xC0FFEE;
    address from;
    address to = makeAddr("to");

    function setUp() public {
        usdc = new MockUSDC();
        from = vm.addr(pk);
        usdc.mint(from, 1_000_000);
        vm.warp(1_700_000_000);
    }

    function _sig(bytes32 typehash, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, va, vb, nonce));
        bytes32 digest = SigLib.typedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_TransferWithAuthorization() public {
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sig(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 500, 0, block.timestamp + 60, nonce);
        usdc.transferWithAuthorization(from, to, 500, 0, block.timestamp + 60, nonce, sig);
        assertEq(usdc.balanceOf(to), 500);
        vm.expectRevert(MockUSDC.AuthorizationUsedOrCanceled.selector);
        usdc.transferWithAuthorization(from, to, 500, 0, block.timestamp + 60, nonce, sig);
    }

    function test_ReceiveWithAuthorizationRequiresPayeeCaller() public {
        bytes32 nonce = bytes32(uint256(2));
        bytes memory sig = _sig(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), 5, 0, block.timestamp + 60, nonce);
        vm.expectRevert(MockUSDC.CallerMustBePayee.selector);
        usdc.receiveWithAuthorization(from, to, 5, 0, block.timestamp + 60, nonce, sig);
        vm.prank(to);
        usdc.receiveWithAuthorization(from, to, 5, 0, block.timestamp + 60, nonce, sig);
        assertEq(usdc.balanceOf(to), 5);
    }

    function test_RejectsWrongSigner() public {
        bytes32 nonce = bytes32(uint256(3));
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, 1, 0, block.timestamp + 60, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, SigLib.typedDataHash(usdc.DOMAIN_SEPARATOR(), structHash));
        vm.expectRevert(MockUSDC.InvalidAuthorizationSigner.selector);
        usdc.transferWithAuthorization(from, to, 1, 0, block.timestamp + 60, nonce, abi.encodePacked(r, s, v));
    }
}
