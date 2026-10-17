// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";

contract ReceiptRegistryTest is Test {
    ReceiptRegistry reg;
    // two principals' receipt chains, each named by the hash of its first receipt
    bytes32 constant ACME = keccak256("acme r0");
    bytes32 constant GLOBEX = keccak256("globex r0");

    function setUp() public {
        reg = new ReceiptRegistry();
    }

    function test_AnchorChain() public {
        bytes32 h1 = keccak256("r1");
        bytes32 h2 = keccak256("r2");
        reg.anchor(ACME, h1, bytes32(0), 1);
        reg.anchor(ACME, h2, h1, 5);
        (bytes32 head, uint256 count,) = reg.latest(address(this), ACME);
        assertEq(head, h2);
        assertEq(count, 5);
        assertGt(reg.anchoredAt(address(this), h1), 0);
    }

    function test_RevertWhen_PrevMismatch() public {
        reg.anchor(ACME, keccak256("a"), bytes32(0), 1);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiptRegistry.PrevHeadMismatch.selector, keccak256("a"), bytes32(0))
        );
        reg.anchor(ACME, keccak256("b"), bytes32(0), 2);
    }

    function test_RevertWhen_CountDecreases() public {
        reg.anchor(ACME, keccak256("a"), bytes32(0), 5);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.NonMonotonicCount.selector, 5, 4));
        reg.anchor(ACME, keccak256("b"), keccak256("a"), 4);
    }

    /// One gateway key anchors every principal it serves: a short chain after a long one is fine, and each chain's
    /// prevHead is its own last head, not the party's last anchor.
    function test_ChainsOfOnePartyAreIndependent() public {
        reg.anchor(ACME, keccak256("acme 30"), bytes32(0), 30);
        reg.anchor(GLOBEX, keccak256("globex 5"), bytes32(0), 5);
        reg.anchor(ACME, keccak256("acme 31"), keccak256("acme 30"), 31);
        reg.anchor(GLOBEX, keccak256("globex 6"), keccak256("globex 5"), 6);
        (bytes32 acmeHead, uint256 acmeCount,) = reg.latest(address(this), ACME);
        (bytes32 globexHead, uint256 globexCount,) = reg.latest(address(this), GLOBEX);
        assertEq(acmeHead, keccak256("acme 31"));
        assertEq(acmeCount, 31);
        assertEq(globexHead, keccak256("globex 6"));
        assertEq(globexCount, 6);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiptRegistry.PrevHeadMismatch.selector, keccak256("acme 31"), keccak256("globex 6"))
        );
        reg.anchor(ACME, keccak256("acme 32"), keccak256("globex 6"), 32);
    }

    /// Any lengths, in either order: two chains never constrain each other.
    function testFuzz_ChainsNeverConstrainEachOther(uint256 first, uint256 second, bool acmeFirst) public {
        (bytes32 a, bytes32 b) = acmeFirst ? (ACME, GLOBEX) : (GLOBEX, ACME);
        reg.anchor(a, keccak256(abi.encode(a, first)), bytes32(0), first);
        reg.anchor(b, keccak256(abi.encode(b, second)), bytes32(0), second);
        (, uint256 countA,) = reg.latest(address(this), a);
        (, uint256 countB,) = reg.latest(address(this), b);
        assertEq(countA, first);
        assertEq(countB, second);
    }

    /// A new gateway key (a rotation) starts its own sequence for a chain; the old key's anchors stay its own.
    function test_PartiesAreIndependent() public {
        address rotated = address(0xBEEF);
        reg.anchor(ACME, keccak256("acme 10"), bytes32(0), 10);
        vm.prank(rotated);
        reg.anchor(ACME, keccak256("acme 12"), bytes32(0), 12);
        (bytes32 mine,,) = reg.latest(address(this), ACME);
        (bytes32 theirs,,) = reg.latest(rotated, ACME);
        assertEq(mine, keccak256("acme 10"));
        assertEq(theirs, keccak256("acme 12"));
        assertEq(reg.anchoredAt(rotated, keccak256("acme 10")), 0);
        assertGt(reg.anchoredAt(rotated, keccak256("acme 12")), 0);
    }

    function test_EmitsTheChain() public {
        vm.expectEmit(true, true, true, true, address(reg));
        emit ReceiptRegistry.Anchored(address(this), ACME, keccak256("r1"), bytes32(0), 1);
        reg.anchor(ACME, keccak256("r1"), bytes32(0), 1);
    }
}
