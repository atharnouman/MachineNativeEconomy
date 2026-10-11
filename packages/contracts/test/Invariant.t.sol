// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {SpendLimitEnforcer} from "../src/enforcers/SpendLimitEnforcer.sol";
import {TimeWindowEnforcer} from "../src/enforcers/TimeWindowEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {PaymentAuthorization} from "../src/types/Session.sol";

/// @dev Handler drives a three-level chain (root -> child -> grandchild) with random authorizations from the
///      child and grandchild keys, including over-limit ones, and random extra delegations.
contract Handler is Test {
    AgentAccount public acct;
    MockUSDC public usdc;
    address public payee;
    uint256 public constant CHILD_PK = 0xC1;
    uint256 public constant GRAND_PK = 0x61;
    uint256 n;

    constructor(AgentAccount a, MockUSDC u, address p) {
        acct = a;
        usdc = u;
        payee = p;
    }

    function childKey() public pure returns (address) {
        return vm.addr(CHILD_PK);
    }

    function grandKey() public pure returns (address) {
        return vm.addr(GRAND_PK);
    }

    function pay(uint256 amount, bool fromGrand) external {
        amount = bound(amount, 0, 2_000_000);
        uint256 pk = fromGrand ? GRAND_PK : CHILD_PK;
        PaymentAuthorization memory a = PaymentAuthorization({
            token: address(usdc),
            to: payee,
            amount: amount,
            intentHash: bytes32(n),
            validAfter: 0,
            validBefore: block.timestamp + 1,
            nonce: bytes32(++n)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, acct.hashAuthorization(a));
        try acct.payWithAuthorization(a, abi.encodePacked(r, s, v)) {} catch {}
    }

    /// @dev The grandchild tries to mint itself more authority via a further child; must never widen anything.
    function rogueDelegate(uint256 cap, uint256 perTx, uint256 salt) external {
        address[] memory t = new address[](1);
        t[0] = payee;
        address[] memory tok = new address[](1);
        tok[0] = address(usdc);
        address k = vm.addr(bound(salt, 1, type(uint64).max));
        vm.prank(grandKey());
        try acct.grantChildSession(grandKey(), k, cap, perTx, 0, uint64(block.timestamp + 365 days), false, t, tok) {} catch {}
    }
}

contract AgentAccountInvariant is Test {
    AgentAccount acct;
    MockUSDC usdc;
    Handler h;
    address owner = makeAddr("owner");
    address payee = makeAddr("payee");
    address rootKey = makeAddr("rootKey");
    uint256 constant ROOT_CAP = 1_000_000;
    uint256 constant GRAND_CAP = 400_000;

    function setUp() public {
        usdc = new MockUSDC();
        acct = new AgentAccount(owner);
        address[] memory e = new address[](3);
        e[0] = address(new SpendLimitEnforcer());
        e[1] = address(new TimeWindowEnforcer());
        e[2] = address(new AllowedTargetsEnforcer());
        vm.prank(owner);
        acct.setEnforcers(e);
        usdc.mint(address(acct), 100_000_000);
        h = new Handler(acct, usdc, payee);
        address[] memory t = new address[](1);
        t[0] = payee;
        address[] memory tok = new address[](1);
        tok[0] = address(usdc);
        address c = h.childKey();
        address g = h.grandKey();
        vm.startPrank(owner);
        acct.grantSession(rootKey, ROOT_CAP, 300_000, 0, uint64(block.timestamp + 365 days), false, t, tok);
        acct.grantChildSession(rootKey, c, ROOT_CAP, 300_000, 0, uint64(block.timestamp + 365 days), false, t, tok);
        acct.grantChildSession(c, g, GRAND_CAP, 200_000, 0, uint64(block.timestamp + 365 days), false, t, tok);
        vm.stopPrank();
        targetContract(address(h));
    }

    function invariant_RootSpentNeverExceedsCap() public view {
        assertLe(acct.getSession(rootKey).spent, ROOT_CAP);
    }

    function invariant_RootSpentEqualsPayeeBalance() public view {
        assertEq(usdc.balanceOf(payee), acct.getSession(rootKey).spent);
    }

    function invariant_ChildSpentEqualsRootSpent() public view {
        // all spending under root flows through child, so the lineage accounting must agree
        assertEq(acct.getSession(h.childKey()).spent, acct.getSession(rootKey).spent);
    }

    function invariant_GrandchildBoundedByOwnCap() public view {
        assertLe(acct.getSession(h.grandKey()).spent, GRAND_CAP);
    }
}
