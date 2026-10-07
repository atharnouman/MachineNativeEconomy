// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";

contract ReceiptRegistryTest is Test {
    ReceiptRegistry reg;

    function setUp() public {
        reg = new ReceiptRegistry();
    }

    function test_AnchorChain() public {
        bytes32 h1 = keccak256("r1");
        bytes32 h2 = keccak256("r2");
        reg.anchor(h1, bytes32(0), 1);
        reg.anchor(h2, h1, 5);
        (bytes32 head, uint256 count,) = reg.latest(address(this));
        assertEq(head, h2);
        assertEq(count, 5);
        assertGt(reg.anchoredAt(address(this), h1), 0);
    }

    function test_RevertWhen_PrevMismatch() public {
        reg.anchor(keccak256("a"), bytes32(0), 1);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiptRegistry.PrevHeadMismatch.selector, keccak256("a"), bytes32(0))
        );
        reg.anchor(keccak256("b"), bytes32(0), 2);
    }

    function test_RevertWhen_CountDecreases() public {
        reg.anchor(keccak256("a"), bytes32(0), 5);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.NonMonotonicCount.selector, 5, 4));
        reg.anchor(keccak256("b"), keccak256("a"), 4);
    }
}
