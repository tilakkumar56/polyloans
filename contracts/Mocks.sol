// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

// A fake USDC token for testing
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) public { _mint(to, amount); }
}

// A fake Polymarket (Conditional Token) framework for testing
contract MockERC1155 is ERC1155 {
    constructor(string memory uri) ERC1155(uri) {}
    function mint(address to, uint256 id, uint256 amount, bytes memory data) public { _mint(to, id, amount, data); }
}