// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PolyLendMarket is ERC1155Holder, ReentrancyGuard {
    
    IERC20 public usdc;
    IERC1155 public ctf;

    struct Request {
        address borrower;
        uint256 tokenId;
        uint256 shares;
        uint256 principal;
        uint256 duration;
        bool isActive;
        bool isLoan;
    }

    struct Loan {
        address lender;
        uint256 startTime;
        uint256 interestRate;
        uint256 duration;
    }

    uint256 public nextRequestId = 1;
    uint256 public nextOfferId = 1;

    mapping(uint256 => Request) public requests;
    mapping(uint256 => Loan) public loans;
    
    struct Offer {
        uint256 requestId;
        address lender;
        uint256 interestRate;
        bool isActive;
    }
    mapping(uint256 => Offer) public offers;

    // Extension Request
    struct Extension {
        bool requested;
        uint256 newDuration;
        uint256 accruedInterest;
        uint256 requestTime;
    }
    mapping(uint256 => Extension) public extensions;

    event RequestCreated(uint256 indexed id, address indexed borrower);
    event OfferMade(uint256 indexed id, uint256 indexed requestId, uint256 rate);
    event LoanStarted(uint256 indexed id, address lender, uint256 rate);
    event LoanRepaid(uint256 indexed id);
    event RequestCancelled(uint256 indexed id);
    event ExtensionRequested(uint256 indexed id);
    event LoanBuyout(uint256 indexed id, address newLender);

    constructor(address _usdc, address _ctf) {
        usdc = IERC20(_usdc);
        ctf = IERC1155(_ctf);
    }

    function createRequest(uint256 _tokenId, uint256 _shares, uint256 _principal, uint256 _duration) external returns (uint256) {
        require(_shares > 0, "No shares");
        ctf.safeTransferFrom(msg.sender, address(this), _tokenId, _shares, "");
        requests[nextRequestId] = Request({
            borrower: msg.sender,
            tokenId: _tokenId,
            shares: _shares,
            principal: _principal,
            duration: _duration,
            isActive: true,
            isLoan: false
        });
        emit RequestCreated(nextRequestId, msg.sender);
        return nextRequestId++;
    }

    function cancelRequest(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        require(req.isActive && !req.isLoan && req.borrower == msg.sender, "Invalid cancel");
        req.isActive = false;
        ctf.safeTransferFrom(address(this), msg.sender, req.tokenId, req.shares, "");
        emit RequestCancelled(_requestId);
    }

    function makeOffer(uint256 _requestId, uint256 _interestRate) external returns (uint256) {
        require(requests[_requestId].isActive, "Inactive");
        offers[nextOfferId] = Offer({
            requestId: _requestId,
            lender: msg.sender,
            interestRate: _interestRate,
            isActive: true
        });
        emit OfferMade(nextOfferId, _requestId, _interestRate);
        return nextOfferId++;
    }

    function cancelOffer(uint256 _offerId) external {
        require(offers[_offerId].lender == msg.sender, "Not owner");
        offers[_offerId].isActive = false;
    }

    function acceptOffer(uint256 _offerId) external nonReentrant {
        Offer storage offer = offers[_offerId];
        Request storage req = requests[offer.requestId];
        require(offer.isActive && req.isActive && req.borrower == msg.sender, "Invalid accept");

        req.isLoan = true; 
        loans[offer.requestId] = Loan({
            lender: offer.lender,
            startTime: block.timestamp,
            interestRate: offer.interestRate,
            duration: req.duration
        });

        require(usdc.transferFrom(offer.lender, msg.sender, req.principal), "Transfer failed");
        emit LoanStarted(offer.requestId, offer.lender, offer.interestRate);
    }

    function repayLoan(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        Loan storage loan = loans[_requestId];
        require(req.isLoan && req.isActive, "Invalid loan");

        uint256 timeElapsed = block.timestamp - loan.startTime;
        if (timeElapsed < 1 minutes) timeElapsed = 1 minutes; // Minimum interest 1 min for testing
        
        uint256 interest = (req.principal * loan.interestRate * timeElapsed) / (365 days * 10000);
        uint256 totalDue = req.principal + interest;

        require(usdc.transferFrom(msg.sender, loan.lender, totalDue), "Repayment failed");
        ctf.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");
        
        req.isActive = false;
        emit LoanRepaid(_requestId);
    }

    function liquidateByTime(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        Loan storage loan = loans[_requestId];
        require(req.isLoan && req.isActive, "Invalid loan");
        require(block.timestamp > loan.startTime + loan.duration, "Not expired");
        
        ctf.safeTransferFrom(address(this), loan.lender, req.tokenId, req.shares, "");
        req.isActive = false;
    }

    // --- REFINANCING & EXTENSION ---

    function requestExtension(uint256 _requestId, uint256 _newDuration) external {
        Request storage req = requests[_requestId];
        Loan storage loan = loans[_requestId];
        require(req.borrower == msg.sender, "Not borrower");
        
        uint256 timeElapsed = block.timestamp - loan.startTime;
        uint256 interest = (req.principal * loan.interestRate * timeElapsed) / (365 days * 10000);

        extensions[_requestId] = Extension({
            requested: true,
            newDuration: _newDuration,
            accruedInterest: interest,
            requestTime: block.timestamp
        });
        emit ExtensionRequested(_requestId);
    }

    // New Lender Buys Out the Loan (Refinancing)
    function buyoutLoan(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        Loan storage loan = loans[_requestId];
        Extension storage ext = extensions[_requestId];

        require(ext.requested, "No extension requested");
        require(msg.sender != loan.lender, "Existing lender cannot buyout");

        // 1. New Lender pays Principal to Old Lender
        require(usdc.transferFrom(msg.sender, loan.lender, req.principal), "Buyout failed");

        // 2. Borrower pays Interest to Old Lender (Must Approve Contract)
        require(usdc.transferFrom(req.borrower, loan.lender, ext.accruedInterest), "Interest payment failed");

        // 3. Update Loan Registry
        loan.lender = msg.sender;
        loan.startTime = block.timestamp;
        loan.duration = ext.newDuration;
        
        // Clear extension request
        ext.requested = false;
        emit LoanBuyout(_requestId, msg.sender);
    }

    // Existing Lender Accepts Extension
    function acceptExtension(uint256 _requestId) external nonReentrant {
        Loan storage loan = loans[_requestId];
        Extension storage ext = extensions[_requestId];
        Request storage req = requests[_requestId];
        require(msg.sender == loan.lender, "Not lender");
        require(ext.requested, "No request");

        // Borrower pays Interest to Lender
        require(usdc.transferFrom(req.borrower, loan.lender, ext.accruedInterest), "Interest payment failed");

        loan.startTime = block.timestamp;
        loan.duration = ext.newDuration;
        ext.requested = false;
    }
}