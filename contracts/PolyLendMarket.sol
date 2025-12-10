// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PolyLendMarket is ERC1155Holder, ReentrancyGuard {
    
    struct Request {
        address borrower;
        uint256 tokenId;
        uint256 shares;
        uint256 principal;
        uint256 desiredDuration;
        bool isActive;
    }
    struct Offer {
        uint256 requestId;
        address lender;
        uint256 interestRate;
        uint256 duration;
        bool isActive;
    }
    struct ActiveLoan {
        address borrower;
        address lender;
        uint256 tokenId;
        uint256 shares;
        uint256 principal;
        uint256 interestRate;
        uint256 startTime;
        uint256 duration;
    }

    IERC20 public usdc;
    IERC1155 public ctf; 
    
    uint256 public nextRequestId = 1;
    uint256 public nextOfferId = 1;
    
    mapping(uint256 => Request) public requests;
    mapping(uint256 => Offer) public offers;
    mapping(uint256 => ActiveLoan) public activeLoans;

    event RequestCreated(uint256 indexed requestId, uint256 tokenId);
    event OfferMade(uint256 indexed offerId, uint256 requestId);
    event LoanStarted(uint256 indexed requestId);
    event LoanRepaid(uint256 indexed requestId);
    event LoanLiquidated(uint256 indexed requestId, string reason);
    event OfferCancelled(uint256 indexed offerId);

    constructor(address _usdc, address _ctf) {
        usdc = IERC20(_usdc);
        ctf = IERC1155(_ctf);
    }

    function createRequest(uint256 _tokenId, uint256 _shares, uint256 _principal, uint256 _duration) external returns (uint256) {
        requests[nextRequestId] = Request(msg.sender, _tokenId, _shares, _principal, _duration, true);
        emit RequestCreated(nextRequestId, _tokenId);
        return nextRequestId++;
    }

    function makeOffer(uint256 _requestId, uint256 _interestRate, uint256 _duration) external returns (uint256) {
        require(requests[_requestId].isActive, "Request inactive");
        require(_duration > 0, "Duration required");
        offers[nextOfferId] = Offer(_requestId, msg.sender, _interestRate, _duration, true);
        emit OfferMade(nextOfferId, _requestId);
        return nextOfferId++;
    }

    function cancelOffer(uint256 _offerId) external nonReentrant {
        Offer storage offer = offers[_offerId];
        require(msg.sender == offer.lender, "Not your offer");
        require(offer.isActive, "Already inactive");
        offer.isActive = false;
        emit OfferCancelled(_offerId);
    }

    function acceptOffer(uint256 _offerId) external nonReentrant {
        Offer storage offer = offers[_offerId];
        Request storage req = requests[offer.requestId];
        require(offer.isActive && req.isActive, "Invalid");
        require(msg.sender == req.borrower, "Only borrower");

        require(usdc.transferFrom(offer.lender, req.borrower, req.principal), "USDC Transfer failed");
        ctf.safeTransferFrom(req.borrower, address(this), req.tokenId, req.shares, "");

        activeLoans[offer.requestId] = ActiveLoan(req.borrower, offer.lender, req.tokenId, req.shares, req.principal, offer.interestRate, block.timestamp, offer.duration);
        
        req.isActive = false;
        offer.isActive = false;
        emit LoanStarted(offer.requestId);
    }

    // 🔥 MODIFIED: MINIMUM 1 DAY INTEREST 🔥
    function getDebt(uint256 _requestId) public view returns (uint256) {
        ActiveLoan storage loan = activeLoans[_requestId];
        if (loan.startTime == 0) return 0;

        uint256 timeElapsed = block.timestamp - loan.startTime;
        
        // ENFORCE FLOOR: If less than 1 day, charge for 1 day
        uint256 effectiveTime = timeElapsed < 1 days ? 1 days : timeElapsed;

        // Interest = Principal * Rate * Time / (365 days * 10000)
        uint256 interest = (loan.principal * loan.interestRate * effectiveTime) / (365 days * 10000);
        return loan.principal + interest;
    }

    function repayLoan(uint256 _requestId) external nonReentrant {
        ActiveLoan storage loan = activeLoans[_requestId];
        require(loan.startTime > 0, "No loan");
        
        uint256 totalDue = getDebt(_requestId);
        require(usdc.transferFrom(msg.sender, loan.lender, totalDue), "Repayment failed");
        
        ctf.safeTransferFrom(address(this), loan.borrower, loan.tokenId, loan.shares, "");
        delete activeLoans[_requestId];
        emit LoanRepaid(_requestId);
    }

    function liquidateByTime(uint256 _requestId) external nonReentrant {
        ActiveLoan storage loan = activeLoans[_requestId];
        require(loan.startTime > 0, "No loan");
        require(block.timestamp > loan.startTime + loan.duration, "Time not expired yet");

        ctf.safeTransferFrom(address(this), loan.lender, loan.tokenId, loan.shares, "");
        delete activeLoans[_requestId];
        emit LoanLiquidated(_requestId, "Time Expired");
    }
}