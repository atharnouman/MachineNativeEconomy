// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IEnforcer} from "../interfaces/IEnforcer.sol";
import {Session} from "../types/Session.sol";

/// @notice Enforces the session validity window.
contract TimeWindowEnforcer is IEnforcer {
    error SessionNotYetValid(uint64 validAfter, uint256 nowTs);
    error SessionExpired(uint64 validUntil, uint256 nowTs);

    function enforce(Session calldata s, address, address, uint256) external view {
        if (block.timestamp < s.validAfter) revert SessionNotYetValid(s.validAfter, block.timestamp);
        if (block.timestamp > s.validUntil) revert SessionExpired(s.validUntil, block.timestamp);
    }
}
