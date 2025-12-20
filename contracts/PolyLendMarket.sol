// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PolyLoans is ReentrancyGuard {
    
    struct Request {
        address borrower;
        uint256 tokenId;
        uint256 shares;
        uint256 principal;
        uint256 duration; 
        bool active;
        bool isLoan;
    }

    struct Loan {
        address lender;
        uint256 startTime;
        uint256 rate;
        uint256 duration;
    }

    struct Offer {
        uint256 requestId;
        address lender;
        uint256 rate;
        bool active;
    }

    // New Struct for the Complex Extension Logic
    struct Extension {
        bool active;
        uint256 duration; // New duration requested
        uint256 requestTime; // When request started
        bool isRejected; // Did lender reject?
        uint256 rejectionTime; // When did they reject?
    }

    mapping(uint256 => Request) public requests;
    mapping(uint256 => Loan) public loans;
    mapping(uint256 => Offer) public offers;
    mapping(uint256 => Extension) public extensions; // New Mapping
    
    uint256 public nextRequestId = 1;
    uint256 public nextOfferId = 1;

    IERC20 public usdc;
    IERC1155 public polymarket;

    constructor(address _usdc, address _polymarket) {
        usdc = IERC20(_usdc);
        polymarket = IERC1155(_polymarket);
    }

    // ... [Create Request, Make Offer, Accept Offer same as before] ...
    function createRequest(uint256 _tokenId, uint256 _shares, uint256 _principal, uint256 _duration) external {
        require(_shares > 0 && _principal > 0, "Zero inputs");
        polymarket.safeTransferFrom(msg.sender, address(this), _tokenId, _shares, "");
        requests[nextRequestId] = Request(msg.sender, _tokenId, _shares, _principal, _duration, true, false);
        nextRequestId++;
    }

    function makeOffer(uint256 _requestId, uint256 _rate) external {
        require(requests[_requestId].active, "Not active");
        offers[nextOfferId] = Offer(_requestId, msg.sender, _rate, true);
        nextOfferId++;
    }

    function acceptOffer(uint256 _offerId) external nonReentrant {
        Offer memory off = offers[_offerId];
        Request storage req = requests[off.requestId];
        require(msg.sender == req.borrower, "Not borrower");
        require(req.active && !req.isLoan, "Invalid state");

        require(usdc.transferFrom(off.lender, req.borrower, req.principal), "Transfer failed");

        loans[off.requestId] = Loan(off.lender, block.timestamp, off.rate, req.duration);
        req.isLoan = true;
        delete offers[_offerId];
    }

    // --- 🔥 NEW EXTENSION LOGIC 🔥 ---

    // 1. Borrower Requests Extension
    function requestExtension(uint256 _id, uint256 _newDuration) external {
        require(msg.sender == requests[_id].borrower, "Not borrower");
        require(loans[_id].lender != address(0), "No loan active");
        
        extensions[_id] = Extension({
            active: true,
            duration: _newDuration,
            requestTime: block.timestamp,
            isRejected: false,
            rejectionTime: 0
        });
    }

    // Helper to process interest payment and update loan
    function _processExtension(uint256 _id, address _payer, address _recipient) internal {
        Loan storage loan = loans[_id];
        Request memory req = requests[_id];
        Extension storage ext = extensions[_id];

        // 1. Calculate Interest owed SO FAR (Fixed Term logic)
        uint256 interest = (req.principal * loan.rate * loan.duration) / (31536000 * 100);
        
        // 2. Transfer Interest: Payer -> Recipient
        require(usdc.transferFrom(_payer, _recipient, interest), "Interest transfer failed");

        // 3. Update Loan
        loan.startTime = block.timestamp; // Reset clock
        loan.duration = ext.duration; // Set new duration
        
        // 4. Clear Extension Request
        delete extensions[_id];
    }

    // 2. Lender Accepts (Or Borrower Auto-Accepts after 24h)
    function acceptExtension(uint256 _id) external nonReentrant {
        Extension memory ext = extensions[_id];
        require(ext.active, "No request");
        
        // Logic: If Lender calls -> OK. If Borrower calls -> Must be > 24h.
        if (msg.sender != loans[_id].lender) {
            require(msg.sender == requests[_id].borrower, "Not allowed");
            require(block.timestamp > ext.requestTime + 1 days, "Wait 24h for lender");
            require(!ext.isRejected, "Lender rejected");
        }

        // Borrower pays interest to Lender
        _processExtension(_id, requests[_id].borrower, loans[_id].lender);
    }

    // 3. Lender Rejects
    function rejectExtension(uint256 _id) external {
        require(msg.sender == loans[_id].lender, "Not lender");
        require(extensions[_id].active, "No request");
        
        extensions[_id].isRejected = true;
        extensions[_id].rejectionTime = block.timestamp;
    }

    // 4. New Lender Buyout (Refinancing)
    function buyoutLoan(uint256 _id) external nonReentrant {
        Extension memory ext = extensions[_id];
        Loan storage loan = loans[_id];
        Request memory req = requests[_id];

        require(ext.isRejected, "Not rejected yet");
        // Buyout Window: 24h after rejection
        require(block.timestamp < ext.rejectionTime + 1 days, "Buyout window expired");

        address oldLender = loan.lender;
        address newLender = msg.sender;

        // 1. New Lender pays Principal to Old Lender
        require(usdc.transferFrom(newLender, oldLender, req.principal), "Principal transfer failed");

        // 2. Borrower pays Interest to Old Lender (Must have allowance)
        uint256 interest = (req.principal * loan.rate * loan.duration) / (31536000 * 100);
        require(usdc.transferFrom(req.borrower, oldLender, interest), "Borrower interest failed");

        // 3. Transfer Loan Ownership
        loan.lender = newLender;
        loan.startTime = block.timestamp;
        loan.duration = ext.duration; // Update to new requested duration

        delete extensions[_id];
    }

    // 5. Seize (Liquidate) - Only if Buyout Window Failed
    function liquidateByTime(uint256 _id) external nonReentrant {
        Request storage req = requests[_id];
        Loan memory loan = loans[_id];
        Extension memory ext = extensions[_id];

        require(msg.sender == loan.lender, "Not lender");
        
        bool canSeize = false;

        // Case A: Standard Expiry (No Extension Request)
        if (!ext.active && block.timestamp > loan.startTime + loan.duration + 1 days) {
            canSeize = true;
        }
        // Case B: Rejected Extension + 24h Buyout Window Passed
        else if (ext.isRejected && block.timestamp > ext.rejectionTime + 1 days) {
            canSeize = true;
        }

        require(canSeize, "Cannot seize yet");

        // Seize Collateral
        polymarket.safeTransferFrom(address(this), loan.lender, req.tokenId, req.shares, "");
        req.active = false;
        req.isLoan = false; // Mark as closed
        delete loans[_id];
    }

    // 6. Repay (Standard)
    function repayLoan(uint256 _id) external nonReentrant {
        Request storage req = requests[_id];
        Loan memory loan = loans[_id];
        require(req.isLoan && req.active, "Not active");

        uint256 interest = (req.principal * loan.rate * loan.duration) / (31536000 * 100);
        uint256 total = req.principal + interest;

        require(usdc.transferFrom(msg.sender, loan.lender, total), "Transfer failed");
        polymarket.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");

        req.active = false;
        req.isLoan = false; // Mark as closed
        delete loans[_id];
    }

    // ... [Cancel Request, Boilerplate ERC1155 receivers same as before] ...
    function cancelRequest(uint256 _id) external {
        Request storage req = requests[_id];
        require(msg.sender == req.borrower && !req.isLoan && req.active);
        polymarket.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");
        req.active = false;
    }
    function onERC1155Received(address, address, uint256, uint256, bytes memory) public virtual returns (bytes4) { return this.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory) public virtual returns (bytes4) { return this.onERC1155BatchReceived.selector; }
}