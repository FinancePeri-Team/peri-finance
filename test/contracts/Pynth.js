'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const MockExchanger = artifacts.require('MockExchanger');
const Pynth = artifacts.require('Pynth');

const { setupAllContracts } = require('./setup');

const { currentTime, toUnit, bytesToString } = require('../utils')();
const {
	issuePynthsToUser,
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	setStatus,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('Pynth', async accounts => {
	const [pUSD, PERI, pEUR] = ['pUSD', 'PERI', 'pEUR'].map(toBytes32);

	const [deployerAccount, owner, , , account1, account2] = accounts;

	let feePool,
		FEE_ADDRESS,
		periFinance,
		exchangeRates,
		pUSDProxy,
		pUSDImpl,
		addressResolver,
		systemStatus,
		systemSettings,
		exchanger,
		debtCache,
		issuer,
		stakingState,
		externalTokenStakeManager;
	// bridgeStatepUSD;

	before(async () => {
		({
			AddressResolver: addressResolver,
			PeriFinance: periFinance,
			ExchangeRates: exchangeRates,
			FeePool: feePool,
			SystemStatus: systemStatus,
			Pynth: pUSDImpl,
			ProxyERC20Pynth: pUSDProxy,
			Exchanger: exchanger,
			DebtCache: debtCache,
			Issuer: issuer,
			SystemSettings: systemSettings,
			StakingState: stakingState,
			ExternalTokenStakeManager: externalTokenStakeManager,
			// BridgeStatepUSD: bridgeStatepUSD,
		} = await setupAllContracts({
			accounts,
			contracts: [
				'Pynth',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage', // required for Exchanger/FeePool to access the pynth exchange fee rates
				'PeriFinance',
				'SystemStatus',
				'AddressResolver',
				'DebtCache',
				'Issuer', // required to issue via PeriFinance
				'Exchanger', // required to exchange into pUSD when transferring to the FeePool
				'SystemSettings',
				'FlexibleStorage',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral() to read collateral
				'ExternalTokenStakeManager',
				'StakingState',
				'CrossChainManager',
			],
		}));

		await setupPriceAggregators(exchangeRates, owner, [pEUR]);

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		// use implementation ABI on the proxy address to simplify calling
		pUSDProxy = await Pynth.at(pUSDProxy.address);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		// Send a price update to guarantee we're not stale.
		await updateAggregatorRates(exchangeRates, null, [PERI], ['0.1'].map(toUnit));
		await debtCache.takeDebtSnapshot();

		// set default issuanceRatio to 0.2
		await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
	});

	it('should set constructor params on deployment', async () => {
		const pynth = await Pynth.new(
			account1,
			account2,
			'Pynth XYZ',
			'sXYZ',
			owner,
			toBytes32('sXYZ'),
			web3.utils.toWei('100'),
			addressResolver.address,
			{ from: deployerAccount }
		);

		assert.equal(await pynth.proxy(), account1);
		assert.equal(await pynth.tokenState(), account2);
		assert.equal(await pynth.name(), 'Pynth XYZ');
		assert.equal(await pynth.symbol(), 'sXYZ');
		assert.bnEqual(await pynth.decimals(), 18);
		assert.equal(await pynth.owner(), owner);
		assert.equal(bytesToString(await pynth.currencyKey()), 'sXYZ');
		assert.bnEqual(await pynth.totalSupply(), toUnit('100'));
		assert.equal(await pynth.resolver(), addressResolver.address);
	});

	describe('mutative functions and access', () => {
		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: pUSDImpl.abi,
				ignoreParents: ['ExternStateToken', 'MixinResolver'],
				expected: [
					'issue',
					'burn',
					'setTotalSupply',
					'transfer',
					'transferAndSettle',
					'transferFrom',
					'transferFromAndSettle',
				],
			});
		});

		describe('when non-internal contract tries to issue', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: pUSDProxy.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
				await onlyGivenAddressCanInvoke({
					fnc: pUSDImpl.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
			});
		});
		describe('when non-internal tries to burn', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: pUSDProxy.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
				await onlyGivenAddressCanInvoke({
					fnc: pUSDImpl.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
			});
		});

		// SIP-238
		describe('implementation does not allow transfers but allows approve', () => {
			const amount = toUnit('10000');
			const revertMsg = 'Only the proxy';
			beforeEach(async () => {
				// ensure owner has funds
				await periFinance.issuePynths(amount, { from: owner });

				// approve for transferFrom to work
				await pUSDProxy.approve(account1, amount, { from: owner });
			});
			it('approve does not revert', async () => {
				await pUSDImpl.approve(account1, amount, { from: owner });
			});
			it('transfer reverts', async () => {
				await assert.revert(pUSDImpl.transfer(account1, amount, { from: owner }), revertMsg);
			});
			it('transferFrom reverts', async () => {
				await assert.revert(
					pUSDImpl.transferFrom(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferAndSettle reverts', async () => {
				await assert.revert(
					pUSDImpl.transferAndSettle(account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferFromAndSettle reverts', async () => {
				await assert.revert(
					pUSDImpl.transferFromAndSettle(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});

			it('transfer does not revert from a whitelisted contract', async () => {
				// set owner as PynthRedeemer
				await addressResolver.importAddresses(['PynthRedeemer'].map(toBytes32), [owner], {
					from: owner,
				});
				await pUSDImpl.transfer(account1, amount, { from: owner });
			});
		});
	});

	describe('suspension conditions on transfers', () => {
		const amount = toUnit('10000');
		beforeEach(async () => {
			// ensure owner has funds
			await periFinance.issuePynths(amount, { from: owner });

			// approve for transferFrom to work
			await pUSDProxy.approve(account1, amount, { from: owner });
		});

		['System', 'Pynth'].forEach(section => {
			describe(`when ${section} is suspended`, () => {
				const pynth = toBytes32('pUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section, suspend: true, pynth });
				});
				it('when transfer() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						pUSDProxy.transfer(account1, amount, {
							from: owner,
						}),
						'Operation prohibited'
					);
				});
				it('when transferFrom() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						pUSDProxy.transferFrom(owner, account1, amount, {
							from: account1,
						}),
						'Operation prohibited'
					);
				});
				describe('when the system is resumed', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: false, pynth });
					});
					it('when transfer() is invoked, it works as expected', async () => {
						await pUSDProxy.transfer(account1, amount, {
							from: owner,
						});
					});
					it('when transferFrom() is invoked, it works as expected', async () => {
						await pUSDProxy.transferFrom(owner, account1, amount, {
							from: account1,
						});
					});
				});
			});
		});
		describe('when pETH is suspended', () => {
			const pynth = toBytes32('pETH');
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'Pynth', pynth, suspend: true });
			});
			it('when transfer() is invoked for pUSD, it works as expected', async () => {
				await pUSDProxy.transfer(account1, amount, {
					from: owner,
				});
			});
			it('when transferFrom() is invoked for pUSD, it works as expected', async () => {
				await pUSDProxy.transferFrom(owner, account1, amount, {
					from: account1,
				});
			});
			describe('when pUSD is suspended for exchanging', () => {
				const pynth = toBytes32('pUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'PynthExchange', pynth, suspend: true });
				});
				it('when transfer() is invoked for pUSD, it works as expected', async () => {
					await pUSDProxy.transfer(account1, amount, {
						from: owner,
					});
				});
				it('when transferFrom() is invoked for pETH, it works as expected', async () => {
					await pUSDProxy.transferFrom(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});
	});

	it('should transfer (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 pUSD.
		const amount = toUnit('10000');
		await periFinance.issuePynths(amount, { from: owner });

		// Do a single transfer of all our pUSD.
		const transaction = await pUSDProxy.transfer(account1, amount, {
			from: owner,
		});

		// Events should be a fee exchange and a transfer to account1
		assert.eventEqual(
			transaction,
			// The original pynth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await pUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await pUSDProxy.balanceOf(account1), amount);
	});

	it('should revert when transferring (ERC20) with insufficient balance', async () => {
		// Issue 10,000 pUSD.
		const amount = toUnit('10000');
		await periFinance.issuePynths(amount, { from: owner });

		// Try to transfer 10,000 + 1 wei, which we don't have the balance for.
		await assert.revert(
			pUSDProxy.transfer(account1, amount.add(web3.utils.toBN('1')), { from: owner })
		);
	});

	it('should transferFrom (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 pUSD.
		const amount = toUnit('10000');
		await periFinance.issuePynths(amount, { from: owner });

		// Give account1 permission to act on our behalf
		await pUSDProxy.approve(account1, amount, { from: owner });

		// Do a single transfer of all our pUSD.
		const transaction = await pUSDProxy.transferFrom(owner, account1, amount, {
			from: account1,
		});

		// Events should be a transfer to account1
		assert.eventEqual(
			transaction,
			// The original pynth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await pUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await pUSDProxy.balanceOf(account1), amount);

		// And allowance should be exhausted
		assert.bnEqual(await pUSDProxy.allowance(owner, account1), 0);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient allowance', async () => {
		// Issue 10,000 pUSD.
		const amount = toUnit('10000');
		await periFinance.issuePynths(amount, { from: owner });

		// Approve for 1 wei less than amount
		await pUSDProxy.approve(account1, amount.sub(web3.utils.toBN('1')), {
			from: owner,
		});

		// Try to transfer 10,000, which we don't have the allowance for.
		await assert.revert(
			pUSDProxy.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient balance', async () => {
		// Issue 10,000 - 1 wei pUSD.
		const amount = toUnit('10000');
		await periFinance.issuePynths(amount.sub(web3.utils.toBN('1')), { from: owner });

		// Approve for full amount
		await pUSDProxy.approve(account1, amount, { from: owner });

		// Try to transfer 10,000, which we don't have the balance for.
		await assert.revert(
			pUSDProxy.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	describe('invoking issue/burn directly as Issuer', () => {
		beforeEach(async () => {
			// Overwrite PeriFinance address to the owner to allow us to invoke issue on the Pynth
			await addressResolver.importAddresses(['Issuer'].map(toBytes32), [owner], { from: owner });
			// now have the pynth resync its cache
			await pUSDProxy.rebuildCache();
		});
		it('should issue successfully when called by Issuer', async () => {
			const transaction = await pUSDImpl.issue(account1, toUnit('10000'), {
				from: owner,
			});
			assert.eventsEqual(
				transaction,
				'Transfer',
				{
					from: ZERO_ADDRESS,
					to: account1,
					value: toUnit('10000'),
				},
				'Issued',
				{
					account: account1,
					value: toUnit('10000'),
				}
			);
		});

		it('should burn successfully when called by Issuer', async () => {
			// Issue a bunch of pynths so we can play with them.
			await pUSDImpl.issue(owner, toUnit('10000'), {
				from: owner,
			});
			// await periFinance.issuePynths(toUnit('10000'), { from: owner });

			const transaction = await pUSDImpl.burn(owner, toUnit('10000'), { from: owner });

			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: toUnit('10000') },
				'Burned',
				{ account: owner, value: toUnit('10000') }
			);
		});
	});

	it('should transfer (ERC20) with no fee', async () => {
		// Issue 10,000 pUSD.
		const amount = toUnit('10000');

		await periFinance.issuePynths(amount, { from: owner });

		// Do a single transfer of all our pUSD.
		const transaction = await pUSDProxy.transfer(account1, amount, {
			from: owner,
		});

		// Event should be only a transfer to account1
		assert.eventEqual(
			transaction,

			// The original pynth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await pUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await pUSDProxy.balanceOf(account1), amount);

		// The fee pool should have zero balance
		assert.bnEqual(await pUSDProxy.balanceOf(FEE_ADDRESS), 0);
	});

	describe('transfer / transferFrom And Settle', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 1,000 pUSD.
			amount = toUnit('1000');

			await periFinance.issuePynths(amount, { from: owner });
		});

		describe('suspension conditions', () => {
			beforeEach(async () => {
				// approve for transferFrom to work
				await pUSDProxy.approve(account1, amount, { from: owner });
			});

			['System', 'Pynth'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					const pynth = toBytes32('pUSD');
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true, pynth });
					});
					it('when transferAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							pUSDProxy.transferAndSettle(account1, amount, {
								from: owner,
							}),
							'Operation prohibited'
						);
					});
					it('when transferFromAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							pUSDProxy.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							}),
							'Operation prohibited'
						);
					});
					describe('when the system is resumed', () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false, pynth });
						});
						it('when transferAndSettle() is invoked, it works as expected', async () => {
							await pUSDProxy.transferAndSettle(account1, amount, {
								from: owner,
							});
						});
						it('when transferFromAndSettle() is invoked, it works as expected', async () => {
							await pUSDProxy.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when pETH is suspended', () => {
				const pynth = toBytes32('pETH');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'Pynth', pynth, suspend: true });
				});
				it('when transferAndSettle() is invoked for pUSD, it works as expected', async () => {
					await pUSDProxy.transferAndSettle(account1, amount, {
						from: owner,
					});
				});
				it('when transferFromAndSettle() is invoked for pUSD, it works as expected', async () => {
					await pUSDProxy.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});

		describe('with mock exchanger', () => {
			let exchanger;
			beforeEach(async () => {
				// Note: here we have a custom mock for Exchanger
				// this could use GenericMock if we added the ability for generic functions
				// to emit events and listened to those instead (so here, for Exchanger.settle() we'd
				// need to be sure it was invoked during transferAndSettle())
				exchanger = await MockExchanger.new(periFinance.address);

				await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger.address], {
					from: owner,
				});
				// now have periFinance resync its cache
				await periFinance.rebuildCache();
				await pUSDImpl.rebuildCache();
			});
			it('then transferablePynths should be the total amount', async () => {
				assert.bnEqual(await pUSDProxy.transferablePynths(owner), toUnit('1000'));
			});

			describe('when max seconds in waiting period is non-zero', () => {
				beforeEach(async () => {
					await exchanger.setMaxSecsLeft('1');
				});
				it('when the pynth is attempted to be transferred away by the user, it reverts', async () => {
					await assert.revert(
						pUSDProxy.transfer(account1, toUnit('1'), { from: owner }),
						'Cannot transfer during waiting period'
					);
				});
				it('when pEUR is attempted to be transferFrom away by another user, it reverts', async () => {
					await assert.revert(
						pUSDProxy.transferFrom(owner, account2, toUnit('1'), { from: account1 }),
						'Cannot transfer during waiting period'
					);
				});
			});

			describe('when reclaim amount is set to 10', async () => {
				const reclaimAmount = toUnit('10');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
				});
				it('then transferablePynths should be the total amount minus the reclaim', async () => {
					assert.bnEqual(await pUSDProxy.transferablePynths(owner), toUnit('990'));
				});
				it('should transfer all and settle 1000 pUSD less reclaim amount', async () => {
					// Do a single transfer of all our pUSD.
					await pUSDProxy.transferAndSettle(account1, amount, {
						from: owner,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await pUSDProxy.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await pUSDProxy.balanceOf(account1), expectedAmountTransferred);
				});
				it('should transferFrom all and settle 1000 pUSD less reclaim amount', async () => {
					// Give account1 permission to act on our behalf
					await pUSDProxy.approve(account1, amount, { from: owner });

					// Do a single transfer of all our pUSD.
					await pUSDProxy.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await pUSDProxy.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await pUSDProxy.balanceOf(account1), expectedAmountTransferred);
				});
				describe('when account has more balance than transfer amount + reclaim', async () => {
					it('should transfer 50 pUSD and burn 10 pUSD', async () => {
						const transferAmount = toUnit('50');
						// Do a single transfer of all our pUSD.
						await pUSDProxy.transferAndSettle(account1, transferAmount, {
							from: owner,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await pUSDProxy.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await pUSDProxy.balanceOf(account1), expectedAmountTransferred);
					});
					it('should transferFrom 50 pUSD and settle reclaim amount', async () => {
						const transferAmount = toUnit('50');

						// Give account1 permission to act on our behalf
						await pUSDProxy.approve(account1, transferAmount, { from: owner });

						// Do a single transferFrom of transferAmount.
						await pUSDProxy.transferFromAndSettle(owner, account1, transferAmount, {
							from: account1,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await pUSDProxy.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await pUSDProxy.balanceOf(account1), expectedAmountTransferred);
					});
				});
			});
			describe('when pynth balance after reclamation is less than requested transfer value', async () => {
				let balanceBefore;
				const reclaimAmount = toUnit('600');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
					balanceBefore = await pUSDProxy.balanceOf(owner);
				});
				describe('when reclaim 600 pUSD and attempting to transfer 500 pUSD pynths', async () => {
					// original balance is 1000, reclaim 600 and should send 400
					const transferAmount = toUnit('500');

					describe('using regular transfer and transferFrom', () => {
						it('via regular transfer it reverts', async () => {
							await assert.revert(
								pUSDProxy.transfer(account1, transferAmount, {
									from: owner,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
						it('via transferFrom it also reverts', async () => {
							await pUSDProxy.approve(account1, transferAmount, { from: owner });
							await assert.revert(
								pUSDProxy.transferFrom(owner, account1, transferAmount, {
									from: account1,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
					});
					describe('using transferAndSettle', () => {
						it('then transferablePynths should be the total amount', async () => {
							assert.bnEqual(await pUSDProxy.transferablePynths(owner), toUnit('400'));
						});

						it('should transfer remaining balance less reclaimed', async () => {
							// Do a single transfer of all our pUSD.
							await pUSDProxy.transferAndSettle(account1, transferAmount, {
								from: owner,
							});

							// should transfer balanceAfter if less than value
							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await pUSDProxy.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await pUSDProxy.balanceOf(account1), balanceAfterReclaim);
						});
						it('should transferFrom and send balance minus reclaimed amount', async () => {
							// Give account1 permission to act on our behalf
							await pUSDProxy.approve(account1, transferAmount, { from: owner });

							// Do a single transferFrom of transferAmount.
							await pUSDProxy.transferFromAndSettle(owner, account1, transferAmount, {
								from: account1,
							});

							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await pUSDProxy.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await pUSDProxy.balanceOf(account1), balanceAfterReclaim);
						});
					});
				});
			});
		});
	});
	describe('when transferring pynths to FEE_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 pUSD.
			amount = toUnit('10000');

			await periFinance.issuePynths(amount, { from: owner });
		});
		it('should transfer to FEE_ADDRESS and recorded as fee', async () => {
			const feeBalanceBefore = await pUSDProxy.balanceOf(FEE_ADDRESS);

			// Do a single transfer of all our pUSD.
			const transaction = await pUSDProxy.transfer(FEE_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to FEE_ADDRESS
			assert.eventEqual(
				transaction,

				// The original pynth transfer
				'Transfer',
				{ from: owner, to: FEE_ADDRESS, value: amount }
			);

			const firstFeePeriod = await feePool.recentFeePeriods(0);
			// FEE_ADDRESS balance of pUSD increased
			assert.bnEqual(await pUSDProxy.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amount));

			// fees equal to amount are recorded in feesToDistribute
			assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amount));
		});

		describe('when a non-USD pynth exists', () => {
			let pEURImpl, pEURProxy;

			beforeEach(async () => {
				const pEUR = toBytes32('pEUR');

				// create a new pEUR pynth
				({ Pynth: pEURImpl, ProxyERC20Pynth: pEURProxy } = await setupAllContracts({
					accounts,
					existing: {
						ExchangeRates: exchangeRates,
						AddressResolver: addressResolver,
						SystemStatus: systemStatus,
						Issuer: issuer,
						DebtCache: debtCache,
						Exchanger: exchanger,
						FeePool: feePool,
						PeriFinance: periFinance,
					},
					contracts: [{ contract: 'Pynth', properties: { currencyKey: pEUR } }],
				}));

				// Send a price update to guarantee we're not stale.
				await updateAggregatorRates(exchangeRates, null, [pEUR], ['1'].map(toUnit));
				await debtCache.takeDebtSnapshot();

				// use implementation ABI through the proxy
				pEURProxy = await Pynth.at(pEURProxy.address);
			});

			it('when transferring it to FEE_ADDRESS it should exchange into pUSD first before sending', async () => {
				// allocate the user some pEUR
				await issuePynthsToUser({
					owner,
					issuer,
					addressResolver,
					pynthContract: pEURImpl,
					user: owner,
					amount,
					pynth: pEUR,
				});

				// Get balanceOf FEE_ADDRESS
				const feeBalanceBefore = await pUSDProxy.balanceOf(FEE_ADDRESS);

				// balance of pEUR after exchange fees
				const balanceOf = await pEURImpl.balanceOf(owner);

				const amountInUSD = await exchangeRates.effectiveValue(pEUR, balanceOf, pUSD);

				// Do a single transfer of all pEUR to FEE_ADDRESS
				await pEURProxy.transfer(FEE_ADDRESS, balanceOf, {
					from: owner,
				});

				const firstFeePeriod = await feePool.recentFeePeriods(0);

				// FEE_ADDRESS balance of pUSD increased by USD amount given from exchange
				assert.bnEqual(await pUSDProxy.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amountInUSD));

				// fees equal to amountInUSD are recorded in feesToDistribute
				assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amountInUSD));
			});
		});
	});

	describe('when transferring pynths to ZERO_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 pUSD.
			amount = toUnit('1000');

			await periFinance.issuePynths(amount, { from: owner });
		});
		it('should burn the pynths and reduce totalSupply', async () => {
			const balanceBefore = await pUSDProxy.balanceOf(owner);
			const totalSupplyBefore = await pUSDProxy.totalSupply();

			// Do a single transfer of all our pUSD to ZERO_ADDRESS.
			const transaction = await pUSDProxy.transfer(ZERO_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to ZERO_ADDRESS and burn
			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: amount },
				'Burned',
				{ account: owner, value: amount }
			);

			// owner balance should be less amount burned
			assert.bnEqual(await pUSDProxy.balanceOf(owner), balanceBefore.sub(amount));

			// total supply of pynth reduced by amount
			assert.bnEqual(await pUSDProxy.totalSupply(), totalSupplyBefore.sub(amount));
		});
	});
});
