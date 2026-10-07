// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {SpendLimitEnforcer} from "../src/enforcers/SpendLimitEnforcer.sol";
import {TimeWindowEnforcer} from "../src/enforcers/TimeWindowEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {PaymentAuthorization} from "../src/types/Session.sol";

/// @dev Handler drives the account with random authorizations from the session key, including over-limit ones.
contract Handler is Test {
    AgentAccount public acct;
    MockUSDC public usdc;
    address public payee;
    uint256 pk = 0x5E55;
    uint256 n;

    constructor(AgentAccount a, MockUSDC u, address p) {
        acct = a;
        usdc = u;
        payee = p;
    }

    function key() external view returns (address) {
        return vm.addr(pk);
    }

    function pay(uint256 amount) external {
        amount = bound(amount, 0, 2_000_000);
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
}

contract AgentAccountInvariant is Test {
    AgentAccount acct;
    MockUSDC usdc;
    Handler h;
    address owner = makeAddr("owner");
    address payee = makeAddr("payee");
    uint256 constant CAP = 1_000_000;

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
        address k = h.key();
        vm.prank(owner);
        acct.grantSession(k, CAP, 300_000, 0, uint64(block.timestamp + 365 days), false, t, tok);
        targetContract(address(h));
    }

    function invariant_SpentNeverExceedsCap() public view {
        assertLe(acct.getSession(h.key()).spent, CAP);
    }

    function invariant_PayeeBalanceEqualsSpent() public view {
        assertEq(usdc.balanceOf(payee), acct.getSession(h.key()).spent);
    }
}
