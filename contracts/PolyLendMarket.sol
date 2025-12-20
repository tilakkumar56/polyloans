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

    struct Extension {
        bool active;
        uint256 duration; 
        uint256 requestTime; 
        bool isRejected; 
        uint256 rejectionTime; 
    }

    mapping(uint256 => Request) public requests;
    mapping(uint256 => Loan) public loans;
    mapping(uint256 => Offer) public offers;
    mapping(uint256 => Extension) public extensions;
    
    uint256 public nextRequestId = 1;
    uint256 public nextOfferId = 1;

    IERC20 public usdc;
    IERC1155 public polymarket;

    constructor(address _usdc, address _polymarket) {
        usdc = IERC20(_usdc);
        polymarket = IERC1155(_polymarket);
    }

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

    // 🔥 NEW: ADDED CANCEL FUNCTION 🔥
    function cancelOffer(uint256 _offerId) external {
        Offer storage off = offers[_offerId];
        require(msg.sender == off.lender, "Not lender");
        require(off.active, "Not active");
        off.active = false;
    }

    function acceptOffer(uint256 _offerId) external nonReentrant {
        Offer memory off = offers[_offerId];
        Request storage req = requests[off.requestId];
        require(msg.sender == req.borrower, "Not borrower");
        require(req.active && !req.isLoan, "Invalid state");
        require(off.active, "Offer cancelled"); // Added check

        require(usdc.transferFrom(off.lender, req.borrower, req.principal), "Transfer failed");

        loans[off.requestId] = Loan(off.lender, block.timestamp, off.rate, req.duration);
        req.isLoan = true;
        delete offers[_offerId];
    }

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

    function _processExtension(uint256 _id, address _payer, address _recipient) internal {
        Loan storage loan = loans[_id];
        Request memory req = requests[_id];
        Extension storage ext = extensions[_id];

        uint256 interest = (req.principal * loan.rate * loan.duration) / (31536000 * 100);
        require(usdc.transferFrom(_payer, _recipient, interest), "Interest transfer failed");

        loan.startTime = block.timestamp; 
        loan.duration = ext.duration; 
        delete extensions[_id];
    }

    function acceptExtension(uint256 _id) external nonReentrant {
        Extension memory ext = extensions[_id];
        require(ext.active, "No request");
        if (msg.sender != loans[_id].lender) {
            require(msg.sender == requests[_id].borrower, "Not allowed");
            require(block.timestamp > ext.requestTime + 1 days, "Wait 24h for lender");
            require(!ext.isRejected, "Lender rejected");
        }
        _processExtension(_id, requests[_id].borrower, loans[_id].lender);
    }

    function rejectExtension(uint256 _id) external {
        require(msg.sender == loans[_id].lender, "Not lender");
        require(extensions[_id].active, "No request");
        extensions[_id].isRejected = true;
        extensions[_id].rejectionTime = block.timestamp;
    }

    function buyoutLoan(uint256 _id) external nonReentrant {
        Extension memory ext = extensions[_id];
        Loan storage loan = loans[_id];
        Request memory req = requests[_id];

        require(ext.isRejected, "Not rejected yet");
        require(block.timestamp < ext.rejectionTime + 1 days, "Buyout window expired");

        address oldLender = loan.lender;
        address newLender = msg.sender;

        require(usdc.transferFrom(newLender, oldLender, req.principal), "Principal transfer failed");
        uint256 interest = (req.principal * loan.rate * loan.duration) / (31536000 * 100);
        require(usdc.transferFrom(req.borrower, oldLender, interest), "Borrower interest failed");

        loan.lender = newLender;
        loan.startTime = block.timestamp;
        loan.duration = ext.duration; 
        delete extensions[_id];
    }

    function liquidateByTime(uint256 _id) external nonReentrant {
        Request storage req = requests[_id];
        Loan memory loan = loans[_id];
        Extension memory ext = extensions[_id];

        require(msg.sender == loan.lender, "Not lender");
        bool canSeize = false;
        if (!ext.active && block.timestamp > loan.startTime + loan.duration + 1 days) {
            canSeize = true;
        }
        else if (ext.isRejected && block.timestamp > ext.rejectionTime + 1 days) {
            canSeize = true;
        }
        require(canSeize, "Cannot seize yet");

        polymarket.safeTransferFrom(address(this), loan.lender, req.tokenId, req.shares, "");
        req.active = false;
        req.isLoan = false; 
        delete loans[_id];
    }

    function repayLoan(uint256 _id) external nonReentrant {
        Request storage req = requests[_id];
        Loan memory loan = loans[_id];
        require(req.isLoan && req.active, "Not active");

        uint256 interest = (req.principal * loan.rate * loan.duration) / (31536000 * 100);
        uint256 total = req.principal + interest;

        require(usdc.transferFrom(msg.sender, loan.lender, total), "Transfer failed");
        polymarket.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");

        req.active = false;
        req.isLoan = false; 
        delete loans[_id];
    }

    function cancelRequest(uint256 _id) external {
        Request storage req = requests[_id];
        require(msg.sender == req.borrower && !req.isLoan && req.active);
        polymarket.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");
        req.active = false;
    }
    function onERC1155Received(address, address, uint256, uint256, bytes memory) public virtual returns (bytes4) { return this.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory) public virtual returns (bytes4) { return this.onERC1155BatchReceived.selector; }
}