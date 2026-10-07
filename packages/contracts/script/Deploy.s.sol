// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";
import {SpendLimitEnforcer} from "../src/enforcers/SpendLimitEnforcer.sol";
import {TimeWindowEnforcer} from "../src/enforcers/TimeWindowEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";

/// @notice Dev deployment. The TypeScript demo deploys the same contracts from artifacts; this script exists for
///         operators who prefer `forge script`. Usage:
///         forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract Deploy is Script {
    function run() external {
        address owner = vm.envOr("APGW_OWNER", msg.sender);
        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        ReceiptRegistry reg = new ReceiptRegistry();
        SpendLimitEnforcer e1 = new SpendLimitEnforcer();
        TimeWindowEnforcer e2 = new TimeWindowEnforcer();
        AllowedTargetsEnforcer e3 = new AllowedTargetsEnforcer();
        AgentAccount acct = new AgentAccount(owner);
        vm.stopBroadcast();
        console.log("MockUSDC", address(usdc));
        console.log("ReceiptRegistry", address(reg));
        console.log("SpendLimitEnforcer", address(e1));
        console.log("TimeWindowEnforcer", address(e2));
        console.log("AllowedTargetsEnforcer", address(e3));
        console.log("AgentAccount", address(acct));
    }
}
