// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IEnforcer} from "../interfaces/IEnforcer.sol";
import {Session} from "../types/Session.sol";

/// @notice Enforces payee and token allowlists. The allowlists themselves live in the account (per session key)
///         because enforcers are stateless; the account exposes them through `isTargetAllowed` / `isTokenAllowed`.
interface IAllowlistSource {
    function isTargetAllowed(address sessionKey, address target) external view returns (bool);
    function isTokenAllowed(address sessionKey, address token) external view returns (bool);
}

contract AllowedTargetsEnforcer is IEnforcer {
    error TargetNotAllowed(address target);
    error TokenNotAllowed(address token);

    function enforce(Session calldata s, address token, address to, uint256) external view {
        IAllowlistSource src = IAllowlistSource(msg.sender);
        if (!src.isTokenAllowed(s.key, token)) revert TokenNotAllowed(token);
        if (!s.anyTarget && !src.isTargetAllowed(s.key, to)) revert TargetNotAllowed(to);
    }
}
