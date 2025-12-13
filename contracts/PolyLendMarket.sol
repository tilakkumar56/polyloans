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

    struct Offer {
        uint256 requestId;
        address lender;
        uint256 interestRate;
        bool isActive;
    }

    struct Extension {
        bool requested;
        uint256 newDuration;
        uint256 requestTime;
    }

    uint256 public nextRequestId = 1;
    uint256 public nextOfferId = 1;

    mapping(uint256 => Request) public requests;
    mapping(uint256 => Loan) public loans;
    mapping(uint256 => Offer) public offers;
    mapping(uint256 => Extension) public extensions;

    event RequestCreated(uint256 indexed requestId, address indexed borrower);
    event OfferMade(uint256 indexed offerId, uint256 indexed requestId, uint256 rate);
    event LoanStarted(uint256 indexed requestId, address lender, uint256 rate);
    event LoanRepaid(uint256 indexed requestId);
    event RequestCancelled(uint256 indexed requestId);
    event ExtensionRequested(uint256 indexed requestId, uint256 newDuration);
    event ExtensionAccepted(uint256 indexed requestId, uint256 newDuration);
    event LoanBuyout(uint256 indexed requestId, address newLender);
    event LoanLiquidated(uint256 indexed requestId);

    constructor(address _usdc, address _ctf) {
        usdc = IERC20(_usdc);
        ctf = IERC1155(_ctf);
    }

    function createRequest(uint256 _tokenId, uint256 _shares, uint256 _principal, uint256 _duration) external returns (uint256) {
        require(_shares > 0);
        ctf.safeTransferFrom(msg.sender, address(this), _tokenId, _shares, "");
        requests[nextRequestId] = Request(msg.sender, _tokenId, _shares, _principal, _duration, true, false);
        emit RequestCreated(nextRequestId, msg.sender);
        return nextRequestId++;
    }

    function cancelRequest(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        require(req.isActive && !req.isLoan && req.borrower == msg.sender);
        req.isActive = false;
        ctf.safeTransferFrom(address(this), msg.sender, req.tokenId, req.shares, "");
        emit RequestCancelled(_requestId);
    }

    function makeOffer(uint256 _requestId, uint256 _interestRate) external returns (uint256) {
        require(requests[_requestId].isActive);
        offers[nextOfferId] = Offer(_requestId, msg.sender, _interestRate, true);
        emit OfferMade(nextOfferId, _requestId, _interestRate);
        return nextOfferId++;
    }

    function cancelOffer(uint256 _offerId) external {
        require(offers[_offerId].lender == msg.sender);
        offers[_offerId].isActive = false;
    }

    function acceptOffer(uint256 _offerId) external nonReentrant {
        Offer storage offer = offers[_offerId];
        Request storage req = requests[offer.requestId];
        require(offer.isActive && req.isActive && req.borrower == msg.sender);

        req.isLoan = true; 
        loans[offer.requestId] = Loan(offer.lender, block.timestamp, offer.interestRate, req.duration);

        require(usdc.transferFrom(offer.lender, msg.sender, req.principal));
        emit LoanStarted(offer.requestId, offer.lender, offer.interestRate);
    }

    function repayLoan(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        Loan storage loan = loans[_requestId];
        require(req.isLoan && req.isActive);

        uint256 timeElapsed = block.timestamp - loan.startTime;
        if (timeElapsed < 1 days) timeElapsed = 1 days;
        
        uint256 interest = (req.principal * loan.interestRate * timeElapsed) / (365 days * 10000);
        uint256 totalDue = req.principal + interest;

        require(usdc.transferFrom(msg.sender, loan.lender, totalDue));
        ctf.safeTransferFrom(address(this), req.borrower, req.tokenId, req.shares, "");
        
        req.isActive = false;
        emit LoanRepaid(_requestId);
    }

    function liquidateByTime(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        Loan storage loan = loans[_requestId];
        Extension storage ext = extensions[_requestId];

        require(req.isLoan && req.isActive);
        
        // 48h grace period if extension requested
        uint256 grace = ext.requested ? 48 hours : 0;
        require(block.timestamp > loan.startTime + loan.duration + grace);

        ctf.safeTransferFrom(address(this), loan.lender, req.tokenId, req.shares, "");
        req.isActive = false;
        emit LoanLiquidated(_requestId);
    }

    function requestExtension(uint256 _requestId, uint256 _newDuration) external {
        Request storage req = requests[_requestId];
        require(req.borrower == msg.sender);
        extensions[_requestId] = Extension(true, _newDuration, block.timestamp);
        emit ExtensionRequested(_requestId, _newDuration);
    }

    function acceptExtension(uint256 _requestId) external nonReentrant {
        Loan storage loan = loans[_requestId];
        Extension storage ext = extensions[_requestId];
        Request storage req = requests[_requestId];
        require(msg.sender == loan.lender && ext.requested);

        uint256 timeElapsed = block.timestamp - loan.startTime;
        uint256 interest = (req.principal * loan.interestRate * timeElapsed) / (365 days * 10000);

        require(usdc.transferFrom(req.borrower, loan.lender, interest));

        loan.startTime = block.timestamp;
        loan.duration = ext.newDuration;
        ext.requested = false;
        emit ExtensionAccepted(_requestId, ext.newDuration);
    }

    function buyoutLoan(uint256 _requestId) external nonReentrant {
        Request storage req = requests[_requestId];
        Loan storage loan = loans[_requestId];
        Extension storage ext = extensions[_requestId];
        require(ext.requested && msg.sender != loan.lender);

        uint256 timeElapsed = block.timestamp - loan.startTime;
        uint256 interest = (req.principal * loan.interestRate * timeElapsed) / (365 days * 10000);

        require(usdc.transferFrom(msg.sender, loan.lender, req.principal));
        require(usdc.transferFrom(req.borrower, loan.lender, interest));

        loan.lender = msg.sender;
        loan.startTime = block.timestamp;
        loan.duration = ext.newDuration;
        ext.requested = false;
        
        emit LoanBuyout(_requestId, msg.sender);
    }
}