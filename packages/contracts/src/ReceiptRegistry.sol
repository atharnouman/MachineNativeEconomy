// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title ReceiptRegistry
/// @notice Anchors the head of a principal's off-chain receipt hash chain so an evidence bundle can be proven
///         to have existed, unmodified, at a given block. Receipts themselves stay off-chain (they may carry
///         commercial metadata); only hashes are anchored.
contract ReceiptRegistry {
    struct Anchor {
        bytes32 head; // hash of the latest receipt in the chain
        uint256 count; // number of receipts in the chain at anchoring time
        uint256 blockNumber;
    }

    mapping(address => Anchor) public latest; // anchoring party (gateway for a principal) => latest anchor
    mapping(address => mapping(bytes32 => uint256)) public anchoredAt; // party => head => block

    event Anchored(address indexed party, bytes32 indexed head, bytes32 indexed prevHead, uint256 count);

    error NonMonotonicCount(uint256 have, uint256 got);
    error PrevHeadMismatch(bytes32 expected, bytes32 got);

    function anchor(bytes32 head, bytes32 prevHead, uint256 count) external {
        Anchor storage a = latest[msg.sender];
        if (a.head != prevHead) revert PrevHeadMismatch(a.head, prevHead);
        if (count < a.count) revert NonMonotonicCount(a.count, count);
        a.head = head;
        a.count = count;
        a.blockNumber = block.number;
        anchoredAt[msg.sender][head] = block.number;
        emit Anchored(msg.sender, head, prevHead, count);
    }
}
