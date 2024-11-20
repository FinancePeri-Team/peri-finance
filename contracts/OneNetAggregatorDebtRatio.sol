pragma solidity ^0.5.16;

import "./BaseOneNetAggregator.sol";
import "./interfaces/IPeriFinanceDebtShare.sol";

contract OneNetAggregatorDebtRatio is BaseOneNetAggregator {
    bytes32 public constant CONTRACT_NAME = "OneNetAggregatorDebtRatio";
    constructor(AddressResolver _resolver) public BaseOneNetAggregator(_resolver) {}

    function getRoundData(uint80)
        public
        view
        returns (
            uint80,
            int256,
            uint256,
            uint256,
            uint80
        )
    {
        uint totalIssuedPynths =
            IIssuer(resolver.requireAndGetAddress("Issuer", "aggregate debt info")).totalIssuedPynths("pUSD", true);
        uint totalDebtShares = 
            IPeriFinanceDebtShare(resolver.requireAndGetAddress("PeriFinanceDebtShare", "aggregate debt info")).totalSupply();

        uint result =
            totalDebtShares == 0 ? 10**27 : totalIssuedPynths.decimalToPreciseDecimal().divideDecimalRound(totalDebtShares);

        uint dataTimestamp = now;

        if (overrideTimestamp != 0) {
            dataTimestamp = overrideTimestamp;
        }

        return (1, int256(result), dataTimestamp, dataTimestamp, 1);
    }
}
