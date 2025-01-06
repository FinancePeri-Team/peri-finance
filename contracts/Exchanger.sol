pragma solidity 0.5.16;
pragma experimental ABIEncoderV2;
// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/ICircuitBreaker.sol";
import "./interfaces/IPeriFinance.sol";
import "./interfaces/IFeePool.sol";
import "./interfaces/IDelegateApprovals.sol";
import "./interfaces/ITradingRewards.sol";
import "./interfaces/IVirtualPynth.sol";

import "./ExchangeSettlementLib.sol";

import "./Proxyable.sol";

// https://docs.peri.finance/contracts/source/contracts/exchanger
contract Exchanger is Owned, MixinSystemSettings, IExchanger {
    using SafeMath for uint;
    using SafeDecimalMath for uint;
    

    bytes32 public constant CONTRACT_NAME = "Exchanger";

    bytes32 private constant pUSD = "pUSD";

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_EXCHANGESTATE = "ExchangeState";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_PERIFINANCE = "PeriFinance";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";
    bytes32 private constant CONTRACT_TRADING_REWARDS = "TradingRewards";
    bytes32 private constant CONTRACT_DELEGATEAPPROVALS = "DelegateApprovals";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_DEBTCACHE = "DebtCache";
    bytes32 private constant CONTRACT_CIRCUIT_BREAKER = "CircuitBreaker";
    bytes32 private constant CONTRACT_DIRECT_INTEGRATION_MANAGER = "DirectIntegrationManager";

    constructor(address _owner, address _resolver) public Owned(_owner) MixinSystemSettings(_resolver) {}

    /* ========== VIEWS ========== */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](11);
        newAddresses[0] = CONTRACT_SYSTEMSTATUS;
        newAddresses[1] = CONTRACT_EXCHANGESTATE;
        newAddresses[2] = CONTRACT_EXRATES;
        newAddresses[3] = CONTRACT_PERIFINANCE;
        newAddresses[4] = CONTRACT_FEEPOOL;
        newAddresses[5] = CONTRACT_TRADING_REWARDS;
        newAddresses[6] = CONTRACT_DELEGATEAPPROVALS;
        newAddresses[7] = CONTRACT_ISSUER;
        newAddresses[8] = CONTRACT_DEBTCACHE;
        newAddresses[9] = CONTRACT_CIRCUIT_BREAKER;
        newAddresses[10] = CONTRACT_DIRECT_INTEGRATION_MANAGER;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(requireAndGetAddress(CONTRACT_SYSTEMSTATUS));
    }

    function exchangeState() internal view returns (IExchangeState) {
        return IExchangeState(requireAndGetAddress(CONTRACT_EXCHANGESTATE));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function circuitBreaker() internal view returns (ICircuitBreaker) {
        return ICircuitBreaker(requireAndGetAddress(CONTRACT_CIRCUIT_BREAKER));
    }

    function periFinance() internal view returns (IPeriFinance) {
        return IPeriFinance(requireAndGetAddress(CONTRACT_PERIFINANCE));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(requireAndGetAddress(CONTRACT_FEEPOOL));
    }

    function tradingRewards() internal view returns (ITradingRewards) {
        return ITradingRewards(requireAndGetAddress(CONTRACT_TRADING_REWARDS));
    }

    function delegateApprovals() internal view returns (IDelegateApprovals) {
        return IDelegateApprovals(requireAndGetAddress(CONTRACT_DELEGATEAPPROVALS));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function debtCache() internal view returns (IExchangerInternalDebtCache) {
        return IExchangerInternalDebtCache(requireAndGetAddress(CONTRACT_DEBTCACHE));
    }

    function directIntegrationManager() internal view returns (IDirectIntegrationManager) {
        return IDirectIntegrationManager(requireAndGetAddress(CONTRACT_DIRECT_INTEGRATION_MANAGER));
    }

    function resolvedAddresses() internal view returns (ExchangeSettlementLib.ResolvedAddresses memory) {
        ExchangeSettlementLib.ResolvedAddresses memory addresses =
            ExchangeSettlementLib.ResolvedAddresses(
                exchangeState(),
                exchangeRates(),
                circuitBreaker(),
                debtCache(),
                issuer(),
                periFinance()
            );
        return
            addresses;
    }

    function waitingPeriodSecs() external view returns (uint) {
        return getWaitingPeriodSecs();
    }

    function tradingRewardsEnabled() external view returns (bool) {
        return getTradingRewardsEnabled();
    }

    function priceDeviationThresholdFactor() external view returns (uint) {
        return getPriceDeviationThresholdFactor();
    }

    function lastExchangeRate(bytes32 currencyKey) external view returns (uint) {
        return circuitBreaker().lastValue(address(exchangeRates().aggregators(currencyKey)));
    }

    function settlementOwing(address account, bytes32 currencyKey)
        public
        view
        returns (
            uint reclaimAmount,
            uint rebateAmount,
            uint numEntries
        )
    {
        (reclaimAmount, rebateAmount, numEntries, ) = ExchangeSettlementLib.settlementOwing(
            resolvedAddresses(),
            account,
            currencyKey,
            getWaitingPeriodSecs()
        );
    }

    function hasWaitingPeriodOrSettlementOwing(address account, bytes32 currencyKey) external view returns (bool) {
        return
            ExchangeSettlementLib.hasWaitingPeriodOrSettlementOwing(
                resolvedAddresses(),
                account,
                currencyKey,
                getWaitingPeriodSecs()
            );
    }

    function maxSecsLeftInWaitingPeriod(address account, bytes32 currencyKey) public view returns (uint) {
        return
            ExchangeSettlementLib._secsLeftInWaitingPeriodForExchange(
                exchangeState().getMaxTimestamp(account, currencyKey),
                getWaitingPeriodSecs()
            );
    }

    /* ========== SETTERS ========== */

    function calculateAmountAfterSettlement(
        address from,
        bytes32 currencyKey,
        uint amount,
        uint refunded
    ) public view returns (uint amountAfterSettlement) {
        amountAfterSettlement = amount;

        // balance of a pynth will show an amount after settlement
        uint balanceOfSourceAfterSettlement = IERC20(address(issuer().pynths(currencyKey))).balanceOf(from);

        // when there isn't enough supply (either due to reclamation settlement or because the number is too high)
        if (amountAfterSettlement > balanceOfSourceAfterSettlement) {
            // then the amount to exchange is reduced to their remaining supply
            amountAfterSettlement = balanceOfSourceAfterSettlement;
        }

        if (refunded > 0) {
            amountAfterSettlement = amountAfterSettlement.add(refunded);
        }
    }

    function isPynthRateInvalid(bytes32 currencyKey) external view returns (bool) {
        (, bool invalid) = exchangeRates().rateAndInvalid(currencyKey);
        return invalid;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */
    function exchange(
        address exchangeForAddress,
        address from,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address destinationAddress,
        bool virtualPynth,
        address rewardAddress,
        bytes32 trackingCode
    ) external onlyPeriFinanceorPynth returns (uint amountReceived, IVirtualPynth vPynth) {

        uint fee;
        if (from != exchangeForAddress) {
            require(delegateApprovals().canExchangeFor(exchangeForAddress, from), "Not approved to act on behalf");
        }

        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings =
            _exchangeSettings(from, sourceCurrencyKey);
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings =
            _exchangeSettings(from, destinationCurrencyKey);
        
        (amountReceived, fee, vPynth) = _exchange(
            exchangeForAddress,
            sourceSettings,
            sourceAmount,
            destinationSettings,
            destinationAddress,
            virtualPynth
        );

        

        _processTradingRewards(fee, rewardAddress);

        if (trackingCode != bytes32(0)) {
            _emitTrackingEvent(trackingCode, destinationCurrencyKey, amountReceived, fee);
        }
    }

    function exchangeAtomically(
        address,
        bytes32,
        uint,
        bytes32,
        address,
        bytes32,
        uint
    ) external returns (uint) {
        _notImplemented();
    }

    function _emitTrackingEvent(
        bytes32 trackingCode,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        uint256 fee
    ) internal {
        IPeriFinanceInternal(address(periFinance())).emitExchangeTracking(trackingCode, toCurrencyKey, toAmount, fee);
    }

    function _processTradingRewards(uint fee, address rewardAddress) internal {
        if (fee > 0 && rewardAddress != address(0) && getTradingRewardsEnabled()) {
            tradingRewards().recordExchangeFeeForAccount(fee, rewardAddress);
        }
    }

    function _updatePERIIssuedDebtOnExchange(bytes32[2] memory currencyKeys, uint[2] memory currencyRates) internal {
        bool includesPUSD = currencyKeys[0] == pUSD || currencyKeys[1] == pUSD;
        uint numKeys = includesPUSD ? 2 : 3;

        bytes32[] memory keys = new bytes32[](numKeys);
        keys[0] = currencyKeys[0];
        keys[1] = currencyKeys[1];

        uint[] memory rates = new uint[](numKeys);
        rates[0] = currencyRates[0];
        rates[1] = currencyRates[1];

        if (!includesPUSD) {
            keys[2] = pUSD; // And we'll also update pUSD to account for any fees if it wasn't one of the exchanged currencies
            rates[2] = SafeDecimalMath.unit();
        }

        // Note that exchanges can't invalidate the debt cache, since if a rate is invalid,
        // the exchange will have failed already.
        debtCache().updateCachedPynthDebtsWithRates(keys, rates);
    }

    function _settleAndCalcSourceAmountRemaining(
        uint sourceAmount,
        address from,
        bytes32 sourceCurrencyKey
    ) internal returns (uint sourceAmountAfterSettlement) {
        (, uint refunded, uint numEntriesSettled) =
            ExchangeSettlementLib.internalSettle(
                resolvedAddresses(),
                from,
                sourceCurrencyKey,
                false,
                getWaitingPeriodSecs()
            );

        sourceAmountAfterSettlement = sourceAmount;

        // when settlement was required
        if (numEntriesSettled > 0) {
            // ensure the sourceAmount takes this into account
            sourceAmountAfterSettlement = calculateAmountAfterSettlement(from, sourceCurrencyKey, sourceAmount, refunded);
        }
    }


function uint2str(uint _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) {
            return "0";
        }
        uint j = _i;
        uint len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint k = len;
        while (_i != 0) {
            k = k-1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }


function toString(address account) public pure returns(string memory) {
    return toString(abi.encodePacked(account));
}

function toString(uint256 value) public pure returns(string memory) {
    return toString(abi.encodePacked(value));
}

function toString(bytes32 value) public pure returns(string memory) {
    return toString(abi.encodePacked(value));
}

function toString(bytes memory data) public pure returns(string memory) {
    bytes memory alphabet = "0123456789abcdef";

    bytes memory str = new bytes(2 + data.length * 2);
    str[0] = "0";
    str[1] = "x";
    for (uint i = 0; i < data.length; i++) {
        str[2+i*2] = alphabet[uint(uint8(data[i] >> 4))];
        str[3+i*2] = alphabet[uint(uint8(data[i] & 0x0f))];
    }
    return string(str);
}


    function _exchange(
        address from,
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings,
        uint sourceAmount,
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings,
        address destinationAddress,
        bool virtualPynth
    )
        internal
        returns (
            uint amountReceived,
            uint fee,
            IVirtualPynth vPynth
        )
    {

        if (!_ensureCanExchange(sourceSettings.currencyKey, destinationSettings.currencyKey, sourceAmount)) {
            return (0, 0, IVirtualPynth(0));
        }


        // Using struct to resolve stack too deep error
        IExchanger.ExchangeEntry memory entry;
        ExchangeSettlementLib.ResolvedAddresses memory addrs = resolvedAddresses();

        entry.roundIdForSrc = addrs.exchangeRates.getCurrentRoundId(sourceSettings.currencyKey);
        entry.roundIdForDest = addrs.exchangeRates.getCurrentRoundId(destinationSettings.currencyKey);

        entry.sourceAmountAfterSettlement = _settleAndCalcSourceAmountRemaining(
            sourceAmount,
            from,
            sourceSettings.currencyKey
        );


        // If, after settlement the user has no balance left (highly unlikely), then return to prevent
        // emitting events of 0 and don't revert so as to ensure the settlement queue is emptied
        if (entry.sourceAmountAfterSettlement == 0) {
            return (0, 0, IVirtualPynth(0));
        }

        (entry.destinationAmount, entry.sourceRate, entry.destinationRate) = addrs
            .exchangeRates
            .effectiveValueAndRatesAtRound(
            sourceSettings.currencyKey,
            entry.sourceAmountAfterSettlement,
            destinationSettings.currencyKey,
            entry.roundIdForSrc,
            entry.roundIdForDest
        );

        // rates must also be good for the round we are doing
        _ensureCanExchangeAtRound(
            sourceSettings.currencyKey,
            destinationSettings.currencyKey,
            entry.roundIdForSrc,
            entry.roundIdForDest
        );

        bool tooVolatile;
        (entry.exchangeFeeRate, tooVolatile) = _feeRateForExchangeAtRounds(
            sourceSettings,
            destinationSettings,
            entry.roundIdForSrc,
            entry.roundIdForDest
        );


        if (tooVolatile) {
            // do not exchange if rates are too volatile, this to prevent charging
            // dynamic fees that are over the max value
            //require(false, "to do");
            return (0, 0, IVirtualPynth(0));
        }


        amountReceived = ExchangeSettlementLib._deductFeesFromAmount(entry.destinationAmount, entry.exchangeFeeRate);
        // Note: `fee` is denominated in the destinationCurrencyKey.
        fee = entry.destinationAmount.sub(amountReceived);

        // Note: We don't need to check their balance as the _convert() below will do a safe subtraction which requires
        // the subtraction to not overflow, which would happen if their balance is not sufficient.
        vPynth = _convert(
            sourceSettings.currencyKey,
            from,
            entry.sourceAmountAfterSettlement,
            destinationSettings.currencyKey,
            amountReceived,
            destinationAddress,
            virtualPynth
        );


        // When using a virtual pynth, it becomes the destinationAddress for event and settlement tracking
        if (vPynth != IVirtualPynth(0)) {
            destinationAddress = address(vPynth);
        }

        // Remit the fee if required
        if (fee > 0) {
            // Normalize fee to pUSD
            // Note: `fee` is being reused to avoid stack too deep errors.
            fee = addrs.exchangeRates.effectiveValue(destinationSettings.currencyKey, fee, pUSD);

            // Remit the fee in pUSDs
            issuer().pynths(pUSD).issue(feePool().FEE_ADDRESS(), fee);

            // Tell the fee pool about this
            feePool().recordFeePaid(fee);
        }

        // Note: As of this point, `fee` is denominated in pUSD.

        // Nothing changes as far as issuance data goes because the total value in the system hasn't changed.
        // But we will update the debt snapshot in case exchange rates have fluctuated since the last exchange
        // in these currencies
        _updatePERIIssuedDebtOnExchange(
            [sourceSettings.currencyKey, destinationSettings.currencyKey],
            [entry.sourceRate, entry.destinationRate]
        );

        // Let the DApps know there was a Pynth exchange
        IPeriFinanceInternal(address(periFinance())).emitPynthExchange(
            from,
            sourceSettings.currencyKey,
            entry.sourceAmountAfterSettlement,
            destinationSettings.currencyKey,
            amountReceived,
            destinationAddress
        );


       

        // iff the waiting period is gt 0
        if (getWaitingPeriodSecs() > 0) {
            // persist the exchange information for the dest key
            ExchangeSettlementLib.appendExchange(
                addrs,
                destinationAddress,
                sourceSettings.currencyKey,
                entry.sourceAmountAfterSettlement,
                destinationSettings.currencyKey,
                amountReceived,
                entry.exchangeFeeRate
            );
        }
    }

    function _convert(
        bytes32 sourceCurrencyKey,
        address from,
        uint sourceAmountAfterSettlement,
        bytes32 destinationCurrencyKey,
        uint amountReceived,
        address recipient,
        bool virtualPynth
    ) internal returns (IVirtualPynth vPynth) {
        // Burn the source amount

        issuer().pynths(sourceCurrencyKey).burn(from, sourceAmountAfterSettlement);

        // Issue their new pynths
        IPynth dest = issuer().pynths(destinationCurrencyKey);

        if (virtualPynth) {



            Proxyable pynth = Proxyable(address(dest));
            vPynth = _createVirtualPynth(IERC20(address(pynth.proxy())), recipient, amountReceived, destinationCurrencyKey);
            dest.issue(address(vPynth), amountReceived);
        } else {

            dest.issue(recipient, amountReceived);


        }
    }

    function _createVirtualPynth(
        IERC20,
        address,
        uint,
        bytes32
    ) internal returns (IVirtualPynth) {
        _notImplemented();
    }

    // Note: this function can intentionally be called by anyone on behalf of anyone else (the caller just pays the gas)
    function settle(address from, bytes32 currencyKey)
        external
        returns (
            uint reclaimed,
            uint refunded,
            uint numEntriesSettled
        )
    {
        systemStatus().requirePynthActive(currencyKey);
        return ExchangeSettlementLib.internalSettle(resolvedAddresses(), from, currencyKey, true, getWaitingPeriodSecs());
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    // gets the exchange parameters for a given direct integration (returns default params if no overrides exist)
    function _exchangeSettings(address from, bytes32 currencyKey)
        internal
        view
        returns (IDirectIntegrationManager.ParameterIntegrationSettings memory settings)
    {
        settings = directIntegrationManager().getExchangeParameters(from, currencyKey);
    }

    // runs basic checks and calls `rateWithSafetyChecks` (which can trigger circuit breakers)
    // returns if there are any problems found with the rate of the given currencyKey but not reverted
    function _ensureCanExchange(
        bytes32 sourceCurrencyKey,
        bytes32 destinationCurrencyKey,
        uint sourceAmount
    ) internal returns (bool) {
        require(sourceCurrencyKey != destinationCurrencyKey, "Can't be same pynth");
        require(sourceAmount > 0, "Zero amount");

        (, bool srcBroken, bool srcStaleOrInvalid) =
            sourceCurrencyKey != pUSD ? exchangeRates().rateWithSafetyChecks(sourceCurrencyKey) : (0, false, false);
        (, bool dstBroken, bool dstStaleOrInvalid) =
            destinationCurrencyKey != pUSD
                ? exchangeRates().rateWithSafetyChecks(destinationCurrencyKey)
                : (0, false, false);

        require(!srcStaleOrInvalid, "src rate stale or flagged");
        require(!dstStaleOrInvalid, "dest rate stale or flagged");

        return !srcBroken && !dstBroken;
    }

    // runs additional checks to verify a rate is valid at a specific round`
    function _ensureCanExchangeAtRound(
        bytes32 sourceCurrencyKey,
        bytes32 destinationCurrencyKey,
        uint roundIdForSrc,
        uint roundIdForDest
    ) internal view {
        require(sourceCurrencyKey != destinationCurrencyKey, "Can't be same pynth");

        bytes32[] memory pynthKeys = new bytes32[](2);
        pynthKeys[0] = sourceCurrencyKey;
        pynthKeys[1] = destinationCurrencyKey;

        uint[] memory roundIds = new uint[](2);
        roundIds[0] = roundIdForSrc;
        roundIds[1] = roundIdForDest;
        require(!exchangeRates().anyRateIsInvalidAtRound(pynthKeys, roundIds), "src/dest rate stale or flagged");
    }

    /* ========== Exchange Related Fees ========== */
    /// @notice public function to get the total fee rate for a given exchange
    /// @param sourceCurrencyKey The source currency key
    /// @param destinationCurrencyKey The destination currency key
    /// @return The exchange fee rate, and whether the rates are too volatile
    function feeRateForExchange(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey) external view returns (uint) {
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings =
            _exchangeSettings(msg.sender, sourceCurrencyKey);
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings =
            _exchangeSettings(msg.sender, destinationCurrencyKey);

        (uint feeRate, bool tooVolatile) = _feeRateForExchange(sourceSettings, destinationSettings);
        require(!tooVolatile, "too volatile");
        return feeRate;
    }

    /// @notice public function to get the dynamic fee rate for a given exchange
    /// @param sourceCurrencyKey The source currency key
    /// @param destinationCurrencyKey The destination currency key
    /// @return The exchange dynamic fee rate and if rates are too volatile
    function dynamicFeeRateForExchange(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey)
        external
        view
        returns (uint feeRate, bool tooVolatile)
    {
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings =
            _exchangeSettings(msg.sender, sourceCurrencyKey);
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings =
            _exchangeSettings(msg.sender, destinationCurrencyKey);

        return _dynamicFeeRateForExchange(sourceSettings, destinationSettings);
    }

    /// @notice Calculate the exchange fee for a given source and destination currency key
    /// @param sourceSettings The source currency key
    /// @param destinationSettings The destination currency key
    /// @return The exchange fee rate
    /// @return The exchange dynamic fee rate and if rates are too volatile
    function _feeRateForExchange(
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings,
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings
    ) internal view returns (uint feeRate, bool tooVolatile) {
        // Get the exchange fee rate as per the source currencyKey and destination currencyKey
        uint baseRate = sourceSettings.exchangeFeeRate.add(destinationSettings.exchangeFeeRate);
        uint dynamicFee;
        (dynamicFee, tooVolatile) = _dynamicFeeRateForExchange(sourceSettings, destinationSettings);
        return (baseRate.add(dynamicFee), tooVolatile);
    }

    /// @notice Calculate the exchange fee for a given source and destination currency key
    /// @param sourceSettings The source currency key
    /// @param destinationSettings The destination currency key
    /// @param roundIdForSrc The round id of the source currency.
    /// @param roundIdForDest The round id of the target currency.
    /// @return The exchange fee rate
    /// @return The exchange dynamic fee rate
    function _feeRateForExchangeAtRounds(
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings,
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings,
        uint roundIdForSrc,
        uint roundIdForDest
    ) internal view returns (uint feeRate, bool tooVolatile) {
        // Get the exchange fee rate as per the source currencyKey and destination currencyKey
        //uint baseRate = sourceSettings.exchangeFeeRate.add(destinationSettings.exchangeFeeRate);
        uint baseRate = _feeRateForExchange(sourceSettings.currencyKey, destinationSettings.currencyKey, sourceSettings.exchangeFeeRate, destinationSettings.exchangeFeeRate);
        uint dynamicFee;
        (dynamicFee, tooVolatile) = _dynamicFeeRateForExchangeAtRounds(
            sourceSettings,
            destinationSettings,
            roundIdForSrc,
            roundIdForDest
        );
        return (baseRate.add(dynamicFee), tooVolatile);
    }

    function _feeRateForExchange(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey, uint sourceFeeRate, uint destinationFeeRate)
        internal
        pure
        returns (uint exchangeFeeRate)
    {
        // Get the exchange fee rate as per destination currencyKey
        exchangeFeeRate = sourceFeeRate;

        if (sourceCurrencyKey == pUSD || destinationCurrencyKey == pUSD) {
            return exchangeFeeRate;
        }

        // Is this a swing trade? long to short or short to long skipping pUSD.
        if (
            (sourceCurrencyKey[0] == 0x70 && destinationCurrencyKey[0] == 0x69) ||
            (sourceCurrencyKey[0] == 0x69 && destinationCurrencyKey[0] == 0x70)
        ) {
            // Double the exchange fee
            //exchangeFeeRate = exchangeFeeRate.mul(2);
            exchangeFeeRate = exchangeFeeRate.add(destinationFeeRate);
        }

        return exchangeFeeRate;
    }

    function _dynamicFeeRateForExchange(
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings,
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings
    ) internal view returns (uint dynamicFee, bool tooVolatile) {
        (uint dynamicFeeDst, bool dstVolatile) = _dynamicFeeRateForCurrency(destinationSettings);
        (uint dynamicFeeSrc, bool srcVolatile) = _dynamicFeeRateForCurrency(sourceSettings);
        dynamicFee = dynamicFeeDst.add(dynamicFeeSrc);
        // cap to maxFee
        bool overMax = dynamicFee > sourceSettings.exchangeMaxDynamicFee;
        dynamicFee = overMax ? sourceSettings.exchangeMaxDynamicFee : dynamicFee;
        return (dynamicFee, overMax || dstVolatile || srcVolatile);
    }

    function _dynamicFeeRateForExchangeAtRounds(
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings,
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings,
        uint roundIdForSrc,
        uint roundIdForDest
    ) internal view returns (uint dynamicFee, bool tooVolatile) {
        (uint dynamicFeeDst, bool dstVolatile) = _dynamicFeeRateForCurrencyRound(destinationSettings, roundIdForDest);
        (uint dynamicFeeSrc, bool srcVolatile) = _dynamicFeeRateForCurrencyRound(sourceSettings, roundIdForSrc);
        dynamicFee = dynamicFeeDst.add(dynamicFeeSrc);
        // cap to maxFee
        bool overMax = dynamicFee > sourceSettings.exchangeMaxDynamicFee;
        dynamicFee = overMax ? sourceSettings.exchangeMaxDynamicFee : dynamicFee;
        return (dynamicFee, overMax || dstVolatile || srcVolatile);
    }

    /// @notice Get dynamic dynamicFee for a given currency key (SIP-184)
    /// @param settings The given currency key
    /// @return The dynamic fee and if it exceeds max dynamic fee set in config
    function _dynamicFeeRateForCurrency(IDirectIntegrationManager.ParameterIntegrationSettings memory settings)
        internal
        view
        returns (uint dynamicFee, bool tooVolatile)
    {
        // no dynamic dynamicFee for pUSD or too few rounds
        if (settings.currencyKey == pUSD || settings.exchangeDynamicFeeRounds <= 1) {
            return (0, false);
        }
        uint roundId = exchangeRates().getCurrentRoundId(settings.currencyKey);
        return _dynamicFeeRateForCurrencyRound(settings, roundId);
    }

    /// @notice Get dynamicFee for a given currency key (SIP-184)
    /// @param settings The given currency key
    /// @param roundId The round id
    /// @return The dynamic fee and if it exceeds max dynamic fee set in config
    function _dynamicFeeRateForCurrencyRound(
        IDirectIntegrationManager.ParameterIntegrationSettings memory settings,
        uint roundId
    ) internal view returns (uint dynamicFee, bool tooVolatile) {
        // no dynamic dynamicFee for pUSD or too few rounds
        if (settings.currencyKey == pUSD || settings.exchangeDynamicFeeRounds <= 1) {
            return (0, false);
        }
        uint[] memory prices;
        (prices, ) = exchangeRates().ratesAndUpdatedTimeForCurrencyLastNRounds(
            settings.currencyKey,
            settings.exchangeDynamicFeeRounds,
            roundId
        );
        dynamicFee = _dynamicFeeCalculation(
            prices,
            settings.exchangeDynamicFeeThreshold,
            settings.exchangeDynamicFeeWeightDecay
        );
        // cap to maxFee
        bool overMax = dynamicFee > settings.exchangeMaxDynamicFee;

        dynamicFee = overMax ? settings.exchangeMaxDynamicFee : dynamicFee;
        return (dynamicFee, overMax);
    }

    /// @notice Calculate dynamic fee according to SIP-184
    /// @param prices A list of prices from the current round to the previous rounds
    /// @param threshold A threshold to clip the price deviation ratop
    /// @param weightDecay A weight decay constant
    /// @return uint dynamic fee rate as decimal
    function _dynamicFeeCalculation(
        uint[] memory prices,
        uint threshold,
        uint weightDecay
    ) internal pure returns (uint) {
        // don't underflow
        if (prices.length == 0) {
            return 0;
        }

        uint dynamicFee = 0; // start with 0
        // go backwards in price array
        for (uint i = prices.length - 1; i > 0; i--) {
            // apply decay from previous round (will be 0 for first round)
            dynamicFee = dynamicFee.multiplyDecimal(weightDecay);
            // calculate price deviation
            uint deviation = _thresholdedAbsDeviationRatio(prices[i - 1], prices[i], threshold);
            // add to total fee
            dynamicFee = dynamicFee.add(deviation);
        }
        return dynamicFee;
    }

    /// absolute price deviation ratio used by dynamic fee calculation
    /// deviationRatio = (abs(current - previous) / previous) - threshold
    /// if negative, zero is returned
    function _thresholdedAbsDeviationRatio(
        uint price,
        uint previousPrice,
        uint threshold
    ) internal pure returns (uint) {
        if (previousPrice == 0) {
            return 0; // don't divide by zero
        }
        // abs difference between prices
        uint absDelta = price > previousPrice ? price - previousPrice : previousPrice - price;
        // relative to previous price
        uint deviationRatio = absDelta.divideDecimal(previousPrice);
        // only the positive difference from threshold
        return deviationRatio > threshold ? deviationRatio - threshold : 0;
    }

    function getAmountsForExchange(
        uint sourceAmount,
        bytes32 sourceCurrencyKey,
        bytes32 destinationCurrencyKey
    )
        external
        view
        returns (
            uint amountReceived,
            uint fee,
            uint exchangeFeeRate
        )
    {
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings =
            _exchangeSettings(msg.sender, sourceCurrencyKey);
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings =
            _exchangeSettings(msg.sender, destinationCurrencyKey);

        require(sourceCurrencyKey == pUSD || !exchangeRates().rateIsInvalid(sourceCurrencyKey), "src pynth rate invalid");

        require(
            destinationCurrencyKey == pUSD || !exchangeRates().rateIsInvalid(destinationCurrencyKey),
            "dest pynth rate invalid"
        );

        // The checks are added for consistency with the checks performed in _exchange()
        // The reverts (instead of no-op returns) are used order to prevent incorrect usage in calling contracts
        // (The no-op in _exchange() is in order to trigger system suspension if needed)

        // check pynths active
        systemStatus().requirePynthActive(sourceCurrencyKey);
        systemStatus().requirePynthActive(destinationCurrencyKey);

        bool tooVolatile;
        (exchangeFeeRate, tooVolatile) = _feeRateForExchange(sourceSettings, destinationSettings);

        // check rates volatility result
        require(!tooVolatile, "exchange rates too volatile");

        (uint destinationAmount, , ) =
            exchangeRates().effectiveValueAndRates(sourceCurrencyKey, sourceAmount, destinationCurrencyKey);

        amountReceived = ExchangeSettlementLib._deductFeesFromAmount(destinationAmount, exchangeFeeRate);
        fee = destinationAmount.sub(amountReceived);
    }

    function _notImplemented() internal pure {
        revert("Cannot be run on this layer");
    }

    // ========== MODIFIERS ==========

    modifier onlyPeriFinanceorPynth() {
        IPeriFinance _periFinance = periFinance();
        require(
            msg.sender == address(_periFinance) || issuer().pynthsByAddress(msg.sender) != bytes32(0),
            "Exchanger: Only periFinance or a pynth contract can perform this action"
        );
        _;
    }

    // ========== EVENTS ==========
    // note bot hof these events are actually emitted from `ExchangeSettlementLib`
    // but they are defined here for interface reasons
    event ExchangeEntryAppended(
        address indexed account,
        bytes32 src,
        uint256 amount,
        bytes32 dest,
        uint256 amountReceived,
        uint256 exchangeFeeRate,
        uint256 roundIdForSrc,
        uint256 roundIdForDest
    );

    event ExchangeEntrySettled(
        address indexed from,
        bytes32 src,
        uint256 amount,
        bytes32 dest,
        uint256 reclaim,
        uint256 rebate,
        uint256 srcRoundIdAtPeriodEnd,
        uint256 destRoundIdAtPeriodEnd,
        uint256 exchangeTimestamp
    );
}
