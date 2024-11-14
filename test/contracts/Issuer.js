'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupAllContracts, mockToken } = require('./setup');

const MockEtherCollateral = artifacts.require('MockEtherCollateral');

const MockEtherWrapper = artifacts.require('MockEtherWrapper');
const MockAggregator = artifacts.require('MockAggregatorV2V3');

const {
	currentTime,
	multiplyDecimal,
	divideDecimal,
	toUnit,
	fromUnit,
	toPreciseUnit,
	// fromPreciseUnit,
	// preciseUnitToUnit,
	divideDecimalRound,
	multiplyDecimalRoundPrecise,
	divideDecimalRoundPrecise,
	to3Unit,
	fastForward,
} = require('../utils')();

const {
	setExchangeWaitingPeriod,
	setExchangeFeeRateForPynths,
	getDecodedLogs,
	decodedEventEqual,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
	defaults: { ISSUANCE_RATIO, MINIMUM_STAKE_TIME },
} = require('../..');

contract('Issuer via PeriFinance', async accounts => {
	const WEEK = 604800;

	const [pUSD, pETH, PERI, pAUD, pEUR, USDC, DAI, PAXG, ETH] = ['pUSD', 'pETH', 'PERI', 'pAUD', 'pEUR', 'USDC', 'DAI', 'PAXG', 'ETH'].map(
		toBytes32
	);
	const pynthKeys = [pUSD, pETH];

	const [
		,
		owner,
		account1,
		account2,
		account3,
		account6,
		account7,
		periFinanceBridgeToOptimism,
		dynamicPynthRedeemer,
	] = accounts;

	let periFinance,
		exchangeRates,
		periFinanceProxy,
		periFinanceState,
		feePool,
		// delegateApprovals,
		systemStatus,
		systemSettings,
		delegateApprovals,
		pUSDContract,
		pETHContract,
		pEURContract,
		pAUDContract,
		escrow,
		rewardEscrowV2,
		debtCache,
		issuer,
		pynths,
		addressResolver,
		pynthRedeemer,
		exchanger,
		aggregatorDebtRatio,
		aggregatorIssuedPynths,
		circuitBreaker,
		stakingState,
		exTokenManager,
		usdc,
		dai,
		paxg,
		stables,
		debtShares;

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async () => {	
		pynths = ['pUSD', 'pETH', 'pEUR', 'pAUD'];
		stables = ['USDC', 'DAI', 'PAXG'];
		({
			PeriFinance: periFinance,
			PeriFinanceState: periFinanceState,
			ProxyERC20PeriFinance: periFinanceProxy,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			ExchangeRates: exchangeRates,
			PeriFinanceEscrow: escrow,
			RewardEscrowV2: rewardEscrowV2,
			PynthpUSD: pUSDContract,
			PynthpETH: pETHContract,
			PynthpAUD: pAUDContract,
			PynthpEUR: pEURContract,
			Exchanger: exchanger,
			FeePool: feePool,
			DebtCache: debtCache,
			Issuer: issuer,
			DelegateApprovals: delegateApprovals,
			AddressResolver: addressResolver,
			PynthRedeemer: pynthRedeemer,
			PeriFinanceDebtShare: debtShares,
			CircuitBreaker: circuitBreaker,
			'ext:AggregatorDebtRatio': aggregatorDebtRatio,
			'ext:AggregatorIssuedPynths': aggregatorIssuedPynths,
		} = await setupAllContracts({
			accounts,
			pynths,
			contracts: [
				'PeriFinance',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage',
				'AddressResolver',
				'RewardEscrowV2',
				'PeriFinanceEscrow',
				'SystemSettings',
				'Issuer',
				// 'LiquidatorRewards',
				'OneNetAggregatorIssuedPynths',
				'OneNetAggregatorDebtRatio',
				'DebtCache',
				'Exchanger', // necessary for burnPynths to check settlement of pUSD
				'DelegateApprovals', // necessary for *OnBehalf functions
				'FlexibleStorage',
				'CollateralManager',
				'FeePoolState',
				'StakingState',
				'CrossChainManager',
				'PynthRedeemer',
				//'PeriFinanceDebtShare',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		periFinance = await artifacts.require('PeriFinance').at(periFinanceProxy.address);

		// mocks for bridge
		await addressResolver.importAddresses(
			['PeriFinanceBridgeToOptimism', 'DynamicPynthRedeemer'].map(toBytes32),
			[periFinanceBridgeToOptimism, dynamicPynthRedeemer],
			{ from: owner }
		);

		await setupPriceAggregators(exchangeRates, owner, [pAUD, pEUR, pETH, ETH]);
	});

	async function updateDebtMonitors() {
		await debtCache.takeDebtSnapshot();
		await circuitBreaker.resetLastValue(
			[aggregatorIssuedPynths.address, aggregatorDebtRatio.address],
			[
				(await aggregatorIssuedPynths.latestRoundData())[1],
				(await aggregatorDebtRatio.latestRoundData())[1],
			],
			{ from: owner }
		);
	}

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[pAUD, pEUR, PERI, pETH],
			['0.5', '1.25', '0.1', '200'].map(toUnit)
		);

		// set a 0.3% default exchange fee rate
		const exchangeFeeRate = toUnit('0.003');
		await setExchangeFeeRateForPynths({
			owner,
			systemSettings,
			pynthKeys,
			exchangeFeeRates: pynthKeys.map(() => exchangeFeeRate),
		});
		await updateDebtMonitors();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: issuer.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'addPynth',
				'addPynths',
				'burnForRedemption',
				'burnPynths',
				'burnPynthsOnBehalf',
				'burnPynthsToTarget',
				'burnPynthsToTargetOnBehalf',
				'issuePynthsWithoutDebt',
				'burnPynthsWithoutDebt',
				'burnAndIssuePynthsWithoutDebtCache',
				'issueMaxPynths',
				'issueMaxPynthsOnBehalf',
				'issuePynths',
				'issuePynthsOnBehalf',
				'liquidateAccount',
				'modifyDebtSharesForMigration',
				'removePynth',
				'removePynths',
				'setCurrentPeriodId',
			],
		});
	});

	it('minimum stake time is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.minimumStakeTime(), MINIMUM_STAKE_TIME);
	});

	it('issuance ratio is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.issuanceRatio(), ISSUANCE_RATIO);
	});

	describe('protected methods', () => {
		it('issuePynthsWithoutDebt() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issuePynthsWithoutDebt,
				args: [pUSD, owner, toUnit(100)],
				accounts,
				address: periFinanceBridgeToOptimism,
				reason: 'only trusted minters',
			});
		});

		it('burnPynthsWithoutDebt() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnPynthsWithoutDebt,
				args: [pUSD, owner, toUnit(100)],
				// full functionality of this method requires issuing pynths,
				// so just test that its blocked here and don't include the trusted addr
				accounts: [owner, account1],
				reason: 'only trusted minters',
			});
		});

		it('burnAndIssuePynthsWithoutDebtCache() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnAndIssuePynthsWithoutDebtCache,
				args: [account7, pETH, toUnit(1), toUnit(100)],
				// full functionality of this method requires issuing pynths,
				// so just test that its blocked here and don't include the trusted addr
				accounts: [owner, account1],
				reason: 'Only PynthRedeemer',
			});
		});

		it('modifyDebtSharesForMigration() cannont be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.modifyDebtSharesForMigration,
				args: [account1, toUnit(100)],
				accounts,
				reason: 'only trusted migrators',
			});
		});

		it('issuePynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issuePynths,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('issuePynthsOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issuePynthsOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('issueMaxPynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxPynths,
				args: [account1],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('issueMaxPynthsOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxPynthsOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('burnPynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnPynths,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('burnPynthsOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnPynthsOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('burnPynthsToTarget() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnPynthsToTarget,
				args: [account1],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('liquidateAccount() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.liquidateAccount,
				args: [account1, false],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('burnPynthsToTargetOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnPynthsToTargetOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only PeriFinance',
			});
		});
		it('setCurrentPeriodId() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.setCurrentPeriodId,
				args: [1234],
				accounts,
				reason: 'Must be fee pool',
			});
		});
	});

	describe('when minimum stake time is set to 0', () => {
		beforeEach(async () => {
			// set minimumStakeTime on issue and burning to 0
			await systemSettings.setMinimumStakeTime(0, { from: owner });
		});
		describe('when the issuanceRatio is 0.2', () => {
			beforeEach(async () => {
				// set default issuance ratio of 0.2
				await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
			});

			describe('minimumStakeTime - recording last issue and burn timestamp', async () => {
				let now;

				beforeEach(async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('1000'), { from: owner });

					now = await currentTime();
				});

				it('should issue pynths and store issue timestamp after now', async () => {
					// issue pynths
					await periFinance.issuePynths(web3.utils.toBN('5'), { from: account1 });

					// issue timestamp should be greater than now in future
					const issueTimestamp = await issuer.lastIssueEvent(owner);
					assert.ok(issueTimestamp.gte(now));
				});

				describe('require wait time on next burn pynth after minting', async () => {
					it('should revert when burning any pynths within minStakeTime', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(60 * 60 * 8, { from: owner });

						// issue pynths first
						await periFinance.issuePynths(web3.utils.toBN('5'), { from: account1 });

						await assert.revert(
							periFinance.burnPynths(web3.utils.toBN('5'), { from: account1 }),
							'Minimum stake time not reached'
						);
					});
					it('should set minStakeTime to 120 seconds and able to burn after wait time', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(120, { from: owner });

						// issue pynths first
						await periFinance.issuePynths(toUnit('0.001'), { from: account1 });

						// fastForward 30 seconds
						await fastForward(10);

						await assert.revert(
							periFinance.burnPynths(toUnit('0.001'), { from: account1 }),
							'Minimum stake time not reached'
						);

						// fastForward 115 seconds
						await fastForward(125);

						// burn pynths
						await periFinance.burnPynths(toUnit('0.001'), { from: account1 });
					});
				});
			});

			describe('allNetworksDebtInfo()', () => {
				describe('when exchange rates set', () => {
					beforeEach(async () => {
						await fastForward(10);
						// Send a price update to give the pynth rates

						await updateAggregatorRates(
							exchangeRates,
							circuitBreaker,
							[pAUD, pEUR, pETH, ETH, PERI],
							['0.5', '1.25', '100', '100', '2'].map(toUnit)
						);
					});

					describe('when numerous issues in many currencies', () => {
						beforeEach(async () => {
							// as our pynths are mocks, let's issue some amount to users
							await pUSDContract.issue(account1, toUnit('1000'));

							await pAUDContract.issue(account1, toUnit('1000')); // 500 pUSD worth
							await pAUDContract.issue(account2, toUnit('1000')); // 500 pUSD worth

							await pEURContract.issue(account3, toUnit('80')); // 100 pUSD worth

							await pETHContract.issue(account1, toUnit('1')); // 100 pUSD worth

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then should have recorded debt and debt shares even though there are none', async () => {
							const debtInfo = await issuer.allNetworksDebtInfo();

							assert.bnEqual(debtInfo.debt, toUnit('2200'));
							assert.bnEqual(debtInfo.sharesSupply, toUnit('2200')); // stays 0 if no debt shares are minted
							assert.isFalse(debtInfo.isStale);
						});
					});

					describe('when issued through PERI staking', () => {
						beforeEach(async () => {
							// as our pynths are mocks, let's issue some amount to users
							const issuedPeriFinances = web3.utils.toBN('200012');
							await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
								from: owner,
							});

							// Issue
							const amountIssued = toUnit('2011');
							await periFinance.issuePynths(amountIssued, { from: account1 });
							await updateDebtMonitors();
						});
						it('then should have recorded debt and debt shares', async () => {
							const debtInfo = await issuer.allNetworksDebtInfo();

							assert.bnEqual(debtInfo.debt, toUnit('2011'));
							assert.bnEqual(debtInfo.sharesSupply, toUnit('2011'));
							assert.isFalse(debtInfo.isStale);
						});
					});

					describe('when oracle updatedAt is old', () => {
						beforeEach(async () => {
							// as our pynths are mocks, let's issue some amount to users
							const issuedPeriFinances = web3.utils.toBN('200012');
							await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
								from: owner,
							});

							// Issue
							const amountIssued = toUnit('2011');
							await periFinance.issuePynths(amountIssued, { from: account1 });
							await updateDebtMonitors();

							await aggregatorDebtRatio.setOverrideTimestamp(500); // really old timestamp
						});
						it('then isStale = true', async () => {
							assert.isTrue((await issuer.allNetworksDebtInfo()).isStale);
						});
					});
				});
			});

			describe('totalIssuedPynths()', () => {
				describe('when exchange rates set', () => {
					beforeEach(async () => {
						await fastForward(10);
						// Send a price update to give the pynth rates
						await updateAggregatorRates(
							exchangeRates,
							circuitBreaker,
							[pAUD, pEUR, pETH, ETH, PERI],
							['0.5', '1.25', '100', '100', '2'].map(toUnit)
						);
						await updateDebtMonitors();
					});

					describe('when numerous issues in one currency', () => {
						beforeEach(async () => {
							// as our pynths are mocks, let's issue some amount to users
							await pUSDContract.issue(account1, toUnit('1000'));
							await pUSDContract.issue(account2, toUnit('100'));
							await pUSDContract.issue(account3, toUnit('10'));
							await pUSDContract.issue(account1, toUnit('1'));

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then totalIssuedPynths in should correctly calculate the total issued pynths in pUSD', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('1111'));
						});
						it('and in another pynth currency', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(pAUD), toUnit('2222'));
						});
						it('and in PERI', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(PERI), divideDecimal('1111', '2'));
						});
						it('and in a non-pynth currency', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(ETH), divideDecimal('1111', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								periFinance.totalIssuedPynths(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});

					describe('when numerous issues in many currencies', () => {
						beforeEach(async () => {
							// as our pynths are mocks, let's issue some amount to users
							await pUSDContract.issue(account1, toUnit('1000'));

							await pAUDContract.issue(account1, toUnit('1000')); // 500 pUSD worth
							await pAUDContract.issue(account2, toUnit('1000')); // 500 pUSD worth

							await pEURContract.issue(account3, toUnit('80')); // 100 pUSD worth

							await pETHContract.issue(account1, toUnit('1')); // 100 pUSD worth

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then totalIssuedPynths in should correctly calculate the total issued pynths in pUSD', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('2200'));
						});
						it('and in another pynth currency', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(pAUD), toUnit('4400', '2'));
						});
						it('and in PERI', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(PERI), divideDecimal('2200', '2'));
						});
						it('and in a non-pynth currency', async () => {
							assert.bnEqual(await periFinance.totalIssuedPynths(ETH), divideDecimal('2200', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								periFinance.totalIssuedPynths(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});
				});
			});

			describe('debtBalance()', () => {
				it('should not change debt balance % if exchange rates change', async () => {
					let newAUDRate = toUnit('0.5');
					await updateAggregatorRates(exchangeRates, circuitBreaker, [pAUD], [newAUDRate]);
					await updateDebtMonitors();

					await periFinance.transfer(account1, toUnit('20000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('20000'), {
						from: owner,
					});

					const amountIssuedAcc1 = toUnit('30');
					const amountIssuedAcc2 = toUnit('50');
					await periFinance.issuePynths(amountIssuedAcc1, { from: account1 });
					await periFinance.issuePynths(amountIssuedAcc2, { from: account2 });

					await periFinance.exchange(pUSD, amountIssuedAcc2, pAUD, { from: account2 });

					const PRECISE_UNIT = web3.utils.toWei(web3.utils.toBN('1'), 'gether');
					let totalIssuedPynthpUSD = await periFinance.totalIssuedPynths(pUSD);
					const account1DebtRatio = divideDecimal(
						amountIssuedAcc1,
						totalIssuedPynthpUSD,
						PRECISE_UNIT
					);
					const account2DebtRatio = divideDecimal(
						amountIssuedAcc2,
						totalIssuedPynthpUSD,
						PRECISE_UNIT
					);

					newAUDRate = toUnit('1.85');
					await updateAggregatorRates(exchangeRates, circuitBreaker, [pAUD], [newAUDRate]);
					await updateDebtMonitors();

					totalIssuedPynthpUSD = await periFinance.totalIssuedPynths(pUSD);
					const conversionFactor = web3.utils.toBN(1000000000);
					const expectedDebtAccount1 = multiplyDecimal(
						account1DebtRatio,
						totalIssuedPynthpUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);
					const expectedDebtAccount2 = multiplyDecimal(
						account2DebtRatio,
						totalIssuedPynthpUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);

					assert.bnClose(await periFinance.debtBalanceOf(account1, pUSD), expectedDebtAccount1);
					assert.bnClose(await periFinance.debtBalanceOf(account2, pUSD), expectedDebtAccount2);
				});

				it("should correctly calculate a user's debt balance without prior issuance", async () => {
					await periFinance.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					const debt1 = await periFinance.debtBalanceOf(account1, toBytes32('pUSD'));
					const debt2 = await periFinance.debtBalanceOf(account2, toBytes32('pUSD'));
					assert.bnEqual(debt1, 0);
					assert.bnEqual(debt2, 0);
				});

				it("should correctly calculate a user's debt balance with prior issuance", async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedPynths = toUnit('1001');
					await periFinance.issuePynths(issuedPynths, { from: account1 });

					const debt = await periFinance.debtBalanceOf(account1, toBytes32('pUSD'));
					assert.bnEqual(debt, issuedPynths);
				});
			});

			describe('remainingIssuablePynths()', () => {
				it("should correctly calculate a user's remaining issuable pynths with prior issuance", async () => {
					const peri2usdRate = await exchangeRates.rateForCurrency(PERI);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedPeriFinances = web3.utils.toBN('200012');
					await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
						from: owner,
					});

					// Issue
					const amountIssued = toUnit('2011');
					await periFinance.issuePynths(amountIssued, { from: account1 });

					const expectedIssuablePynths = multiplyDecimal(
						toUnit(issuedPeriFinances),
						multiplyDecimal(peri2usdRate, issuanceRatio)
					).sub(amountIssued);

					const issuablePynths = await issuer.remainingIssuablePynths(account1);
					assert.bnEqual(issuablePynths.maxIssuable, expectedIssuablePynths);

					// other args should also be correct
					assert.bnEqual(issuablePynths.totalSystemDebt, amountIssued);
					assert.bnEqual(issuablePynths.alreadyIssued, amountIssued);
				});

				it("should correctly calculate a user's remaining issuable pynths without prior issuance", async () => {
					const peri2usdRate = await exchangeRates.rateForCurrency(PERI);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedPeriFinances = web3.utils.toBN('20');
					await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
						from: owner,
					});

					const expectedIssuablePynths = multiplyDecimal(
						toUnit(issuedPeriFinances),
						multiplyDecimal(peri2usdRate, issuanceRatio)
					);

					const remainingIssuable = await issuer.remainingIssuablePynths(account1);
					assert.bnEqual(remainingIssuable.maxIssuable, expectedIssuablePynths);
				});
			});

			describe('maxIssuablePynths()', () => {
				it("should correctly calculate a user's maximum issuable pynths without prior issuance", async () => {
					const rate = await exchangeRates.rateForCurrency(toBytes32('PERI'));
					const issuedPeriFinances = web3.utils.toBN('200000');
					await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
						from: owner,
					});
					const issuanceRatio = await systemSettings.issuanceRatio();

					const expectedIssuablePynths = multiplyDecimal(
						toUnit(issuedPeriFinances),
						multiplyDecimal(rate, issuanceRatio)
					);
					const maxIssuablePynths = await periFinance.maxIssuablePynths(account1);

					assert.bnEqual(expectedIssuablePynths, maxIssuablePynths);
				});

				it("should correctly calculate a user's maximum issuable pynths without any PERI", async () => {
					const maxIssuablePynths = await periFinance.maxIssuablePynths(account1);
					assert.bnEqual(0, maxIssuablePynths);
				});

				it("should correctly calculate a user's maximum issuable pynths with prior issuance", async () => {
					const peri2usdRate = await exchangeRates.rateForCurrency(PERI);

					const issuedPeriFinances = web3.utils.toBN('320001');
					await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
						from: owner,
					});

					const issuanceRatio = await systemSettings.issuanceRatio();
					const amountIssued = web3.utils.toBN('1234');
					await periFinance.issuePynths(toUnit(amountIssued), { from: account1 });

					const expectedIssuablePynths = multiplyDecimal(
						toUnit(issuedPeriFinances),
						multiplyDecimal(peri2usdRate, issuanceRatio)
					);

					const maxIssuablePynths = await periFinance.maxIssuablePynths(account1);
					assert.bnEqual(expectedIssuablePynths, maxIssuablePynths);
				});
			});

			describe('adding and removing pynths', () => {
				it('should allow adding a Pynth contract', async () => {
					const previousPynthCount = await periFinance.availablePynthCount();

					const { token: pynth } = await mockToken({
						accounts,
						pynth: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					const txn = await issuer.addPynth(pynth.address, { from: owner });

					const currencyKey = toBytes32('sXYZ');

					// Assert that we've successfully added a Pynth
					assert.bnEqual(
						await periFinance.availablePynthCount(),
						previousPynthCount.add(web3.utils.toBN(1))
					);
					// Assert that it's at the end of the array
					assert.equal(await periFinance.availablePynths(previousPynthCount), pynth.address);
					// Assert that it's retrievable by its currencyKey
					assert.equal(await periFinance.pynths(currencyKey), pynth.address);

					// Assert event emitted
					assert.eventEqual(txn.logs[0], 'PynthAdded', [currencyKey, pynth.address]);
				});

				it('should disallow adding a Pynth contract when the user is not the owner', async () => {
					const { token: pynth } = await mockToken({
						accounts,
						pynth: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await onlyGivenAddressCanInvoke({
						fnc: issuer.addPynth,
						accounts,
						args: [pynth.address],
						address: owner,
						reason: 'Only the contract owner may perform this action',
					});
				});

				it('should disallow double adding a Pynth contract with the same address', async () => {
					const { token: pynth } = await mockToken({
						accounts,
						pynth: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addPynth(pynth.address, { from: owner });
					await assert.revert(issuer.addPynth(pynth.address, { from: owner }), 'Pynth exists');
				});

				it('should disallow double adding a Pynth contract with the same currencyKey', async () => {
					const { token: pynth1 } = await mockToken({
						accounts,
						pynth: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					const { token: pynth2 } = await mockToken({
						accounts,
						pynth: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addPynth(pynth1.address, { from: owner });
					await assert.revert(issuer.addPynth(pynth2.address, { from: owner }), 'Pynth exists');
				});

				describe('when another pynth is added with 0 supply', () => {
					let currencyKey, pynth, pynthProxy;

					beforeEach(async () => {
						const symbol = 'sBTC';
						currencyKey = toBytes32(symbol);

						({ token: pynth, proxy: pynthProxy } = await mockToken({
							pynth: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addPynth(pynth.address, { from: owner });
						await setupPriceAggregators(exchangeRates, owner, [currencyKey]);
					});

					it('should be able to query multiple pynth addresses', async () => {
						const pynthAddresses = await issuer.getPynths([currencyKey, pETH, pUSD]);
						assert.equal(pynthAddresses[0], pynth.address);
						assert.equal(pynthAddresses[1], pETHContract.address);
						assert.equal(pynthAddresses[2], pUSDContract.address);
						assert.equal(pynthAddresses.length, 3);
					});

					it('should allow removing a Pynth contract when it has no issued balance', async () => {
						const pynthCount = await periFinance.availablePynthCount();

						assert.notEqual(await periFinance.pynths(currencyKey), ZERO_ADDRESS);

						const txn = await issuer.removePynth(currencyKey, { from: owner });

						// Assert that we have one less pynth, and that the specific currency key is gone.
						assert.bnEqual(
							await periFinance.availablePynthCount(),
							pynthCount.sub(web3.utils.toBN(1))
						);
						assert.equal(await periFinance.pynths(currencyKey), ZERO_ADDRESS);

						assert.eventEqual(txn, 'PynthRemoved', [currencyKey, pynth.address]);
					});

					it('should disallow removing a token by a non-owner', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: issuer.removePynth,
							args: [currencyKey],
							accounts,
							address: owner,
							reason: 'Only the contract owner may perform this action',
						});
					});

					describe('when that pynth has issued but has no rate', () => {
						beforeEach(async () => {
							await pynth.issue(account1, toUnit('100'));
						});
						it('should disallow removing a Pynth contract when it has an issued balance and no rate', async () => {
							// Assert that we can't remove the pynth now
							await assert.revert(
								issuer.removePynth(currencyKey, { from: owner }),
								'Cannot remove without rate'
							);
						});
						describe('when the pynth has a rate', () => {
							beforeEach(async () => {
								await updateAggregatorRates(
									exchangeRates,
									circuitBreaker,
									[currencyKey],
									[toUnit('2')]
								);
							});

							describe('when another user exchanges into the pynth', () => {
								beforeEach(async () => {
									await pUSDContract.issue(account2, toUnit('1000'));
									await periFinance.exchange(pUSD, toUnit('100'), currencyKey, { from: account2 });
								});
								describe('when the pynth is removed', () => {
									beforeEach(async () => {
										await issuer.removePynth(currencyKey, { from: owner });
									});
									it('then settling works as expected', async () => {
										await periFinance.settle(currencyKey);

										const { numEntries } = await exchanger.settlementOwing(owner, currencyKey);
										assert.equal(numEntries, '0');
									});
								});
								describe('when the same user exchanges out of the pynth', () => {
									beforeEach(async () => {
										await setExchangeWaitingPeriod({ owner, systemSettings, secs: 60 });
										// pass through the waiting period so we can exchange again
										await fastForward(90);
										await periFinance.exchange(currencyKey, toUnit('1'), pUSD, { from: account2 });
									});
									describe('when the pynth is removed', () => {
										beforeEach(async () => {
											await issuer.removePynth(currencyKey, { from: owner });
										});
										it('then settling works as expected', async () => {
											await periFinance.settle(pUSD);

											const { numEntries } = await exchanger.settlementOwing(owner, pUSD);
											assert.equal(numEntries, '0');
										});
										it('then settling from the original currency works too', async () => {
											await periFinance.settle(currencyKey);
											const { numEntries } = await exchanger.settlementOwing(owner, currencyKey);
											assert.equal(numEntries, '0');
										});
									});
								});
							});

							describe('when a debt snapshot is taken', () => {
								let totalIssuedPynths;
								beforeEach(async () => {
									await updateDebtMonitors();

									totalIssuedPynths = await issuer.totalIssuedPynths(pUSD, true);

									// 100 pETH at 2 per pETH is 200 total debt
									assert.bnEqual(totalIssuedPynths, toUnit('200'));
								});
								describe('when the pynth is removed', () => {
									let txn;
									beforeEach(async () => {
										// base conditions
										assert.equal(await pUSDContract.balanceOf(pynthRedeemer.address), '0');
										assert.equal(await pynthRedeemer.redemptions(pynthProxy.address), '0');

										// now do the removal
										txn = await issuer.removePynth(currencyKey, { from: owner });
									});
									it('emits an event', async () => {
										assert.eventEqual(txn, 'PynthRemoved', [currencyKey, pynth.address]);
									});
									it('issues the equivalent amount of pUSD', async () => {
										const amountOfpUSDIssued = await pUSDContract.balanceOf(pynthRedeemer.address);

										// 100 units of sBTC at a rate of 2:1
										assert.bnEqual(amountOfpUSDIssued, toUnit('200'));
									});
									it('it invokes deprecate on the redeemer via the proxy', async () => {
										const redeemRate = await pynthRedeemer.redemptions(pynthProxy.address);

										assert.bnEqual(redeemRate, toUnit('2'));
									});
									it('and total debt remains unchanged', async () => {
										assert.bnEqual(await issuer.totalIssuedPynths(pUSD, true), totalIssuedPynths);
									});
								});
							});
						});
					});
				});

				describe('multiple add/remove pynths', () => {
					let currencyKey, pynth;

					beforeEach(async () => {
						const symbol = 'sBTC';
						currencyKey = toBytes32(symbol);

						({ token: pynth } = await mockToken({
							pynth: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addPynth(pynth.address, { from: owner });
					});

					it('should allow adding multiple Pynth contracts at once', async () => {
						const previousPynthCount = await periFinance.availablePynthCount();

						const { token: pynth1 } = await mockToken({
							accounts,
							pynth: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						const { token: pynth2 } = await mockToken({
							accounts,
							pynth: 'sABC',
							skipInitialAllocation: true,
							supply: 0,
							name: 'ABC',
							symbol: 'ABC',
						});

						const txn = await issuer.addPynths([pynth1.address, pynth2.address], { from: owner });

						const currencyKey1 = toBytes32('sXYZ');
						const currencyKey2 = toBytes32('sABC');

						// Assert that we've successfully added two Pynths
						assert.bnEqual(
							await periFinance.availablePynthCount(),
							previousPynthCount.add(web3.utils.toBN(2))
						);
						// Assert that they're at the end of the array
						assert.equal(await periFinance.availablePynths(previousPynthCount), pynth1.address);
						assert.equal(
							await periFinance.availablePynths(previousPynthCount.add(web3.utils.toBN(1))),
							pynth2.address
						);
						// Assert that they are retrievable by currencyKey
						assert.equal(await periFinance.pynths(currencyKey1), pynth1.address);
						assert.equal(await periFinance.pynths(currencyKey2), pynth2.address);

						// Assert events emitted
						assert.eventEqual(txn.logs[0], 'PynthAdded', [currencyKey1, pynth1.address]);
						assert.eventEqual(txn.logs[1], 'PynthAdded', [currencyKey2, pynth2.address]);
					});

					it('should disallow multi-adding the same Pynth contract', async () => {
						const { token: pynth } = await mockToken({
							accounts,
							pynth: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addPynths([pynth.address, pynth.address], { from: owner }),
							'Pynth exists'
						);
					});

					it('should disallow multi-adding pynth contracts with the same currency key', async () => {
						const { token: pynth1 } = await mockToken({
							accounts,
							pynth: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						const { token: pynth2 } = await mockToken({
							accounts,
							pynth: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addPynths([pynth1.address, pynth2.address], { from: owner }),
							'Pynth exists'
						);
					});

					it('should disallow removing non-existent pynths', async () => {
						const fakeCurrencyKey = toBytes32('NOPE');

						// Assert that we can't remove the pynth
						await assert.revert(
							issuer.removePynths([currencyKey, fakeCurrencyKey], { from: owner }),
							'Pynth does not exist'
						);
					});

					it('should disallow removing pUSD', async () => {
						// Assert that we can't remove pUSD
						await assert.revert(
							issuer.removePynths([currencyKey, pUSD], { from: owner }),
							'Cannot remove pynth'
						);
					});

					it('should allow removing pynths with no balance', async () => {
						const symbol2 = 'sFOO';
						const currencyKey2 = toBytes32(symbol2);

						const { token: pynth2 } = await mockToken({
							pynth: symbol2,
							accounts,
							name: 'foo',
							symbol2,
							supply: 0,
							skipInitialAllocation: true,
						});

						await issuer.addPynth(pynth2.address, { from: owner });

						const previousPynthCount = await periFinance.availablePynthCount();

						const tx = await issuer.removePynths([currencyKey, currencyKey2], { from: owner });

						assert.bnEqual(
							await periFinance.availablePynthCount(),
							previousPynthCount.sub(web3.utils.toBN(2))
						);

						// Assert events emitted
						assert.eventEqual(tx.logs[0], 'PynthRemoved', [currencyKey, pynth.address]);
						assert.eventEqual(tx.logs[1], 'PynthRemoved', [currencyKey2, pynth2.address]);
					});
				});
			});

			describe('issuance', () => {
				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has pynths to issue from
						await periFinance.transfer(account1, toUnit('1000'), { from: owner });
					});

					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling issue() reverts', async () => {
								await assert.revert(
									periFinance.issuePynths(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling issueMaxPynths() reverts', async () => {
								await assert.revert(
									periFinance.issueMaxPynths({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling issue() succeeds', async () => {
									await periFinance.issuePynths(toUnit('1'), { from: account1 });
								});
								it('and calling issueMaxPynths() succeeds', async () => {
									await periFinance.issueMaxPynths({ from: account1 });
								});
							});
						});
					});
					describe(`when PERI is stale`, () => {
						beforeEach(async () => {
							await fastForward(
								(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
							);
							await updateDebtMonitors();
						});

						it('reverts on issuePynths()', async () => {
							await assert.revert(
								periFinance.issuePynths(toUnit('1'), { from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
						it('reverts on issueMaxPynths()', async () => {
							await assert.revert(
								periFinance.issueMaxPynths({ from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
					});

					describe(`when debt aggregator is stale`, () => {
						beforeEach(async () => {
							await aggregatorDebtRatio.setOverrideTimestamp(500); // really old timestamp
						});

						it('reverts on issuePynths()', async () => {
							await assert.revert(
								periFinance.issuePynths(toUnit('1'), { from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
						it('reverts on issueMaxPynths()', async () => {
							await assert.revert(
								periFinance.issueMaxPynths({ from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
					});
				});
				it('should allow the issuance of a small amount of pynths', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					// Note: If a too small amount of pynths are issued here, the amount may be
					// rounded to 0 in the debt register. This will revert. As such, there is a minimum
					// number of pynths that need to be issued each time issue is invoked. The exact
					// amount depends on the Pynth exchange rate and the total supply.
					await periFinance.issuePynths(web3.utils.toBN('5'), { from: account1 });
				});

				it('should be possible to issue the maximum amount of pynths via issuePynths', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('1000'), { from: owner });

					const maxPynths = await periFinance.maxIssuablePynths(account1);

					// account1 should be able to issue
					await periFinance.issuePynths(maxPynths, { from: account1 });
				});

				it('should allow an issuer to issue pynths in one flavour', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					await periFinance.issuePynths(toUnit('10'), { from: account1 });

					// There should be 10 pUSD of value in the system
					assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('10'));

					// And account1 should own 100% of the debt.
					assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('10'));
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('10'));
				});

				// TODO: Check that the rounding errors are acceptable
				it('should allow two issuers to issue pynths in one flavour', async () => {
					// Give some PERI to account1 and account2
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await periFinance.issuePynths(toUnit('10'), { from: account1 });
					await periFinance.issuePynths(toUnit('20'), { from: account2 });

					// There should be 30pUSD of value in the system
					assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('30'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await periFinance.debtBalanceOf(account1, pUSD), toUnit('10'));
					assert.bnClose(await periFinance.debtBalanceOf(account2, pUSD), toUnit('20'));
				});

				it('should allow multi-issuance in one flavour', async () => {
					// Give some PERI to account1 and account2
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await periFinance.issuePynths(toUnit('10'), { from: account1 });
					await periFinance.issuePynths(toUnit('20'), { from: account2 });
					await periFinance.issuePynths(toUnit('10'), { from: account1 });

					// There should be 40 pUSD of value in the system
					assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('40'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await periFinance.debtBalanceOf(account1, pUSD), toUnit('20'));
					assert.bnClose(await periFinance.debtBalanceOf(account2, pUSD), toUnit('20'));
				});

				describe('issuePynthsWithoutDebt', () => {
					describe('successfully invoked', () => {
						let beforeCachedDebt;

						beforeEach(async () => {
							beforeCachedDebt = await debtCache.cachedDebt();

							await issuer.issuePynthsWithoutDebt(pETH, owner, toUnit(100), {
								from: periFinanceBridgeToOptimism,
							});
						});

						it('issues pynths', async () => {
							assert.bnEqual(await pETHContract.balanceOf(owner), toUnit(100));
						});

						it('maintains debt cache', async () => {
							assert.bnEqual(await debtCache.cachedDebt(), beforeCachedDebt.add(toUnit(20000)));
						});
					});
				});

				describe('burnPynthsWithoutDebt', () => {
					describe('successfully invoked', () => {
						let beforeCachedDebt;

						beforeEach(async () => {
							beforeCachedDebt = await debtCache.cachedDebt();
							await issuer.issuePynthsWithoutDebt(pETH, owner, toUnit(100), {
								from: periFinanceBridgeToOptimism,
							});
							await issuer.burnPynthsWithoutDebt(pETH, owner, toUnit(50), {
								from: periFinanceBridgeToOptimism,
							});
						});

						it('burns pynths', async () => {
							assert.bnEqual(await pETHContract.balanceOf(owner), toUnit(50));
						});

						it('maintains debt cache', async () => {
							assert.bnEqual(await debtCache.cachedDebt(), beforeCachedDebt.add(toUnit(10000)));
						});
					});
				});

				describe('burnAndIssuePynthsWithoutDebtCache', () => {
					describe('successfully invoked', () => {
						let beforeCachedDebt;

						beforeEach(async () => {
							// set the exchange fees and waiting period to 0 to effectively ignore both
							await setExchangeWaitingPeriod({ owner, systemSettings, secs: 0 });
							await setExchangeFeeRateForPynths({
								owner,
								systemSettings,
								pynthKeys,
								exchangeFeeRates: pynthKeys.map(() => 0),
							});
						});

						beforeEach(async () => {
							await pUSDContract.issue(account7, toUnit(1000));
							await periFinance.exchange(pUSD, toUnit(200), pETH, { from: account7 });
						});

						beforeEach(async () => {
							beforeCachedDebt = await debtCache.cachedDebt();
							await issuer.burnAndIssuePynthsWithoutDebtCache(
								account7,
								pETH,
								toUnit('0.5'),
								toUnit(200),
								{
									from: dynamicPynthRedeemer,
								}
							);
						});

						it('burns target pynths', async () => {
							assert.bnEqual(await pETHContract.balanceOf(account7), toUnit('0.5'));
						});

						it('issues the correct amount of pUSD', async () => {
							assert.bnEqual(await pUSDContract.balanceOf(account7), toUnit(1000));
						});

						it('debt cache remains unaffected', async () => {
							assert.bnEqual(await debtCache.cachedDebt(), beforeCachedDebt);
						});
					});
				});

				describe('issueMaxPynths', () => {
					it('should allow an issuer to issue max pynths in one flavour', async () => {
						// Give some PERI to account1
						await periFinance.transfer(account1, toUnit('10000'), {
							from: owner,
						});

						// Issue
						await periFinance.issueMaxPynths({ from: account1 });

						// There should be 200 pUSD of value in the system
						assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('200'));

						// And account1 should own all of it.
						assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('200'));
					});
				});

				it('should allow an issuer to issue max pynths via the standard issue call', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Determine maximum amount that can be issued.
					const maxIssuable = await periFinance.maxIssuablePynths(account1);

					// Issue
					await periFinance.issuePynths(maxIssuable, { from: account1 });

					// There should be 200 pUSD of value in the system
					assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit('200'));

					// And account1 should own all of it.
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('200'));
				});

				it('should disallow an issuer from issuing pynths beyond their remainingIssuablePynths', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// They should now be able to issue pUSD
					let issuablePynths = await issuer.remainingIssuablePynths(account1);
					assert.bnEqual(issuablePynths.maxIssuable, toUnit('200'));

					// Issue that amount.
					await periFinance.issuePynths(issuablePynths.maxIssuable, { from: account1 });

					// They should now have 0 issuable pynths.
					issuablePynths = await issuer.remainingIssuablePynths(account1);
					assert.bnEqual(issuablePynths.maxIssuable, '0');

					// And trying to issue the smallest possible unit of one should fail.
					await assert.revert(periFinance.issuePynths('1', { from: account1 }), 'Amount too large');
				});

				it('circuit breaks when debt changes dramatically', async () => {
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// debt must start at 0
					assert.bnEqual(await periFinance.totalIssuedPynths(pUSD), toUnit(0));

					// They should now be able to issue pUSD
					await periFinance.issuePynths(toUnit('100'), { from: account1 });
					await updateDebtMonitors();
					await periFinance.issuePynths(toUnit('1'), { from: account1 });
					await updateDebtMonitors();

					assert.bnEqual(await pUSDContract.balanceOf(account1), toUnit('101'));

					await pUSDContract.issue(account1, toUnit('10000000'));
					//await updateDebtMonitors();
					await debtCache.takeDebtSnapshot();

					assert.bnEqual(await pUSDContract.balanceOf(account1), toUnit('10000101'));

					// trigger circuit breaking
					await periFinance.issuePynths(toUnit('1'), { from: account1 });

					assert.bnEqual(await pUSDContract.balanceOf(account1), toUnit('10000101'));

					// undo
					await pUSDContract.burn(account1, toUnit('10000000'));

					// circuit is still broken
					await periFinance.issuePynths(toUnit('1'), { from: account1 });
					await periFinance.issuePynths(toUnit('1'), { from: account1 });

					assert.bnEqual(await pUSDContract.balanceOf(account1), toUnit('101'));
				});
			});

			describe('burning', () => {
				it('circuit breaks when debt changes dramatically', async () => {
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// They should now be able to issue pUSD
					await periFinance.issuePynths(toUnit('100'), { from: account1 });
					await updateDebtMonitors();
					await periFinance.burnPynths(toUnit('1'), { from: account1 });

					// burn the rest of the pynths without getting rid of debt shares
					await pUSDContract.burn(account1, toUnit('90'));
					// await updateDebtMonitors();
					await debtCache.takeDebtSnapshot();

					// all debt should be burned here
					assert.bnEqual(await pUSDContract.balanceOf(account1), toUnit(9));

					// trigger circuit breaking (not reverting here is part of the test)
					await periFinance.burnPynths('1', { from: account1 });

					// debt should not have changed
					assert.bnEqual(await pUSDContract.balanceOf(account1), toUnit(9));

					// mint it back
					await pUSDContract.issue(account1, toUnit('90'));

					await periFinance.burnPynths('1', { from: account1 });
					await periFinance.burnPynths('1', { from: account1 });

					// debt should not have changed
					assert.bnEqual(await pUSDContract.balanceOf(account1), toUnit(99));
				});

				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has pynths to burb
						await periFinance.transfer(account1, toUnit('1000'), { from: owner });
						await periFinance.issueMaxPynths({ from: account1 });
					});
					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling burn() reverts', async () => {
								await assert.revert(
									periFinance.burnPynths(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling burnPynthsToTarget() reverts', async () => {
								await assert.revert(
									periFinance.burnPynthsToTarget({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling burnPynths() succeeds', async () => {
									await periFinance.burnPynths(toUnit('1'), { from: account1 });
								});
								it('and calling burnPynthsToTarget() succeeds', async () => {
									await periFinance.burnPynthsToTarget({ from: account1 });
								});
							});
						});
					});

					describe(`when PERI is stale`, () => {
						beforeEach(async () => {
							await fastForward(
								(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
							);
							await updateDebtMonitors();
						});

						it('then calling burn() reverts', async () => {
							await assert.revert(
								periFinance.burnPynths(toUnit('1'), { from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
						it('and calling burnPynthsToTarget() reverts', async () => {
							await assert.revert(
								periFinance.burnPynthsToTarget({ from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
					});

					describe(`when debt aggregator is stale`, () => {
						beforeEach(async () => {
							await aggregatorDebtRatio.setOverrideTimestamp(500);
						});

						it('then calling burn() reverts', async () => {
							await assert.revert(
								periFinance.burnPynths(toUnit('1'), { from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
						it('and calling burnPynthsToTarget() reverts', async () => {
							await assert.revert(
								periFinance.burnPynthsToTarget({ from: account1 }),
								'A pynth or PERI rate is invalid'
							);
						});
					});
				});

				it('should allow an issuer with outstanding debt to burn pynths and decrease debt', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await periFinance.issueMaxPynths({ from: account1 });

					// account1 should now have 200 pUSD of debt.
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('200'));

					// Burn 100 pUSD
					await periFinance.burnPynths(toUnit('100'), { from: account1 });

					// account1 should now have 100 pUSD of debt.
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('100'));
				});

				it('should disallow an issuer without outstanding debt from burning pynths', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await periFinance.issueMaxPynths({ from: account1 });

					// account2 should not have anything and can't burn.
					await assert.revert(
						periFinance.burnPynths(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);

					// And even when we give account2 pynths, it should not be able to burn.
					await pUSDContract.transfer(account2, toUnit('100'), {
						from: account1,
					});

					await assert.revert(
						periFinance.burnPynths(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);
				});

				it('should revert when trying to burn pynths that do not exist', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await periFinance.issueMaxPynths({ from: account1 });

					// Transfer all newly issued pynths to account2
					await pUSDContract.transfer(account2, toUnit('200'), {
						from: account1,
					});

					const debtBefore = await periFinance.debtBalanceOf(account1, pUSD);

					assert.ok(!debtBefore.isNeg());

					// Burning any amount of pUSD beyond what is owned will cause a revert
					await assert.revert(
						periFinance.burnPynths('1', { from: account1 }),
						'SafeMath: subtraction overflow'
					);
				});

				it("should only burn up to a user's actual debt level", async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					const fullAmount = toUnit('210');
					const account1Payment = toUnit('10');
					const account2Payment = fullAmount.sub(account1Payment);
					await periFinance.issuePynths(account1Payment, { from: account1 });
					await periFinance.issuePynths(account2Payment, { from: account2 });

					// Transfer all of account2's pynths to account1
					const amountTransferred = toUnit('200');
					await pUSDContract.transfer(account1, amountTransferred, {
						from: account2,
					});
					// return;

					const balanceOfAccount1 = await pUSDContract.balanceOf(account1);

					// Then try to burn them all. Only 10 pynths (and fees) should be gone.
					await periFinance.burnPynths(balanceOfAccount1, { from: account1 });
					const balanceOfAccount1AfterBurn = await pUSDContract.balanceOf(account1);

					// Recording debts in the debt ledger reduces accuracy.
					//   Let's allow for a 1000 margin of error.
					assert.bnClose(balanceOfAccount1AfterBurn, amountTransferred, '1000');
				});

				it("should successfully burn all user's pynths @gasprofile", async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await periFinance.issuePynths(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 pynths (and fees) should be gone.
					await periFinance.burnPynths(await pUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await pUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of pynths', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					await periFinance.issuePynths(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 pynths (and fees) should be gone.
					await periFinance.burnPynths(await pUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await pUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of pynths', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedPynthsPt1 = toUnit('2000');
					const issuedPynthsPt2 = toUnit('2000');
					await periFinance.issuePynths(issuedPynthsPt1, { from: account1 });
					await periFinance.issuePynths(issuedPynthsPt2, { from: account1 });
					await periFinance.issuePynths(toUnit('1000'), { from: account2 });

					const debt = await periFinance.debtBalanceOf(account1, pUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				describe('debt calculation in multi-issuance scenarios', () => {
					it('should correctly calculate debt in a multi-issuance multi-burn scenario @gasprofile', async () => {
						// Give some PERI to account1
						await periFinance.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await periFinance.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await periFinance.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedPynths1 = toUnit('2000');
						const issuedPynths2 = toUnit('2000');
						const issuedPynths3 = toUnit('2000');

						// Send more than their pynth balance to burn all
						const burnAllPynths = toUnit('2050');

						await periFinance.issuePynths(issuedPynths1, { from: account1 });
						await periFinance.issuePynths(issuedPynths2, { from: account2 });
						await periFinance.issuePynths(issuedPynths3, { from: account3 });

						await periFinance.burnPynths(burnAllPynths, { from: account1 });
						await periFinance.burnPynths(burnAllPynths, { from: account2 });
						await periFinance.burnPynths(burnAllPynths, { from: account3 });

						const debtBalance1After = await periFinance.debtBalanceOf(account1, pUSD);
						const debtBalance2After = await periFinance.debtBalanceOf(account2, pUSD);
						const debtBalance3After = await periFinance.debtBalanceOf(account3, pUSD);

						assert.bnEqual(debtBalance1After, '0');
						assert.bnEqual(debtBalance2After, '0');
						assert.bnEqual(debtBalance3After, '0');
					});

					it('should allow user to burn all pynths issued even after other users have issued', async () => {
						// Give some PERI to account1
						await periFinance.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await periFinance.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await periFinance.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedPynths1 = toUnit('2000');
						const issuedPynths2 = toUnit('2000');
						const issuedPynths3 = toUnit('2000');

						await periFinance.issuePynths(issuedPynths1, { from: account1 });
						await periFinance.issuePynths(issuedPynths2, { from: account2 });
						await periFinance.issuePynths(issuedPynths3, { from: account3 });

						const debtBalanceBefore = await periFinance.debtBalanceOf(account1, pUSD);
						await periFinance.burnPynths(debtBalanceBefore, { from: account1 });
						const debtBalanceAfter = await periFinance.debtBalanceOf(account1, pUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow a user to burn up to their balance if they try too burn too much', async () => {
						// Give some PERI to account1
						await periFinance.transfer(account1, toUnit('500000'), {
							from: owner,
						});

						// Issue
						const issuedPynths1 = toUnit('10');

						await periFinance.issuePynths(issuedPynths1, { from: account1 });
						await periFinance.burnPynths(issuedPynths1.add(toUnit('9000')), {
							from: account1,
						});
						const debtBalanceAfter = await periFinance.debtBalanceOf(account1, pUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow users to burn their debt and adjust the debtBalanceOf correctly for remaining users', async () => {
						// Give some PERI to account1
						await periFinance.transfer(account1, toUnit('40000000'), {
							from: owner,
						});
						await periFinance.transfer(account2, toUnit('40000000'), {
							from: owner,
						});

						// Issue
						const issuedPynths1 = toUnit('150000');
						const issuedPynths2 = toUnit('50000');

						await periFinance.issuePynths(issuedPynths1, { from: account1 });
						await periFinance.issuePynths(issuedPynths2, { from: account2 });

						let debtBalance1After = await periFinance.debtBalanceOf(account1, pUSD);
						let debtBalance2After = await periFinance.debtBalanceOf(account2, pUSD);

						// debtBalanceOf has rounding error but is within tolerance
						assert.bnClose(debtBalance1After, toUnit('150000'), '100000');
						assert.bnClose(debtBalance2After, toUnit('50000'), '100000');

						// Account 1 burns 100,000
						await periFinance.burnPynths(toUnit('100000'), { from: account1 });

						debtBalance1After = await periFinance.debtBalanceOf(account1, pUSD);
						debtBalance2After = await periFinance.debtBalanceOf(account2, pUSD);

						assert.bnClose(debtBalance1After, toUnit('50000'), '100000');
						assert.bnClose(debtBalance2After, toUnit('50000'), '100000');
					});

					it('should revert if sender tries to issue pynths with 0 amount', async () => {
						// Issue 0 amount of pynth
						const issuedPynths1 = toUnit('0');

						await assert.revert(
							periFinance.issuePynths(issuedPynths1, { from: account1 }),
							'cannot issue 0 pynths'
						);
					});
				});

				describe('burnPynthsToTarget', () => {
					beforeEach(async () => {
						// Give some PERI to account1
						await periFinance.transfer(account1, toUnit('40000'), {
							from: owner,
						});
						// Set PERI price to 1
						await updateAggregatorRates(exchangeRates, circuitBreaker, [PERI], ['1'].map(toUnit));
						await updateDebtMonitors();

						// Issue
						await periFinance.issueMaxPynths({ from: account1 });
						assert.bnClose(await periFinance.debtBalanceOf(account1, pUSD), toUnit('8000'));

						// Set minimumStakeTime to 1 hour
						await systemSettings.setMinimumStakeTime(60 * 60, { from: owner });
					});

					describe('when the PERI price drops 50%', () => {
						let maxIssuablePynths;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [PERI], ['.5'].map(toUnit));
							await updateDebtMonitors();

							maxIssuablePynths = await periFinance.maxIssuablePynths(account1);
							assert.equal(await feePool.isFeesClaimable(account1), false);
						});

						it('then the maxIssuablePynths drops 50%', async () => {
							assert.bnClose(maxIssuablePynths, toUnit('4000'));
						});
						it('then calling burnPynthsToTarget() reduces pUSD to c-ratio target', async () => {
							await periFinance.burnPynthsToTarget({ from: account1 });
							assert.bnClose(await periFinance.debtBalanceOf(account1, pUSD), toUnit('4000'));
						});
						it('then fees are claimable', async () => {
							await periFinance.burnPynthsToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the PERI price drops 10%', () => {
						let maxIssuablePynths;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [PERI], ['.9'].map(toUnit));
							await updateDebtMonitors();

							maxIssuablePynths = await periFinance.maxIssuablePynths(account1);
						});

						it('then the maxIssuablePynths drops 10%', async () => {
							assert.bnEqual(maxIssuablePynths, toUnit('7200'));
						});
						it('then calling burnPynthsToTarget() reduces pUSD to c-ratio target', async () => {
							await periFinance.burnPynthsToTarget({ from: account1 });
							assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('7200'));
						});
						it('then fees are claimable', async () => {
							await periFinance.burnPynthsToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the PERI price drops 90%', () => {
						let maxIssuablePynths;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [PERI], ['.1'].map(toUnit));
							await updateDebtMonitors();

							maxIssuablePynths = await periFinance.maxIssuablePynths(account1);
						});

						it('then the maxIssuablePynths drops 10%', async () => {
							assert.bnEqual(maxIssuablePynths, toUnit('800'));
						});
						it('then calling burnPynthsToTarget() reduces pUSD to c-ratio target', async () => {
							await periFinance.burnPynthsToTarget({ from: account1 });
							assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('800'));
						});
						it('then fees are claimable', async () => {
							await periFinance.burnPynthsToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the PERI price increases 100%', () => {
						let maxIssuablePynths;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [PERI], ['2'].map(toUnit));
							await updateDebtMonitors();

							maxIssuablePynths = await periFinance.maxIssuablePynths(account1);
						});

						it('then the maxIssuablePynths increases 100%', async () => {
							assert.bnEqual(maxIssuablePynths, toUnit('16000'));
						});
						it('then calling burnPynthsToTarget() reverts', async () => {
							await assert.revert(
								periFinance.burnPynthsToTarget({ from: account1 }),
								'SafeMath: subtraction overflow'
							);
						});
					});
				});

				describe('burnPynths() after exchange()', () => {
					describe('given the waiting period is set to 60s', () => {
						let amount;
						const exchangeFeeRate = toUnit('0');
						beforeEach(async () => {
							amount = toUnit('1250');
							await setExchangeWaitingPeriod({ owner, systemSettings, secs: 60 });

							// set the exchange fee to 0 to effectively ignore it
							await setExchangeFeeRateForPynths({
								owner,
								systemSettings,
								pynthKeys,
								exchangeFeeRates: pynthKeys.map(() => exchangeFeeRate),
							});
						});
						describe('and a user has 1250 pUSD issued', () => {
							beforeEach(async () => {
								await periFinance.transfer(account1, toUnit('1000000'), { from: owner });
								await periFinance.issuePynths(amount, { from: account1 });
							});
							describe('and is has been exchanged into pEUR at a rate of 1.25:1 and the waiting period has expired', () => {
								beforeEach(async () => {
									await periFinance.exchange(pUSD, amount, pEUR, { from: account1 });
									await fastForward(90); // make sure the waiting period is expired on this
								});
								describe('and they have exchanged all of it back into pUSD', () => {
									beforeEach(async () => {
										await periFinance.exchange(pEUR, toUnit('1000'), pUSD, { from: account1 });
									});
									describe('when they attempt to burn the pUSD', () => {
										it('then it fails as the waiting period is ongoing', async () => {
											await assert.revert(
												periFinance.burnPynths(amount, { from: account1 }),
												'Cannot settle during waiting period'
											);
										});
									});
									describe('and 60s elapses with no change in the pEUR rate', () => {
										beforeEach(async () => {
											fastForward(60);
										});
										describe('when they attempt to burn the pUSD', () => {
											let txn;
											beforeEach(async () => {
												txn = await periFinance.burnPynths(amount, { from: account1 });
											});
											it('then it succeeds and burns the entire pUSD amount', async () => {
												const logs = await getDecodedLogs({
													hash: txn.tx,
													contracts: [periFinance, pUSDContract],
												});

												decodedEventEqual({
													event: 'Burned',
													emittedFrom: pUSDContract.address,
													args: [account1, amount],
													log: logs.find(({ name } = {}) => name === 'Burned'),
												});

												const pUSDBalance = await pUSDContract.balanceOf(account1);
												assert.equal(pUSDBalance, '0');

												const debtBalance = await periFinance.debtBalanceOf(account1, pUSD);
												assert.equal(debtBalance, '0');
											});
										});
									});
									describe('and the pEUR price decreases by 20% to 1', () => {
										beforeEach(async () => {
											await updateAggregatorRates(
												exchangeRates,
												circuitBreaker,
												[pEUR],
												['1'].map(toUnit)
											);
											await updateDebtMonitors();
										});
										describe('and 60s elapses', () => {
											beforeEach(async () => {
												fastForward(60);
											});
											describe('when they attempt to burn the entire amount pUSD', () => {
												let txn;
												beforeEach(async () => {
													txn = await periFinance.burnPynths(amount, { from: account1 });
												});
												it('then it succeeds and burns their pUSD minus the reclaim amount from settlement', async () => {
													const logs = await getDecodedLogs({
														hash: txn.tx,
														contracts: [periFinance, pUSDContract],
													});

													decodedEventEqual({
														event: 'Burned',
														emittedFrom: pUSDContract.address,
														args: [account1, amount.sub(toUnit('250'))],
														log: logs
															.reverse()
															.filter(l => !!l)
															.find(({ name }) => name === 'Burned'),
													});

													const pUSDBalance = await pUSDContract.balanceOf(account1);
													assert.equal(pUSDBalance, '0');
												});
												it('and their debt balance is now 0 because they are the only debt holder in the system', async () => {
													// the debt balance remaining is what was reclaimed from the exchange
													const debtBalance = await periFinance.debtBalanceOf(account1, pUSD);
													// because this user is the only one holding debt, when we burn 250 pUSD in a reclaim,
													// it removes it from the totalIssuedPynths and
													assert.equal(debtBalance, '0');
												});
											});
											describe('when another user also has the same amount of debt', () => {
												beforeEach(async () => {
													await periFinance.transfer(account2, toUnit('1000000'), { from: owner });
													await periFinance.issuePynths(amount, { from: account2 });
												});
												describe('when the first user attempts to burn the entire amount pUSD', () => {
													let txn;
													beforeEach(async () => {
														txn = await periFinance.burnPynths(amount, { from: account1 });
													});
													it('then it succeeds and burns their pUSD minus the reclaim amount from settlement', async () => {
														const logs = await getDecodedLogs({
															hash: txn.tx,
															contracts: [periFinance, pUSDContract],
														});

														decodedEventEqual({
															event: 'Burned',
															emittedFrom: pUSDContract.address,
															args: [account1, amount.sub(toUnit('250'))],
															log: logs
																.reverse()
																.filter(l => !!l)
																.find(({ name }) => name === 'Burned'),
														});

														const pUSDBalance = await pUSDContract.balanceOf(account1);
														assert.equal(pUSDBalance, '0');
													});
													it('and their debt balance is now half of the reclaimed balance because they owe half of the pool', async () => {
														// the debt balance remaining is what was reclaimed from the exchange
														const debtBalance = await periFinance.debtBalanceOf(account1, pUSD);
														// because this user is holding half the debt, when we burn 250 pUSD in a reclaim,
														// it removes it from the totalIssuedPynths and so both users have half of 250
														// in owing pynths
														assert.bnClose(debtBalance, divideDecimal('250', 2), '100000');
													});
												});
											});
										});
									});
								});
							});
						});
					});
				});
			});

			describe('debt calculation in multi-issuance scenarios', () => {
				it('should correctly calculate debt in a multi-issuance scenario', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedPynthsPt1 = toUnit('2000');
					const issuedPynthsPt2 = toUnit('2000');
					await periFinance.issuePynths(issuedPynthsPt1, { from: account1 });
					await periFinance.issuePynths(issuedPynthsPt2, { from: account1 });
					await periFinance.issuePynths(toUnit('1000'), { from: account2 });

					const debt = await periFinance.debtBalanceOf(account1, pUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				it('should correctly calculate debt in a multi-issuance multi-burn scenario', async () => {
					// Give some PERI to account1
					await periFinance.transfer(account1, toUnit('500000'), {
						from: owner,
					});
					await periFinance.transfer(account2, toUnit('14000'), {
						from: owner,
					});

					// Issue
					const issuedPynthsPt1 = toUnit('2000');
					const burntPynthsPt1 = toUnit('1500');
					const issuedPynthsPt2 = toUnit('1600');
					const burntPynthsPt2 = toUnit('500');

					await periFinance.issuePynths(issuedPynthsPt1, { from: account1 });
					await periFinance.burnPynths(burntPynthsPt1, { from: account1 });
					await periFinance.issuePynths(issuedPynthsPt2, { from: account1 });

					await periFinance.issuePynths(toUnit('100'), { from: account2 });
					await periFinance.issuePynths(toUnit('51'), { from: account2 });
					await periFinance.burnPynths(burntPynthsPt2, { from: account1 });

					const debt = await periFinance.debtBalanceOf(account1, toBytes32('pUSD'));
					const expectedDebt = issuedPynthsPt1
						.add(issuedPynthsPt2)
						.sub(burntPynthsPt1)
						.sub(burntPynthsPt2);

					assert.bnClose(debt, expectedDebt, '100000');
				});

				it("should allow me to burn all pynths I've issued when there are other issuers", async () => {
					const totalSupply = await periFinance.totalSupply();
					const account2PeriFinances = toUnit('120000');
					const account1PeriFinances = totalSupply.sub(account2PeriFinances);

					await periFinance.transfer(account1, account1PeriFinances, {
						from: owner,
					}); // Issue the massive majority to account1
					await periFinance.transfer(account2, account2PeriFinances, {
						from: owner,
					}); // Issue a small amount to account2

					// Issue from account1
					const account1AmountToIssue = await periFinance.maxIssuablePynths(account1);
					await periFinance.issueMaxPynths({ from: account1 });
					const debtBalance1 = await periFinance.debtBalanceOf(account1, pUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					// Issue and burn from account 2 all debt
					await periFinance.issuePynths(toUnit('43'), { from: account2 });
					let debt = await periFinance.debtBalanceOf(account2, pUSD);

					// due to rounding it may be necessary to supply higher than originally issued pynths
					await pUSDContract.transfer(account2, toUnit('1'), {
						from: account1,
					});
					await periFinance.burnPynths(toUnit('44'), { from: account2 });
					debt = await periFinance.debtBalanceOf(account2, pUSD);

					assert.bnEqual(debt, 0);
				});
			});

			// These tests take a long time to run
			// ****************************************
			describe('multiple issue and burn scenarios', () => {
				it('should correctly calculate debt in a high issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await periFinance.totalSupply();
					const account2PeriFinances = toUnit('120000');
					const account1PeriFinances = totalSupply.sub(account2PeriFinances);

					await periFinance.transfer(account1, account1PeriFinances, {
						from: owner,
					}); // Issue the massive majority to account1
					await periFinance.transfer(account2, account2PeriFinances, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await periFinance.maxIssuablePynths(account1);
					await periFinance.issueMaxPynths({ from: account1 });
					const debtBalance1 = await periFinance.debtBalanceOf(account1, pUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit('43');
						await periFinance.issuePynths(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(4, 14)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await periFinance.burnPynths(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await periFinance.debtBalanceOf(account2, pUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await periFinance.debtBalanceOf(account2, pUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('100000000'));
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high (random) issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await periFinance.totalSupply();
					const account2PeriFinances = toUnit('120000');
					const account1PeriFinances = totalSupply.sub(account2PeriFinances);

					await periFinance.transfer(account1, account1PeriFinances, {
						from: owner,
					}); // Issue the massive majority to account1
					await periFinance.transfer(account2, account2PeriFinances, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await periFinance.maxIssuablePynths(account1);
					await periFinance.issueMaxPynths({ from: account1 });
					const debtBalance1 = await periFinance.debtBalanceOf(account1, pUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit(web3.utils.toBN(getRandomInt(40, 49)));
						await periFinance.issuePynths(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(37, 46)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await periFinance.burnPynths(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await periFinance.debtBalanceOf(account2, pUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await periFinance.debtBalanceOf(account2, pUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('100000000')); // max 0.1 gwei of drift per op
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high volume contrast issuance and burn scenario', async () => {
					const totalSupply = await periFinance.totalSupply();

					// Give only 100 PeriFinance to account2
					const account2PeriFinances = toUnit('100');

					// Give the vast majority to account1 (ie. 99,999,900)
					const account1PeriFinances = totalSupply.sub(account2PeriFinances);

					await periFinance.transfer(account1, account1PeriFinances, {
						from: owner,
					}); // Issue the massive majority to account1
					await periFinance.transfer(account2, account2PeriFinances, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await periFinance.maxIssuablePynths(account1);
					await periFinance.issueMaxPynths({ from: account1 });
					const debtBalance1 = await periFinance.debtBalanceOf(account1, pUSD);
					assert.bnEqual(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						const amount = toUnit('0.000000000000000002');
						await periFinance.issuePynths(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);
					}
					const debtBalance2 = await periFinance.debtBalanceOf(account2, pUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
					assert.bnClose(debtBalance2, expectedDebtForAccount2, variance);
				}).timeout(60e3);
			});

			// ****************************************

			it("should prevent more issuance if the user's collaterisation changes to be insufficient", async () => {
				// disable dynamic fee here as it will prevent exchange due to fees spiking too much
				await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

				// Set pEUR for purposes of this test
				await updateAggregatorRates(exchangeRates, circuitBreaker, [pEUR], [toUnit('0.75')]);
				await updateDebtMonitors();

				const issuedPeriFinances = web3.utils.toBN('200000');
				await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
					from: owner,
				});

				const maxIssuablePynths = await periFinance.maxIssuablePynths(account1);


				// Issue
				const pynthsToNotIssueYet = web3.utils.toBN('2000');
				const issuedPynths = maxIssuablePynths.sub(pynthsToNotIssueYet);
				await periFinance.issuePynths(issuedPynths, { from: account1 });

				// exchange into pEUR
				await periFinance.exchange(pUSD, issuedPynths, pEUR, { from: account1 });

				// Increase the value of pEUR relative to periFinance
				await updateAggregatorRates(exchangeRates, null, [pEUR], [toUnit('1.1')]);
				await updateDebtMonitors();

				await assert.revert(
					periFinance.issuePynths(pynthsToNotIssueYet, { from: account1 }),
					'Amount too large'
				);
			});

			// Check user's collaterisation ratio

			describe('check collaterisation ratio', () => {
				const duration = 52 * WEEK;
				beforeEach(async () => {
					// setup rewardEscrowV2 with mocked feePool address
					await addressResolver.importAddresses([toBytes32('FeePool')], [account6], {
						from: owner,
					});

					// update the cached addresses
					await rewardEscrowV2.rebuildCache({ from: owner });
				});
				it('should return 0 if user has no periFinance when checking the collaterisation ratio', async () => {
					const ratio = await periFinance.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('Any user can check the collaterisation ratio for a user', async () => {
					const issuedPeriFinances = web3.utils.toBN('320000');
					await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
						from: owner,
					});

					// Issue
					const issuedPynths = toUnit(web3.utils.toBN('6400'));
					await periFinance.issuePynths(issuedPynths, { from: account1 });

					await periFinance.collateralisationRatio(account1, { from: account2 });
				});

				it('should be able to read collaterisation ratio for a user with periFinance but no debt', async () => {
					const issuedPeriFinances = web3.utils.toBN('30000');
					await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
						from: owner,
					});

					const ratio = await periFinance.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('should be able to read collaterisation ratio for a user with periFinance and debt', async () => {
					const issuedPeriFinances = web3.utils.toBN('320000');
					await periFinance.transfer(account1, toUnit(issuedPeriFinances), {
						from: owner,
					});

					// Issue
					const issuedPynths = toUnit(web3.utils.toBN('6400'));
					await periFinance.issuePynths(issuedPynths, { from: account1 });

					const ratio = await periFinance.collateralisationRatio(account1, { from: account2 });
					assert.unitEqual(ratio, '0.2');
				});

				it("should not include escrowed periFinance when calculating a user's collaterisation ratio", async () => {
					const peri2usdRate = await exchangeRates.rateForCurrency(PERI);
					const transferredPeriFinances = toUnit('60000');
					await periFinance.transfer(account1, transferredPeriFinances, {
						from: owner,
					});

					// Setup escrow
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedPeriFinances = toUnit('30000');
					await periFinance.transfer(escrow.address, escrowedPeriFinances, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedPeriFinances,
						{
							from: owner,
						}
					);

					// Issue
					const maxIssuable = await periFinance.maxIssuablePynths(account1);
					await periFinance.issuePynths(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await periFinance.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(transferredPeriFinances, peri2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it("should include escrowed reward periFinance when calculating a user's collateralisation ratio", async () => {
					const peri2usdRate = await exchangeRates.rateForCurrency(PERI);
					const transferredPeriFinances = toUnit('60000');
					await periFinance.transfer(account1, transferredPeriFinances, {
						from: owner,
					});

					const escrowedPeriFinances = toUnit('30000');
					await periFinance.transfer(rewardEscrowV2.address, escrowedPeriFinances, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedPeriFinances, duration, {
						from: account6,
					});

					// Issue
					const maxIssuable = await periFinance.maxIssuablePynths(account1);
					await periFinance.issuePynths(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await periFinance.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(escrowedPeriFinances.add(transferredPeriFinances), peri2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it('should permit user to issue pUSD debt with only escrowed PERI as collateral (no PERI in wallet)', async () => {
					// ensure collateral of account1 is empty
					let collateral = await periFinance.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no PERI balance
					const periBalance = await periFinance.balanceOf(account1);
					assert.bnEqual(periBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await periFinance.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});

					// collateral should include escrowed amount
					collateral = await periFinance.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max pynths. (300 pUSD)
					await periFinance.issueMaxPynths({ from: account1 });

					// There should be 300 pUSD of value for account1
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('300'));
				});

				it('should permit user to issue pUSD debt with only reward escrow as collateral (no PERI in wallet)', async () => {
					// ensure collateral of account1 is empty
					let collateral = await periFinance.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no PERI balance
					const periBalance = await periFinance.balanceOf(account1);
					assert.bnEqual(periBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await periFinance.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});

					// collateral now should include escrowed amount
					collateral = await periFinance.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max pynths. (300 pUSD)
					await periFinance.issueMaxPynths({ from: account1 });

					// There should be 300 pUSD of value for account1
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('300'));
				});

				it("should permit anyone checking another user's collateral", async () => {
					const amount = toUnit('60000');
					await periFinance.transfer(account1, amount, { from: owner });
					const collateral = await periFinance.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount);
				});

				it("should not include escrowed periFinance when checking a user's collateral", async () => {
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedAmount = toUnit('15000');
					await periFinance.transfer(escrow.address, escrowedAmount, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedAmount,
						{
							from: owner,
						}
					);

					const amount = toUnit('60000');
					await periFinance.transfer(account1, amount, { from: owner });
					const collateral = await periFinance.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount);
				});

				it("should include escrowed reward periFinance when checking a user's collateral", async () => {
					const escrowedAmount = toUnit('15000');
					await periFinance.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});
					const amount = toUnit('60000');
					await periFinance.transfer(account1, amount, { from: owner });
					const collateral = await periFinance.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount.add(escrowedAmount));
				});

				it("should calculate a user's remaining issuable pynths", async () => {
					const transferredPeriFinances = toUnit('60000');
					await periFinance.transfer(account1, transferredPeriFinances, {
						from: owner,
					});

					// Issue
					const maxIssuable = await periFinance.maxIssuablePynths(account1);
					const issued = maxIssuable.div(web3.utils.toBN(3));
					await periFinance.issuePynths(issued, { from: account1 });
					const expectedRemaining = maxIssuable.sub(issued);
					const issuablePynths = await issuer.remainingIssuablePynths(account1);
					assert.bnEqual(expectedRemaining, issuablePynths.maxIssuable);
				});

				it("should correctly calculate a user's max issuable pynths with escrowed periFinance", async () => {
					const peri2usdRate = await exchangeRates.rateForCurrency(PERI);
					const transferredPeriFinances = toUnit('60000');
					await periFinance.transfer(account1, transferredPeriFinances, {
						from: owner,
					});

					// Setup escrow
					const escrowedPeriFinances = toUnit('30000');
					await periFinance.transfer(rewardEscrowV2.address, escrowedPeriFinances, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedPeriFinances, duration, {
						from: account6,
					});

					const maxIssuable = await periFinance.maxIssuablePynths(account1);
					// await periFinance.issuePynths(maxIssuable, { from: account1 });

					// Compare
					const issuanceRatio = await systemSettings.issuanceRatio();
					const expectedMaxIssuable = multiplyDecimal(
						multiplyDecimal(escrowedPeriFinances.add(transferredPeriFinances), peri2usdRate),
						issuanceRatio
					);
					assert.bnEqual(maxIssuable, expectedMaxIssuable);
				});
			});

			describe('issue and burn on behalf', async () => {
				const authoriser = account1;
				const delegate = account2;

				beforeEach(async () => {
					// Assign the authoriser PERI
					await periFinance.transfer(authoriser, toUnit('20000'), {
						from: owner,
					});
					await updateAggregatorRates(exchangeRates, circuitBreaker, [PERI], [toUnit('1')]);
					await updateDebtMonitors();
				});
				describe('when not approved it should revert on', async () => {
					it('issueMaxPynthsOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: periFinance.issueMaxPynthsOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('issuePynthsOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: periFinance.issuePynthsOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnPynthsOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: periFinance.burnPynthsOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnPynthsToTargetOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: periFinance.burnPynthsToTargetOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
				});

				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							// ensure user has pynths to burn
							await periFinance.issuePynths(toUnit('1000'), { from: authoriser });
							await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
							await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling issuePynthsOnBehalf() reverts', async () => {
							await assert.revert(
								periFinance.issuePynthsOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling issueMaxPynthsOnBehalf() reverts', async () => {
							await assert.revert(
								periFinance.issueMaxPynthsOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnPynthsOnBehalf() reverts', async () => {
							await assert.revert(
								periFinance.burnPynthsOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnPynthsToTargetOnBehalf() reverts', async () => {
							await assert.revert(
								periFinance.burnPynthsToTargetOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});

						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false });
							});
							it('then calling issuePynthsOnBehalf() succeeds', async () => {
								await periFinance.issuePynthsOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling issueMaxPynthsOnBehalf() succeeds', async () => {
								await periFinance.issueMaxPynthsOnBehalf(authoriser, { from: delegate });
							});
							it('and calling burnPynthsOnBehalf() succeeds', async () => {
								await periFinance.burnPynthsOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling burnPynthsToTargetOnBehalf() succeeds', async () => {
								// need the user to be undercollaterized for this to succeed
								await updateAggregatorRates(
									exchangeRates,
									circuitBreaker,
									[PERI],
									[toUnit('0.001')]
								);
								await updateDebtMonitors();

								await periFinance.burnPynthsToTargetOnBehalf(authoriser, { from: delegate });
							});
						});
					});
				});

				it('should approveIssueOnBehalf for account1', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canIssueFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveBurnOnBehalf for account1', async () => {
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canBurnFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveIssueOnBehalf and IssueMaxPynths', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					const pUSDBalanceBefore = await pUSDContract.balanceOf(account1);
					const issuablePynths = await periFinance.maxIssuablePynths(account1);

					await periFinance.issueMaxPynthsOnBehalf(authoriser, { from: delegate });
					const pUSDBalanceAfter = await pUSDContract.balanceOf(account1);
					assert.bnEqual(pUSDBalanceAfter, pUSDBalanceBefore.add(issuablePynths));
				});
				it('should approveIssueOnBehalf and IssuePynths', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					await periFinance.issuePynthsOnBehalf(authoriser, toUnit('100'), { from: delegate });

					const pUSDBalance = await pUSDContract.balanceOf(account1);
					assert.bnEqual(pUSDBalance, toUnit('100'));
				});
				it('should approveBurnOnBehalf and BurnPynths', async () => {
					await periFinance.issueMaxPynths({ from: authoriser });
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					const pUSDBalanceBefore = await pUSDContract.balanceOf(account1);
					await periFinance.burnPynthsOnBehalf(authoriser, pUSDBalanceBefore, { from: delegate });

					const pUSDBalance = await pUSDContract.balanceOf(account1);
					assert.bnEqual(pUSDBalance, toUnit('0'));
				});
				it('should approveBurnOnBehalf and burnPynthsToTarget', async () => {
					await periFinance.issueMaxPynths({ from: authoriser });
					await updateAggregatorRates(exchangeRates, circuitBreaker, [PERI], [toUnit('0.01')]);
					await updateDebtMonitors();

					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					await periFinance.burnPynthsToTargetOnBehalf(authoriser, { from: delegate });

					const pUSDBalanceAfter = await pUSDContract.balanceOf(account1);
					assert.bnEqual(pUSDBalanceAfter, toUnit('40'));
				});
			});

			describe('when Wrapper is set', async () => {
				it('should have zero totalIssuedPynths', async () => {
					assert.bnEqual(
						await periFinance.totalIssuedPynths(pUSD),
						await periFinance.totalIssuedPynthsExcludeOtherCollateral(pUSD)
					);
				});
				describe('depositing WETH on the Wrapper to issue pETH', async () => {
					let etherWrapper;
					beforeEach(async () => {
						// mock etherWrapper
						etherWrapper = await MockEtherWrapper.new({ from: owner });
						await addressResolver.importAddresses(
							[toBytes32('EtherWrapper')],
							[etherWrapper.address],
							{ from: owner }
						);

						// ensure DebtCache has the latest EtherWrapper
						await debtCache.rebuildCache();
					});

					it('should be able to exclude pETH issued by EtherWrapper from totalIssuedPynths', async () => {
						const totalSupplyBefore = await periFinance.totalIssuedPynths(pETH);

						const amount = toUnit('10');

						await etherWrapper.setTotalIssuedPynths(amount, { from: account1 });

						// totalSupply of pynths should exclude Wrapper issued pETH
						assert.bnEqual(
							totalSupplyBefore,
							await periFinance.totalIssuedPynthsExcludeOtherCollateral(pETH)
						);

						// totalIssuedPynths after includes amount issued
						const { rate } = await exchangeRates.rateAndInvalid(pETH);
						assert.bnEqual(
							await periFinance.totalIssuedPynths(pETH),
							totalSupplyBefore.add(divideDecimalRound(amount, rate))
						);
					});
				});
			});

			describe('burnForRedemption', () => {
				it('only allowed by the pynth redeemer', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: issuer.burnForRedemption,
						args: [ZERO_ADDRESS, ZERO_ADDRESS, toUnit('1')],
						accounts: [
							owner,
							account1,
							account2,
							account3,
							account6,
							account7,
							periFinanceBridgeToOptimism,
						],
						reason: 'Only PynthRedeemer',
					});
				});
				describe('when a user has 100 pETH', () => {
					beforeEach(async () => {
						await pETHContract.issue(account1, toUnit('100'));
						await updateDebtMonitors();
					});
					describe('when burnForRedemption is invoked on the user for 75 pETH', () => {
						beforeEach(async () => {
							// spoof the pynth redeemer
							await addressResolver.importAddresses([toBytes32('PynthRedeemer')], [account6], {
								from: owner,
							});
							// rebuild the resolver cache in the issuer
							await issuer.rebuildCache();
							// now invoke the burn
							await issuer.burnForRedemption(await pETHContract.proxy(), account1, toUnit('75'), {
								from: account6,
							});
						});
						it('then the user has 25 pETH remaining', async () => {
							assert.bnEqual(await pETHContract.balanceOf(account1), toUnit('25'));
						});
					});
				});
			});

			describe('debt shares integration', async () => {
				let aggTDR;

				beforeEach(async () => {
					// create aggregator mocks
					aggTDR = await MockAggregator.new({ from: owner });

					// Set debt ratio oracle value
					await aggTDR.setLatestAnswer(toPreciseUnit('0.4'), await currentTime());

					await addressResolver.importAddresses(
						[toBytes32('ext:AggregatorDebtRatio')],
						[aggTDR.address],
						{
							from: owner,
						}
					);

					// rebuild the resolver cache in the issuer
					await issuer.rebuildCache();

					// issue some initial debt to work with
					await periFinance.issuePynths(toUnit('100'), { from: owner });

					// send test user some peri so he can mint too
					await periFinance.transfer(account1, toUnit('1000000'), { from: owner });
				});

				it('mints the correct number of debt shares', async () => {
					// Issue pynths
					await periFinance.issuePynths(toUnit('100'), { from: account1 });
					assert.bnEqual(await debtShares.balanceOf(account1), toUnit('250')); // = 100 / 0.4
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('100'));
				});

				it('burns the correct number of debt shares', async () => {
					await periFinance.issuePynths(toUnit('300'), { from: account1 });
					await periFinance.burnPynths(toUnit('30'), { from: account1 });
					assert.bnEqual(await debtShares.balanceOf(account1), toUnit('675')); // = 270 / 0.4
					assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('270'));
				});

				describe('when debt ratio changes', () => {
					beforeEach(async () => {
						// user mints and gets 300 susd / 0.4 = 750 debt shares
						await periFinance.issuePynths(toUnit('300'), { from: account1 });

						// Debt ratio oracle value is updated
						await aggTDR.setLatestAnswer(toPreciseUnit('0.6'), await currentTime());
					});

					it('has adjusted debt', async () => {
						assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('450')); // = 750 sds * 0.6
					});

					it('mints at adjusted rate', async () => {
						await periFinance.issuePynths(toUnit('300'), { from: account1 });

						assert.bnEqual(await debtShares.balanceOf(account1), toUnit('1250')); // = 750 (shares from before) + 300 / 0.6
						assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('750')); // = 450 (pUSD from before ) + 300
					});
				});

				describe('issued pynths aggregator', async () => {
					let aggTIS;
					beforeEach(async () => {
						// create aggregator mocks
						aggTIS = await MockAggregator.new({ from: owner });

						// Set issued pynths oracle value
						await aggTIS.setLatestAnswer(toPreciseUnit('1234123412341234'), await currentTime());

						await addressResolver.importAddresses(
							[toBytes32('ext:AggregatorIssuedPynths')],
							[aggTIS.address],
							{
								from: owner,
							}
						);
					});

					it('has no effect on mint or burn', async () => {
						// user mints and gets 300 susd  / 0.4 = 750 debt shares
						await periFinance.issuePynths(toUnit('300'), { from: account1 });
						// user burns 30 susd / 0.4 = 75 debt shares
						await periFinance.burnPynths(toUnit('30'), { from: account1 });
						assert.bnEqual(await debtShares.balanceOf(account1), toUnit('675')); // 750 - 75 sds
						assert.bnEqual(await periFinance.debtBalanceOf(account1, pUSD), toUnit('270')); // 300 - 30 susd
					});
				});
			});

			describe('modifyDebtSharesForMigration', () => {
				const debtMigratorOnEthereumMock = account1;
				const debtMigratorOnOptimismMock = account2;
				const fakeMigrator = account3;

				beforeEach(async () => {
					// Import mocked debt migrator addresses to the resolver
					await addressResolver.importAddresses(
						[toBytes32('DebtMigratorOnEthereum'), toBytes32('DebtMigratorOnOptimism')],
						[debtMigratorOnEthereumMock, debtMigratorOnOptimismMock],
						{
							from: owner,
						}
					);

					await issuer.rebuildCache();
				});

				describe('basic protection', () => {
					it('should not allow an invalid migrator address', async () => {
						await assert.revert(
							issuer.modifyDebtSharesForMigration(owner, toUnit(1), { from: fakeMigrator }),
							'only trusted migrators'
						);
					});

					it('should not allow both debt migrators to be set on the same layer', async () => {
						await assert.revert(
							issuer.modifyDebtSharesForMigration(account1, toUnit(100), {
								from: debtMigratorOnEthereumMock,
							}),
							'one migrator must be 0x0'
						);
					});
				});

				describe('modifying debt share balance for migration', () => {
					describe('on L1', () => {
						let beforeDebtShareBalance;
						const amountToBurn = toUnit(10);

						beforeEach(async () => {
							// Make sure one of the debt migrators is 0x
							// (in this case it's the Optimism migrator)
							await addressResolver.importAddresses(
								[toBytes32('DebtMigratorOnOptimism')],
								[ZERO_ADDRESS],
								{
									from: owner,
								}
							);
							await issuer.rebuildCache();

							// Give some PERI to the mock migrator
							await periFinance.transfer(debtMigratorOnEthereumMock, toUnit('1000'), { from: owner });

							// issue max pUSD
							const maxPynths = await periFinance.maxIssuablePynths(debtMigratorOnEthereumMock);
							await periFinance.issuePynths(maxPynths, { from: debtMigratorOnEthereumMock });

							// get before value
							beforeDebtShareBalance = await debtShares.balanceOf(debtMigratorOnEthereumMock);

							// call modify debt shares
							await issuer.modifyDebtSharesForMigration(debtMigratorOnEthereumMock, amountToBurn, {
								from: debtMigratorOnEthereumMock,
							});
						});

						it('burns the expected amount of debt shares', async () => {
							assert.bnEqual(
								await debtShares.balanceOf(debtMigratorOnEthereumMock),
								beforeDebtShareBalance.sub(amountToBurn)
							);
						});
					});
					describe('on L2', () => {
						let beforeDebtShareBalance;
						const amountToMint = toUnit(10);

						beforeEach(async () => {
							// Make sure one of the debt migrators is 0x
							// (in this case it's the Ethereum migrator)
							await addressResolver.importAddresses(
								[toBytes32('DebtMigratorOnEthereum')],
								[ZERO_ADDRESS],
								{
									from: owner,
								}
							);
							await issuer.rebuildCache();

							// get before value
							beforeDebtShareBalance = await debtShares.balanceOf(debtMigratorOnOptimismMock);

							// call modify debt shares
							await issuer.modifyDebtSharesForMigration(debtMigratorOnOptimismMock, amountToMint, {
								from: debtMigratorOnOptimismMock,
							});
						});

						it('mints the expected amount of debt shares', async () => {
							assert.bnEqual(
								await debtShares.balanceOf(debtMigratorOnOptimismMock),
								beforeDebtShareBalance.add(amountToMint)
							);
						});
					});
				});
			});
		});
	});
});
