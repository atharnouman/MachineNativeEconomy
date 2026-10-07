// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IEnforcer} from "../interfaces/IEnforcer.sol";
import {Session} from "../types/Session.sol";

/// @notice Enforces the per-transaction maximum and the lifetime spend cap of a session.
contract SpendLimitEnforcer is IEnforcer {
    error PerTxLimitExceeded(uint256 requested, uint256 perTxMax);
    error SpendCapExceeded(uint256 requested, uint256 remaining);

    function enforce(Session calldata s, address, address, uint256 amount) external pure {
        if (amount > s.perTxMax) revert PerTxLimitExceeded(amount, s.perTxMax);
        uint256 remaining = s.spendCap > s.spent ? s.spendCap - s.spent : 0;
        if (amount > remaining) revert SpendCapExceeded(amount, remaining);
    }
}
