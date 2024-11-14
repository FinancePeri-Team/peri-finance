pragma solidity >=0.4.24;

import "../interfaces/IPynth.sol";

interface IIssuer {
    // Views

    function allNetworksDebtInfo()
        external
        view
        returns (
            uint256 debt,
            uint256 sharesSupply,
            bool isStale
        );

    function anyPynthOrPERIRateIsInvalid() external view returns (bool anyRateInvalid);

    function availableCurrencyKeys() external view returns (bytes32[] memory);

    function availablePynthCount() external view returns (uint);

    function availablePynths(uint index) external view returns (IPynth);

    function canBurnPynths(address account) external view returns (bool);

    function collateral(address account) external view returns (uint);

    function collateralisationRatio(address issuer) external view returns (uint);

    function collateralisationRatioAndAnyRatesInvalid(address _issuer)
        external
        view
        returns (uint cratio, bool anyRateIsInvalid);

    function debtBalanceOf(address issuer, bytes32 currencyKey) external view returns (uint debtBalance);

    function issuanceRatio() external view returns (uint);

    function lastIssueEvent(address account) external view returns (uint);

    function maxIssuablePynths(address issuer) external view returns (uint maxIssuable);

    function minimumStakeTime() external view returns (uint);

    function remainingIssuablePynths(address issuer)
        external
        view
        returns (
            uint maxIssuable,
            uint alreadyIssued,
            uint totalSystemDebt
        );

    function pynths(bytes32 currencyKey) external view returns (IPynth);

    function getPynths(bytes32[] calldata currencyKeys) external view returns (IPynth[] memory);

    function pynthsByAddress(address pynthAddress) external view returns (bytes32);

    function totalIssuedPynths(bytes32 currencyKey, bool excludeEtherCollateral) external view returns (uint);

    function transferablePeriFinanceAndAnyRateIsInvalid(address account, uint balance)
        external
        view
        returns (uint transferable, bool anyRateIsInvalid);

    function liquidationAmounts(address account, bool isSelfLiquidation)
        external
        view
        returns (
            uint totalRedeemed,
            uint debtToRemove,
            uint escrowToLiquidate,
            uint initialDebtBalance
        );

    // Restricted: used internally to PERIFinance
    function addPynths(IPynth[] calldata pynthsToAdd) external;

    function issuePynths(address from, uint amount) external;

    function issuePynthsOnBehalf(
        address issueFor,
        address from,
        uint amount
    ) external;

    function issueMaxPynths(address _issuer) external;

    function issueMaxPynthsOnBehalf(address issueFor, address from) external;


    //function issuePynthsToMaxQuota(address _issuer, bytes32 _currencyKey) external;

    function burnPynths(address from, uint amount) external;

    function burnPynthsOnBehalf(
        address burnForAddress,
        address from,
        uint amount
    ) external;

    function burnPynthsToTarget(address from) external;

    function burnPynthsToTargetOnBehalf(address burnForAddress, address from) external;

    function burnForRedemption(
        address deprecatedPynthProxy,
        address account,
        uint balance
    ) external;

    // function liquidateDelinquentAccount(
    //     address account,
    //     uint pusdAmount,
    //     address liquidator
    // ) external returns (uint totalRedeemed, uint amountToLiquidate);

    function setCurrentPeriodId(uint128 periodId) external;

    function liquidateAccount(address account, bool isSelfLiquidation)
        external
        returns (
            uint totalRedeemed,
            uint debtRemoved,
            uint escrowToLiquidate
        );
    function getRatios(address _account, bool _checkRate)
        external
        view
        returns (
            uint,
            uint,
            uint,
            uint,
            uint,
            uint
        );

    function getTargetRatio(address account) external view returns (uint);

    function issuePynthsWithoutDebt(
        bytes32 currencyKey,
        address to,
        uint amount
    ) external returns (bool rateInvalid);

    function burnPynthsWithoutDebt(
        bytes32 currencyKey,
        address to,
        uint amount
    ) external returns (bool rateInvalid);

    function burnAndIssuePynthsWithoutDebtCache(
        address account,
        bytes32 currencyKey,
        uint amountOfPynth,
        uint amountInpUSD
    ) external;

    function modifyDebtSharesForMigration(address account, uint amount) external;
}
