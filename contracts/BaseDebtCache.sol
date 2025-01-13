pragma solidity 0.5.16;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";
import "./interfaces/IDebtCache.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IIssuer.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/ICollateralManager.sol";
import "./interfaces/IFuturesMarketManager.sol";

// https://docs.peri.finance/contracts/source/contracts/debtcache
contract BaseDebtCache is Owned, MixinSystemSettings, IDebtCache {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    uint internal _cachedDebt;
    mapping(bytes32 => uint) internal _cachedPynthDebt;
    mapping(bytes32 => uint) internal _excludedIssuedDebt;
    uint internal _cacheTimestamp;
    bool internal _cacheInvalid = true;

       // flag to ensure importing excluded debt is invoked only once
    bool public isInitialized = false; // public to avoid needing an event

    /* ========== ENCODED NAMES ========== */

    bytes32 internal constant pUSD = "pUSD";
    bytes32 internal constant pETH = "pETH";

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_COLLATERALMANAGER = "CollateralManager";
    bytes32 private constant CONTRACT_FUTURESMARKETMANAGER = "FuturesMarketManager";


    constructor(address _owner, address _resolver) public Owned(_owner) MixinSystemSettings(_resolver) {}

    /* ========== VIEWS ========== */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](6);
        newAddresses[0] = CONTRACT_ISSUER;
        newAddresses[1] = CONTRACT_EXCHANGER;
        newAddresses[2] = CONTRACT_EXRATES;
        newAddresses[3] = CONTRACT_SYSTEMSTATUS;
        // newAddresses[4] = CONTRACT_ETHERCOLLATERAL;
        // newAddresses[5] = CONTRACT_ETHERCOLLATERAL_PUSD;
        newAddresses[4] = CONTRACT_COLLATERALMANAGER;
        newAddresses[5] = CONTRACT_FUTURESMARKETMANAGER;
        
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(requireAndGetAddress(CONTRACT_EXCHANGER));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(requireAndGetAddress(CONTRACT_SYSTEMSTATUS));
    }

    function collateralManager() internal view returns (ICollateralManager) {
        return ICollateralManager(requireAndGetAddress(CONTRACT_COLLATERALMANAGER));
    }

    function futuresMarketManager() internal view returns (IFuturesMarketManager) {
        return IFuturesMarketManager(requireAndGetAddress(CONTRACT_FUTURESMARKETMANAGER));
    }

    function debtSnapshotStaleTime() external view returns (uint) {
        return getDebtSnapshotStaleTime();
    }

    function cachedDebt() external view returns (uint) {
        return _cachedDebt;
    }

    function _excludedIssuedDebts(bytes32[] memory currencyKeys) internal view returns (uint[] memory) {
        uint numKeys = currencyKeys.length;
        uint[] memory debts = new uint[](numKeys);
        for (uint i = 0; i < numKeys; i++) {
            debts[i] = _excludedIssuedDebt[currencyKeys[i]];
        }
        return debts;
    }

    function excludedIssuedDebts(bytes32[] calldata currencyKeys) external view returns (uint[] memory excludedDebts) {
        return _excludedIssuedDebts(currencyKeys);
    }

    /// used when migrating to new DebtCache instance in order to import the excluded debt records
    /// If this method is not run after upgrading the contract, the debt will be
    /// incorrect w.r.t to wrapper factory assets until the values are imported from
    /// previous instance of the contract
    /// Also, in addition to this method it's possible to use recordExcludedDebtChange since
    /// it's accessible to owner in case additional adjustments are required
    function importExcludedIssuedDebts(IDebtCache prevDebtCache, IIssuer prevIssuer) external onlyOwner {
        // this can only be run once so that recorded debt deltas aren't accidentally
        // lost or double counted
        require(!isInitialized, "already initialized");
        isInitialized = true;

        // get the currency keys from **previous** issuer, in case current issuer
        // doesn't have all the pynths at this point
        // warning: if a pynth won't be added to the current issuer before the next upgrade of this contract,
        // its entry will be lost (because it won't be in the prevIssuer for next time).
        // if for some reason this is a problem, it should be possible to use recordExcludedDebtChange() to amend
        bytes32[] memory keys = prevIssuer.availableCurrencyKeys();

        require(keys.length > 0, "previous Issuer has no pynths");

        // query for previous debt records
        uint[] memory debts = prevDebtCache.excludedIssuedDebts(keys);

        // store the values
        for (uint i = 0; i < keys.length; i++) {
            if (debts[i] > 0) {
                // adding the values instead of overwriting in case some deltas were recorded in this
                // contract already (e.g. if the upgrade was not atomic)
                _excludedIssuedDebt[keys[i]] = _excludedIssuedDebt[keys[i]].add(debts[i]);
            }
        }
    }

    function cachedPynthDebt(bytes32 currencyKey) external view returns (uint) {
        return _cachedPynthDebt[currencyKey];
    }

    function cacheTimestamp() external view returns (uint) {
        return _cacheTimestamp;
    }

    function cacheInvalid() external view returns (bool) {
        return _cacheInvalid;
    }

    function _cacheStale(uint timestamp) internal view returns (bool) {
        // Note a 0 timestamp means that the cache is uninitialised.
        // We'll keep the check explicitly in case the stale time is
        // ever set to something higher than the current unix time (e.g. to turn off staleness).
        return getDebtSnapshotStaleTime() < block.timestamp - timestamp || timestamp == 0;
    }

    function cacheStale() external view returns (bool) {
        return _cacheStale(_cacheTimestamp);
    }

    function _issuedPynthValues(bytes32[] memory currencyKeys, uint[] memory rates) internal view returns (uint[] memory) {
        uint numValues = currencyKeys.length;
        uint[] memory values = new uint[](numValues);
        IPynth[] memory pynths = issuer().getPynths(currencyKeys);

        for (uint i = 0; i < numValues; i++) {
            address pynthAddress = address(pynths[i]);
            require(pynthAddress != address(0), "Pynth does not exist");
            uint supply = IERC20(pynthAddress).totalSupply();
            uint value = supply.multiplyDecimalRound(rates[i]);
            // uint multiplier = (pynths[i].currencyKey() != sUSD) ? discountRate : SafeDecimalMath.unit();

            // if (collateralManager().isPynthManaged(key)) {
            //     uint collateralIssued = collateralManager().long(key);
            //     // this is an edge case --
            //     // if a pynth other than pUSD is only issued by non PERI collateral
            //     // the long value will exceed the supply if there was a minting fee,
            //     // so we check explicitly and 0 it out to prevent
            //     // a safesub overflow.

            //     if (collateralIssued > supply) {
            //         supply = 0;
            //     } else {
            //         supply = supply.sub(collateralIssued);
            //     }
            // }

            values[i] = supply.multiplyDecimalRound(rates[i]);
        }

        return (values);
    }

    function _currentPynthDebts(bytes32[] memory currencyKeys)
        internal
        view
        returns (uint[] memory periIssuedDebts,
            uint _futuresDebt,
            uint _excludedDebt,
            bool anyRateIsInvalid)
    {
        (uint[] memory rates, bool isInvalid) = exchangeRates().ratesAndInvalidForCurrencies(currencyKeys);
           uint[] memory values = _issuedPynthValues(currencyKeys, rates);
        (uint excludedDebt, bool isAnyNonPeriDebtRateInvalid) = _totalNonPeriBackedDebt(currencyKeys, rates, isInvalid);
        (uint futuresDebt, bool futuresDebtIsInvalid) = futuresMarketManager().totalDebt();

        return (values, futuresDebt, excludedDebt, isInvalid || futuresDebtIsInvalid || isAnyNonPeriDebtRateInvalid);
    }

    function currentPynthDebts(bytes32[] calldata currencyKeys)
        external
        view
        returns (uint[] memory debtValues,
            uint futuresDebt,
            uint excludedDebt, 
            bool anyRateIsInvalid)
    {
        return _currentPynthDebts(currencyKeys);
    }

    function _cachedPynthDebts(bytes32[] memory currencyKeys) internal view returns (uint[] memory) {
        uint numKeys = currencyKeys.length;
        uint[] memory debts = new uint[](numKeys);
        for (uint i = 0; i < numKeys; i++) {
            debts[i] = _cachedPynthDebt[currencyKeys[i]];
        }
        return debts;
    }

    function cachedPynthDebts(bytes32[] calldata currencyKeys) external view returns (uint[] memory periIssuedDebts) {
        return _cachedPynthDebts(currencyKeys);
    }


    // Returns the total pUSD debt backed by non-PERI collateral.
    function totalNonPeriBackedDebt() external view returns (uint excludedDebt, bool isInvalid) {
        bytes32[] memory currencyKeys = issuer().availableCurrencyKeys();
        (uint[] memory rates, bool ratesAreInvalid) = exchangeRates().ratesAndInvalidForCurrencies(currencyKeys);

        return _totalNonPeriBackedDebt(currencyKeys, rates, ratesAreInvalid);
    }

    function _totalNonPeriBackedDebt(
        bytes32[] memory currencyKeys,
        uint[] memory rates,
        bool ratesAreInvalid
    ) internal view returns (uint excludedDebt, bool isInvalid) {
        // Calculate excluded debt.
        // 1. MultiCollateral long debt + short debt.
        (uint longValue, bool anyTotalLongRateIsInvalid) = collateralManager().totalLong();
        (uint shortValue, bool anyTotalShortRateIsInvalid) = collateralManager().totalShort();
        isInvalid = ratesAreInvalid || anyTotalLongRateIsInvalid || anyTotalShortRateIsInvalid;
        excludedDebt = longValue.add(shortValue);

    
        // 3. WrapperFactory.
        // Get the debt issued by the Wrappers.
        for (uint i = 0; i < currencyKeys.length; i++) {
            excludedDebt = excludedDebt.add(_excludedIssuedDebt[currencyKeys[i]].multiplyDecimalRound(rates[i]));
        }

        return (excludedDebt, isInvalid);
    }


    function _currentDebt() internal view returns (uint debt, bool anyRateIsInvalid) {
       bytes32[] memory currencyKeys = issuer().availableCurrencyKeys();
        (uint[] memory rates, bool isInvalid) = exchangeRates().ratesAndInvalidForCurrencies(currencyKeys);

        // Sum all issued pynth values based on their supply.
        uint[] memory values = _issuedPynthValues(currencyKeys, rates);
        (uint excludedDebt, bool isAnyNonPeriDebtRateInvalid) = _totalNonPeriBackedDebt(currencyKeys, rates, isInvalid);

        uint numValues = values.length;
        uint total;
        for (uint i; i < numValues; i++) {
            total = total.add(values[i]);
        }

        // Add in the debt accounted for by futures
        (uint futuresDebt, bool futuresDebtIsInvalid) = futuresMarketManager().totalDebt();
        total = total.add(futuresDebt);

        // Ensure that if the excluded non-SNX debt exceeds SNX-backed debt, no overflow occurs
        total = total < excludedDebt ? 0 : total.sub(excludedDebt);

        return (total, isInvalid || futuresDebtIsInvalid || isAnyNonPeriDebtRateInvalid);
    }

    function currentDebt() external view returns (uint debt, bool anyRateIsInvalid) {
        return _currentDebt();
    }

    function cacheInfo()
        external
        view
        returns (
            uint debt,
            uint timestamp,
            bool isInvalid,
            bool isStale
        )
    {
        uint time = _cacheTimestamp;
        return (_cachedDebt, time, _cacheInvalid, _cacheStale(time));
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    // Stub out all mutative functions as no-ops;
    // since they do nothing, there are no restrictions

    function updateCachedPynthDebts(bytes32[] calldata currencyKeys) external {}

    function updateCachedPynthDebtWithRate(bytes32 currencyKey, uint currencyRate) external {}

    function updateCachedPynthDebtsWithRates(bytes32[] calldata currencyKeys, uint[] calldata currencyRates) external {}

    function updateDebtCacheValidity(bool currentlyInvalid) external {}

    function purgeCachedPynthDebt(bytes32 currencyKey) external {}

    function takeDebtSnapshot() external {}

    function updateCachedpUSDDebt(int amount) external {}

    /* ========== MODIFIERS ========== */

    function _requireSystemActiveIfNotOwner() internal view {
        if (msg.sender != owner) {
            systemStatus().requireSystemActive();
        }
    }

    modifier requireSystemActiveIfNotOwner() {
        _requireSystemActiveIfNotOwner();
        _;
    }

    function _onlyIssuerOrExchangerorPynthpUSD() internal view {
        IPynth pynthpUSD = issuer().pynths(pUSD);
        require(
           msg.sender == address(issuer()) || msg.sender == address(exchanger()) || msg.sender == address(pynthpUSD),
           "Sender is not Issuer or Exchanger or pynthpUSD"
        );
    }

    modifier onlyIssuerOrExchangerOrPynthpUSD() {
        _onlyIssuerOrExchangerorPynthpUSD();
        _;
    }

    function _onlyIssuer() internal view {
        require(msg.sender == address(issuer()), "Sender is not Issuer");
    }

    modifier onlyIssuer() {
        _onlyIssuer();
        _;
    }

    function _onlyIssuerOrExchanger() internal view {
        require(msg.sender == address(issuer()) || msg.sender == address(exchanger()), "Sender is not Issuer or Exchanger");
    }

    modifier onlyIssuerOrExchanger() {
        _onlyIssuerOrExchanger();
        _;
    }
}
