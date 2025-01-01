import { parseEther } from 'ethers/lib/utils'
import { assert, expect } from 'chai'
import { BundlerReputationParams, ReputationManager } from '../src/modules/ReputationManager'
import {
  AddressZero,
  getUserOpHash,
  packUserOp,
  UserOperation,
  deployEntryPoint, IEntryPoint, DeterministicDeployer
} from '@account-abstraction/utils'

import { ValidationManager, supportsDebugTraceCall } from '@account-abstraction/validation-manager'
import { MempoolManager } from '../src/modules/MempoolManager'
import { BundleManager } from '../src/modules/BundleManager'
import { ethers } from 'hardhat'
import { BundlerConfig } from '../src/BundlerConfig'
import { TestFakeWalletToken__factory } from '../src/types'
import { UserOpMethodHandler } from '../src/UserOpMethodHandler'
import { ExecutionManager } from '../src/modules/ExecutionManager'
import { EventsManager } from '../src/modules/EventsManager'
import { createSigner } from './testUtils'

import { BigNumber } from 'ethers'
import sinon from 'sinon'

describe('#BundlerManager', () => {
  let bm: BundleManager

  let entryPoint: IEntryPoint

  const provider = ethers.provider
  const signer = provider.getSigner()

  before(async function () {
    entryPoint = await deployEntryPoint(provider)
    DeterministicDeployer.init(provider)

    const config: BundlerConfig = {
      beneficiary: await signer.getAddress(),
      entryPoint: entryPoint.address,
      gasFactor: '0.2',
      minBalance: '0',
      mnemonic: '',
      network: '',
      port: '3000',
      unsafe: !await supportsDebugTraceCall(provider as any),
      autoBundleInterval: 0,
      autoBundleMempoolSize: 0,
      maxBundleGas: 5e6,
      // minstake zero, since we don't fund deployer.
      minStake: '0',
      minUnstakeDelay: 0,
      conditionalRpc: false
    }

    const repMgr = new ReputationManager(provider, BundlerReputationParams, parseEther(config.minStake), config.minUnstakeDelay)
    const mempoolMgr = new MempoolManager(repMgr)
    const validMgr = new ValidationManager(entryPoint, config.unsafe)
    const evMgr = new EventsManager(entryPoint, mempoolMgr, repMgr)
    bm = new BundleManager(entryPoint, evMgr, mempoolMgr, validMgr, repMgr, config.beneficiary, parseEther(config.minBalance), config.maxBundleGas, config.conditionalRpc)
  })

  it('#getUserOpHashes', async () => {
    const userOp: UserOperation = {
      sender: AddressZero,
      nonce: 1,
      signature: '0x03',
      callData: '0x05',
      callGasLimit: 6,
      verificationGasLimit: 7,
      maxFeePerGas: 8,
      maxPriorityFeePerGas: 9,
      preVerificationGas: 10
    }

    const hash = await entryPoint.getUserOpHash(packUserOp(userOp))
    const bmHash = await bm.getUserOpHashes([userOp])
    expect(bmHash).to.eql([hash])
  })

  describe('createBundle', function () {
    let methodHandler: UserOpMethodHandler
    let bundleMgr: BundleManager

    before(async function () {
      const bundlerSigner = await createSigner()
      const _entryPoint = entryPoint.connect(bundlerSigner)
      const config: BundlerConfig = {
        beneficiary: await bundlerSigner.getAddress(),
        entryPoint: _entryPoint.address,
        gasFactor: '0.2',
        minBalance: '0',
        mnemonic: '',
        network: '',
        port: '3000',
        unsafe: !await supportsDebugTraceCall(provider as any),
        conditionalRpc: false,
        autoBundleInterval: 0,
        autoBundleMempoolSize: 0,
        maxBundleGas: 5e6,
        // minstake zero, since we don't fund deployer.
        minStake: '0',
        minUnstakeDelay: 0
      }
      const repMgr = new ReputationManager(provider, BundlerReputationParams, parseEther(config.minStake), config.minUnstakeDelay)
      const mempoolMgr = new MempoolManager(repMgr)
      const validMgr = new ValidationManager(_entryPoint, config.unsafe)
      const evMgr = new EventsManager(_entryPoint, mempoolMgr, repMgr)
      bundleMgr = new BundleManager(_entryPoint, evMgr, mempoolMgr, validMgr, repMgr, config.beneficiary, parseEther(config.minBalance), config.maxBundleGas, false)
      const execManager = new ExecutionManager(repMgr, mempoolMgr, bundleMgr, validMgr)
      execManager.setAutoBundler(0, 1000)

      methodHandler = new UserOpMethodHandler(
        execManager,
        provider,
        bundlerSigner,
        config,
        _entryPoint
      )
    })

    it('should not include a UserOp that accesses the storage of a different known sender', async function () {
      if (!await supportsDebugTraceCall(ethers.provider)) {
        console.log('WARNING: opcode banning tests can only run with geth')
        this.skip()
      }

      const wallet1 = await new TestFakeWalletToken__factory(signer).deploy(entryPoint.address)
      const wallet2 = await new TestFakeWalletToken__factory(signer).deploy(entryPoint.address)

      await wallet1.sudoSetBalance(wallet1.address, parseEther('1'))
      await wallet1.sudoSetBalance(wallet2.address, parseEther('1'))
      await wallet2.sudoSetAnotherWallet(wallet1.address)
      const calldata1 = wallet2.address
      const calldata2 = '0x'

      const cEmptyUserOp: UserOperation = {
        sender: AddressZero,
        nonce: '0x0',
        signature: '0x',
        callData: '0x',
        callGasLimit: '0x0',
        verificationGasLimit: '0x50000',
        maxFeePerGas: '0x0',
        maxPriorityFeePerGas: '0x0',
        preVerificationGas: '0x50000'
      }
      const userOp1: UserOperation = {
        ...cEmptyUserOp,
        sender: wallet1.address,
        callData: calldata1
      }
      const userOp2: UserOperation = {
        ...cEmptyUserOp,
        sender: wallet2.address,
        callData: calldata2
      }
      await methodHandler.sendUserOperation(userOp1, entryPoint.address)
      await methodHandler.sendUserOperation(userOp2, entryPoint.address)

      const bundle = await bundleMgr.sendNextBundle()
      await bundleMgr.handlePastEvents()
      const mempool = bundleMgr.mempoolManager.getSortedForInclusion()

      assert.equal(bundle!.userOpHashes.length, 1)
      assert.equal(bundle!.userOpHashes[0], getUserOpHash(userOp1, entryPoint.address, await signer.getChainId()))
      assert.equal(mempool.length, 1)
      assert.equal(mempool[0].userOp.sender, wallet2.address)
    })
  })
})

describe('BundleManager Fee Management', () => {
  let bundleManager: BundleManager
  let mockProvider: any
  let mockSigner: any

  beforeEach(async () => {
    // Create mocks
    mockProvider = {
      getBlock: sinon.stub().resolves({
        baseFeePerGas: BigNumber.from(100000000) // 0.1 gwei
      }),
      getGasPrice: sinon.stub().resolves(BigNumber.from(200000000)), // 0.2 gwei
      _network: { chainId: 1 },
      send: sinon.stub(),
      waitForTransaction: sinon.stub().resolves({ transactionHash: '0x123' })
    }

    mockSigner = {
      getAddress: sinon.stub().resolves('0x123'),
      getTransactionCount: sinon.stub().resolves(0),
      sendTransaction: sinon.stub().resolves({ hash: '0x123' })
    }

    // Create test instance with mocked provider
    const mockEntryPoint = {
      provider: mockProvider,
      signer: mockSigner,
      populateTransaction: {
        handleOps: sinon.stub().resolves({ hash: '0x123' })
      }
    } as any

    bundleManager = new BundleManager(
      mockEntryPoint,
      {} as any, // eventsManager
      {} as any, // mempoolManager
      {} as any, // validationManager
      {} as any, // reputationManager
      '0x123', // beneficiary
      '1000000000000000000', // minSignerBalance
      5e6, // maxBundleGas
      false, // conditionalRpc
      false, // mergeToAccountRootHash
      1.2 // gasFactor
    )
  })

  describe('getFeeData', () => {
    it('should return initial fees without any failed attempts', async () => {
      mockProvider.send.resolves(BigNumber.from(50000000)) // 0.05 gwei priority fee

      const result = await bundleManager.getFeeData()

      expect(result.maxPriorityFeePerGas.toString()).to.equal('50000000')
      expect(result.maxFeePerGas.toString()).to.equal('170000000') // baseFee * 1.2 + priorityFee
    })

    it('should increase priority fee after failed attempt', async () => {
      mockProvider.send.resolves(BigNumber.from(50000000))
      bundleManager.transactionAttempts = 1

      const result = await bundleManager.getFeeData()

      expect(result.maxPriorityFeePerGas.toString()).to.equal('55000000'.toString())
    })

    it('should cap priority fee increases at maxPriorityFeeRetries', async () => {
      mockProvider.send.resolves(BigNumber.from(50000000).toHexString())
      bundleManager.transactionAttempts = 20 // More than maxPriorityFeeRetries

      const result = await bundleManager.getFeeData()

      expect(result.maxPriorityFeePerGas.toString()).to.equal('100000000'.toString())
    })

    it('should handle eth_maxPriorityFeePerGas not supported', async () => {
      mockProvider.send.rejects(new Error('Method not supported'))

      const result = await bundleManager.getFeeData()

      // Should fall back to gasPrice - baseFeePerGas
      expect(result.maxPriorityFeePerGas.toString()).to.equal('100000000') // 0.2 - 0.1 gwei
    })

    it('should reset priority fee after successful transaction', async () => {
      mockProvider.send.resolves(BigNumber.from(50000000))
      bundleManager.transactionAttempts = 3

      // Simulate successful transaction
      await bundleManager.sendBundle([], '0x123', {})

      const result = await bundleManager.getFeeData()
      expect(result.maxPriorityFeePerGas.toString()).to.equal('50000000')
      expect(bundleManager.transactionAttempts).to.equal(0)
    })

    it('should handle zero base fee', async () => {
      mockProvider.getBlock.resolves({ baseFeePerGas: BigNumber.from(0) })
      mockProvider.send.resolves(BigNumber.from(50000000))

      const result = await bundleManager.getFeeData()

      expect(result.maxFeePerGas.toString()).to.equal('50000000') // Just priority fee
    })

    it('should handle negative priority fee calculation', async () => {
      mockProvider.getBlock.resolves({ baseFeePerGas: BigNumber.from(300000000) }) // Higher than gas price
      mockProvider.send.rejects(new Error('Method not supported'))

      const result = await bundleManager.getFeeData()

      expect(result.maxPriorityFeePerGas.toString()).to.equal('0')
    })
  })
})
