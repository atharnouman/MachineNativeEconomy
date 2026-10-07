// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Session} from "../types/Session.sol";

/// @title IEnforcer
/// @notice A caveat enforcer inspects a proposed payment against a session's caveats and reverts if it violates them.
/// @dev Enforcers are stateless views so they can be composed, audited, and swapped independently of the account.
interface IEnforcer {
    /// @param s The session (caveats plus running spend) under which the payment is proposed.
    /// @param token The ERC-20 being paid.
    /// @param to The payee address.
    /// @param amount The amount in token base units.
    function enforce(Session calldata s, address token, address to, uint256 amount) external view;
}
