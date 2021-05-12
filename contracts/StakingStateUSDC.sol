pragma solidity ^0.5.16;

import "./SafeDecimalMath.sol";
import "./State.sol";
import "./Owned.sol";

contract StakingStateUSDC is Owned, State {

  using SafeMath for uint;
  using SafeDecimalMath for uint;

  mapping(address => uint) public stakedAmountOf;

  uint public totalStakerCount;

  uint public totalStakedAmount;

  event Staking(address indexed account, uint amount, uint percentage);

  event Unstaking(address indexed account, uint amount, uint percentage);  

  constructor(address _owner, address _associatedContract) 
  Owned(_owner) 
  State(_associatedContract) 
  public {
  }

  function stake(address _account, uint _amount)
  external
  onlyAssociatedContract {
    if(stakedAmountOf[_account] <= 0) {
      _incrementTotalStaker();
    }
    
    stakedAmountOf[_account] = stakedAmountOf[_account].add(_amount);
    totalStakedAmount = totalStakedAmount.add(_amount);

    emit Staking(_account, _amount, userStakingShare(_account));
  }

  function unstake(address _account, uint _amount)
  external
  onlyAssociatedContract {
    require(stakedAmountOf[_account] >= _amount,
      "User doesn't have enough staked amount");
    require(totalStakedAmount >= _amount,
      "Not enough staked amount to withdraw");

    if(stakedAmountOf[_account].sub(_amount) == 0) {
      _decrementTotalStaker();
    }

    stakedAmountOf[_account] = stakedAmountOf[_account].sub(_amount);
    totalStakedAmount = totalStakedAmount.sub(_amount);

    emit Unstaking(_account, _amount, userStakingShare(_account));
  }

  function userStakingShare(address _account)
  public view 
  returns(uint) {
    uint _percentage = stakedAmountOf[_account] == 0 || totalStakedAmount == 0 ? 
      0 : (stakedAmountOf[_account].mul(10**12)).multiplyDecimalRound(totalStakedAmount.mul(10**12));

    return _percentage;
  }

  function decimals()
  external view
  returns(uint8) {
    return 6;
  }

  function hasStaked(address _account)
  external view
  returns(bool) {
    return stakedAmountOf[_account] > 0;
  }
  
  function _incrementTotalStaker()
  internal {
    totalStakerCount = totalStakerCount.add(1);
  }

  function _decrementTotalStaker()
  internal {
    totalStakerCount = totalStakerCount.sub(1);
  }
  
}