// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PolyLoans is ReentrancyGuard {
    
    // --- STRUCTS ---
    struct Request {
        address borrower;
        uint256 tokenId;
        uint256 shares;
        uint256 principal;
        uint256 duration; // Scheduled Duration
        bool active;
        bool isLoan;
    }

    struct Loan {
        address lender;
        uint256 startTime;
        uint256 rate;
        uint256 duration; // Fixed Duration for Interest Calc
    }

    struct Offer {
        uint256 requestId;
        address lender;
        uint256 rate;
        bool active;
    }

    // --- STATE ---
    mapping(uint256 => Request) public requests;
    mapping(uint256 => Loan) public loans;
    mapping(uint256 => Offer) public offers;
    
    uint256 public nextRequestId = 1;
    uint256 public nextOfferId = 1;

    IERC20 public usdc;
    IERC1155 public polymarket;

    constructor(address _usdc, address _polymarket) {
        usdc = IERC20(_usdc);
        polymarket = IERC1155(_polymarket);
    }

    // --- 1. BORROWER CREATES REQUEST ---
    function createRequest(uint256 _tokenId, uint256 _shares, uint256 _principal, uint256 _duration) external {
        require(_shares > 0 && _principal > 0, "Zero inputs");
        
        // Lock Collateral
        polymarket.safeTransferFrom(msg.sender, address(this), _tokenId, _shares, "");

        requests[nextRequestId] = Request({
            borrower: msg.sender,
            tokenId: _tokenId,
            shares: _shares,
            principal: _principal,
            duration: _duration,
            active: true,
            isLoan: false
        });
        nextRequestId++;
    }

    // --- 2. LENDER MAKES OFFER ---
    function makeOffer(uint256 _requestId, uint256 _rate) external {
        require(requests[_requestId].active, "Not active");
        offers[nextOfferId] = Offer(_requestId, msg.sender, _rate, true);
        nextOfferId++;
    }

    // --- 3. BORROWER ACCEPTS OFFER ---
    function acceptOffer(uint256 _offerId) external nonReentrant {
        Offer memory off = offers[_offerId];
        Request storage req = requests[off.requestId];
        require(msg.sender == req.borrower, "Not borrower");
        require(req.active && !req.isLoan, "Invalid state");

        // Transfer Principal from Lender to Borrower
        require(usdc.transferFrom(off.lender, req.borrower, req.principal), "Transfer failed");

        // Create Loan
        loans[off.requestId] = Loan({
            lender: off.lender,
            startTime: block.timestamp,
            rate: off.rate,
            duration: req.duration 
        });

        req.isLoan = true;
        
        // Close Offer
        delete offers[_offerId];
    }

    // --- 4. REPAY LOAN (🔥 FIXED INTEREST LOGIC 🔥) ---
    function repayLoan(uint256 _id) external nonReentrant {
        Request storage req = requests[_id];
        Loan memory loan = loans[_id];
        require(req.isLoan && req.active, "Not active loan");

        // 🔥 CRITICAL CHANGE: Calculate Interest based on FIXED DURATION
        // Previous: (block.timestamp - loan.startTime)
        // New: loan.duration (The full agreed time)
        uint256 interest = (req.principal * loan.rate * loan.duration) / (365 days * 100);
        uint256 totalDue = req.principal + interest;

        // Payer pays Lender
        require(usdc.transferFrom(msg.sender, loan.lender, totalDue), "USDC transfer failed");

        // Return Collateral
        polymarket.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");

        // Close Loan
        req.active = false; 
        delete loans[_id]; 
    }

    // --- 5. LIQUIDATION (SEIZE) ---
    function liquidateByTime(uint256 _id) external nonReentrant {
        Request storage req = requests[_id];
        Loan memory loan = loans[_id];
        
        require(req.active && req.isLoan, "Not active");
        // Check if Duration + 24h Grace Period has passed
        require(block.timestamp > loan.startTime + loan.duration + 1 days, "Not expired yet"); 
        require(msg.sender == loan.lender, "Not lender");

        // Seize Collateral
        polymarket.safeTransferFrom(address(this), loan.lender, req.tokenId, req.shares, "");

        req.active = false;
        delete loans[_id];
    }

    // --- 6. CANCEL REQUEST ---
    function cancelRequest(uint256 _id) external {
        Request storage req = requests[_id];
        require(msg.sender == req.borrower, "Not borrower");
        require(!req.isLoan && req.active, "Cannot cancel");

        polymarket.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");
        req.active = false;
    }
    
    // Boilerplate for ERC1155 Receiver
    function onERC1155Received(address, address, uint256, uint256, bytes memory) public virtual returns (bytes4) { return this.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory) public virtual returns (bytes4) { return this.onERC1155BatchReceived.selector; }
}