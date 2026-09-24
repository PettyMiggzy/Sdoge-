// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test double for Arc's USDC at 0x3600...0000, etched there by the tests. Like the real chain,
/// it's a 6-decimal ERC-20 VIEW over each account's NATIVE balance (18 decimals): msg.value paid
/// to a contract shows up as its USDC balance, and transfers run no code at the recipient, so a
/// contract without a payable receive() can still be paid.
///
/// ERC-20 movements are kept as a signed per-account adjustment on top of the native balance,
/// in this contract's storage, so a reverted transaction undoes them. (Moving native balances
/// with vm.deal would survive reverts and corrupt the test state.)
contract ArcUsdcMock {
    uint256 private constant SCALE = 1e12;

    mapping(address => int256) private _adjustWei;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function name() external pure returns (string memory) {
        return "USDC";
    }

    function symbol() external pure returns (string memory) {
        return "USDC";
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _weiOf(account) / SCALE;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "USDC: allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _weiOf(address account) private view returns (uint256) {
        int256 w = int256(account.balance) + _adjustWei[account];
        return w > 0 ? uint256(w) : 0;
    }

    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "USDC: to zero"); // Arc rejects transfers to the zero address
        uint256 w = value * SCALE;
        require(_weiOf(from) >= w, "USDC: balance");
        _adjustWei[from] -= int256(w);
        _adjustWei[to] += int256(w);
        emit Transfer(from, to, value);
    }
}
