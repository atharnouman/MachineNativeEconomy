// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title ReceiptRegistry
/// @notice Anchors the head of a principal's off-chain receipt hash chain so an evidence bundle can be proven
///         to have existed, unmodified, at a given block. Receipts themselves stay off-chain (they may carry
///         commercial metadata); only hashes are anchored. One party (a gateway key) anchors the chains of every
///         principal it serves, so anchors are kept per party and receipt chain, and a chain is named by the hash of
///         its first receipt: no principal is ever named on-chain (ADR-0021).
contract ReceiptRegistry {
    struct Anchor {
        bytes32 head; // hash of the latest receipt in the chain
        uint256 count; // number of receipts in the chain at anchoring time
        uint256 blockNumber;
    }

    /// anchoring party (the gateway key) => receipt chain (hash of its first receipt) => latest anchor of that chain
    mapping(address => mapping(bytes32 => Anchor)) public latest;
    mapping(address => mapping(bytes32 => uint256)) public anchoredAt; // party => head => block

    event Anchored(address indexed party, bytes32 indexed chain, bytes32 indexed head, bytes32 prevHead, uint256 count);

    error NonMonotonicCount(uint256 have, uint256 got);
    error PrevHeadMismatch(bytes32 expected, bytes32 got);

    /// @param chain the receipt chain: the hash of its first receipt
    /// @param head the hash of the chain's latest receipt
    /// @param prevHead the head this party last anchored for this chain (zero for its first anchor of it)
    /// @param count the number of receipts in the chain; never less than this party's last anchor of it
    function anchor(bytes32 chain, bytes32 head, bytes32 prevHead, uint256 count) external {
        Anchor storage a = latest[msg.sender][chain];
        if (a.head != prevHead) revert PrevHeadMismatch(a.head, prevHead);
        if (count < a.count) revert NonMonotonicCount(a.count, count);
        a.head = head;
        a.count = count;
        a.blockNumber = block.number;
        anchoredAt[msg.sender][head] = block.number;
        emit Anchored(msg.sender, chain, head, prevHead, count);
    }
}
