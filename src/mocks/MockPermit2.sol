// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPermit2} from "../Drainer.sol";

/// @dev Minimal Permit2 replica with the exact EIP-712 shape (name "Permit2", no version field),
///      so tests exercise the same digest the real contract verifies.
contract MockPermit2 {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Permit2");
    bytes32 private constant DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    struct Packed {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Packed))) public allowance;

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, block.chainid, address(this)));
    }

    function permit(address owner, IPermit2.PermitBatch calldata batch, bytes calldata signature) external {
        require(block.timestamp <= batch.sigDeadline, "expired");

        bytes32[] memory hashes = new bytes32[](batch.details.length);
        for (uint256 i; i < batch.details.length; ++i) {
            hashes[i] = keccak256(abi.encode(DETAILS_TYPEHASH, batch.details[i]));
        }
        bytes32 structHash =
            keccak256(abi.encode(BATCH_TYPEHASH, keccak256(abi.encodePacked(hashes)), batch.spender, batch.sigDeadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        require(ECDSA.recover(digest, signature) == owner, "bad signature");

        for (uint256 i; i < batch.details.length; ++i) {
            Packed storage p = allowance[owner][batch.details[i].token][batch.spender];
            require(p.nonce == batch.details[i].nonce, "nonce");
            p.amount = batch.details[i].amount;
            p.expiration = batch.details[i].expiration;
            p.nonce = batch.details[i].nonce + 1;
        }
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Packed storage p = allowance[from][token][msg.sender];
        require(block.timestamp <= p.expiration, "allowance expired");
        if (p.amount != type(uint160).max) {
            require(amount <= p.amount, "insufficient allowance");
            p.amount -= amount;
        }
        require(IERC20Like(token).transferFrom(from, to, amount), "transfer failed");
    }
}

interface IERC20Like {
    function transferFrom(address, address, uint256) external returns (bool);
}
