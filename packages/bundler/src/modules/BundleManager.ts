import { MempoolManager } from './MempoolManager'
import { ValidateUserOpResult, ValidationManager } from '@account-abstraction/validation-manager'
import { BigNumber, BigNumberish } from 'ethers'
import { JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers'
import Debug from 'debug'
import { ReputationManager, ReputationStatus } from './ReputationManager'
import { Mutex } from 'async-mutex'
import { GetUserOpHashes__factory } from '../types'
import {
  UserOperation,
  StorageMap,
  mergeStorageMap,
  runContractScript,
  packUserOp, IEntryPoint
} from '@account-abstraction/utils'
import { EventsManager } from './EventsManager'
import { ErrorDescription } from '@ethersproject/abi/lib/interface'

const debug = Debug('aa.exec.cron')

const THROTTLED_ENTITY_BUNDLE_COUNT = 4

export interface SendBundleReturn {
  transactionHash: string
  userOpHashes: string[]
}

export class BundleManager {
  provider: JsonRpcProvider
  signer: JsonRpcSigner
  mutex = new Mutex()
  private readonly FEE_DENOM: number = 100 // For percentage calculations
  public transactionAttempts = 0 // Number of failed attempts or increases
  public readonly priorityFeeIncreaseFactor: number = 10 // 10 would be 10% increase per failure
  public readonly maxPriorityFeeRetries: number = 10 // Maximum number of retries, caps linear increase

  constructor (
    readonly entryPoint: IEntryPoint,
    readonly eventsManager: EventsManager,
    readonly mempoolManager: MempoolManager,
    readonly validationManager: ValidationManager,
    readonly reputationManager: ReputationManager,
    readonly beneficiary: string,
    readonly minSignerBalance: BigNumberish,
    readonly maxBundleGas: number,
    // use eth_sendRawTransactionConditional with storage map
    readonly conditionalRpc: boolean,
    // in conditionalRpc: always put root hash (not specific storage slots) for "sender" entries
    readonly mergeToAccountRootHash: boolean = false,
    /**
     * Gas factor to use for bundler
     */
    readonly gasFactor: number = 1.2
  ) {
    this.provider = entryPoint.provider as JsonRpcProvider
    this.signer = entryPoint.signer as JsonRpcSigner
    debug('gasFactor=', gasFactor)
    if (Number.isNaN(gasFactor) || gasFactor <= 0) {
      throw new Error('gasFactor must be a number > 0')
    }
  }

  /**
   * attempt to send a bundle:
   * collect UserOps from mempool into a bundle
   * send this bundle.
   */
  async sendNextBundle (): Promise<SendBundleReturn | undefined> {
    if (this.mutex.isLocked()) {
      // already running
      return
    }
    return await this.mutex.runExclusive(async () => {
      debug('sendNextBundle')

      // first flush mempool from already-included UserOps, by actively scanning past events.
      await this.handlePastEvents()

      const [bundle, storageMap] = await this.createBundle()
      if (bundle.length === 0) {
        debug('sendNextBundle - no bundle to send')
      } else {
        const beneficiary = await this._selectBeneficiary()
        const ret = await this.sendBundle(bundle, beneficiary, storageMap)
        debug(`sendNextBundle exit - after sent a bundle of ${bundle.length} `)
        return ret
      }
    })
  }

  async handlePastEvents (): Promise<void> {
    await this.eventsManager.handlePastEvents()
  }

  /**
   * submit a bundle.
   * after submitting the bundle, remove all UserOps from the mempool
   * @return SendBundleReturn the transaction and UserOp hashes on successful transaction, or null on failed transaction
   */
  async sendBundle (userOps: UserOperation[], beneficiary: string, storageMap: StorageMap): Promise<SendBundleReturn | undefined> {
    try {
      const feeData = await this.getFeeData().catch(async (e) => {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        debug(`failed to get fee data: ${e}`)
        return await this.provider.getFeeData()
      })
      debug('feeData=', feeData)
      const tx = await this.entryPoint.populateTransaction.handleOps(userOps.map(packUserOp), beneficiary, {
        type: 2,
        nonce: await this.signer.getTransactionCount(),
        gasLimit: 10e6,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0,
        maxFeePerGas: feeData.maxFeePerGas ?? 0
      })
      tx.chainId = this.provider._network.chainId
      let ret: string
      if (this.conditionalRpc) {
        const signedTx = await this.signer.signTransaction(tx)
        debug('eth_sendRawTransactionConditional', storageMap)
        ret = await this.provider.send('eth_sendRawTransactionConditional', [
          signedTx, { knownAccounts: storageMap }
        ])
        debug('eth_sendRawTransactionConditional ret=', ret)
      } else {
        const resp = await this.signer.sendTransaction(tx)
        debug('eth_sendTransaction ret=', resp.hash)
        const rcpt = await this.provider.waitForTransaction(resp.hash, 1, 2_000)
        debug('eth_sendTransaction rcpt=', rcpt.transactionHash)
        ret = rcpt.transactionHash
      }
      // TODO: parse ret, and revert if needed.
      this.transactionAttempts = 0
      debug('ret=', ret)
      debug('sent handleOps with', userOps.length, 'ops. removing from mempool')
      // hashes are needed for debug rpc only.
      const hashes = await this.getUserOpHashes(userOps)
      return {
        transactionHash: ret,
        userOpHashes: hashes
      }
    } catch (e: any) {
      let parsedError: ErrorDescription
      try {
        parsedError = this.entryPoint.interface.parseError((e.data?.data ?? e.data))
      } catch (e1) {
        if ((e as Error)?.message?.includes('replacement fee too low')) {
          console.warn('Failed handleOps, but replacement fee too low', e)
          // Increment failed attempts counter
          this.transactionAttempts = Math.min(this.transactionAttempts + 1, this.maxPriorityFeeRetries)
          return
        }
        this.checkFatal(e)
        console.warn('Failed handleOps, but non-FailedOp error', e)
        return
      }
      const {
        opIndex,
        reason
      } = parsedError.args
      const userOp = userOps[opIndex]
      const reasonStr: string = reason.toString()
      if (reasonStr.startsWith('AA3')) {
        this.reputationManager.crashedHandleOps(userOp.paymaster)
      } else if (reasonStr.startsWith('AA2')) {
        this.reputationManager.crashedHandleOps(userOp.sender)
      } else if (reasonStr.startsWith('AA1')) {
        this.reputationManager.crashedHandleOps(userOp.factory)
      } else {
        this.mempoolManager.removeUserOp(userOp)
        console.warn(`Failed handleOps sender=${userOp.sender} reason=${reasonStr}`)
      }
    }
  }

  // fatal errors we know we can't recover
  checkFatal (e: any): void {
    // console.log('ex entries=',Object.entries(e))
    if (e.error?.code === -32601) {
      throw e
    }
  }

  async createBundle (): Promise<[UserOperation[], StorageMap]> {
    const entries = this.mempoolManager.getSortedForInclusion()
    const bundle: UserOperation[] = []

    // paymaster deposit should be enough for all UserOps in the bundle.
    const paymasterDeposit: { [paymaster: string]: BigNumber } = {}
    // throttled paymasters and deployers are allowed only small UserOps per bundle.
    const stakedEntityCount: { [addr: string]: number } = {}
    // each sender is allowed only once per bundle
    const senders = new Set<string>()

    // all entities that are known to be valid senders in the mempool
    const knownSenders = this.mempoolManager.getKnownSenders()

    const storageMap: StorageMap = {}
    let totalGas = BigNumber.from(0)
    debug('got mempool of ', entries.length)
    // eslint-disable-next-line no-labels
    mainLoop:
    for (const entry of entries) {
      const paymaster = entry.userOp.paymaster
      const factory = entry.userOp.factory
      const paymasterStatus = this.reputationManager.getStatus(paymaster)
      const deployerStatus = this.reputationManager.getStatus(factory)
      if (paymasterStatus === ReputationStatus.BANNED || deployerStatus === ReputationStatus.BANNED) {
        this.mempoolManager.removeUserOp(entry.userOp)
        continue
      }
      // [SREP-030]
      if (paymaster != null && (paymasterStatus === ReputationStatus.THROTTLED ?? (stakedEntityCount[paymaster] ?? 0) > THROTTLED_ENTITY_BUNDLE_COUNT)) {
        debug('skipping throttled paymaster', entry.userOp.sender, entry.userOp.nonce)
        continue
      }
      // [SREP-030]
      if (factory != null && (deployerStatus === ReputationStatus.THROTTLED ?? (stakedEntityCount[factory] ?? 0) > THROTTLED_ENTITY_BUNDLE_COUNT)) {
        debug('skipping throttled factory', entry.userOp.sender, entry.userOp.nonce)
        continue
      }
      if (senders.has(entry.userOp.sender)) {
        debug('skipping already included sender', entry.userOp.sender, entry.userOp.nonce)
        // allow only a single UserOp per sender per bundle
        continue
      }
      let validationResult: ValidateUserOpResult
      try {
        // re-validate UserOp. no need to check stake, since it cannot be reduced between first and 2nd validation
        validationResult = await this.validationManager.validateUserOp(entry.userOp, entry.referencedContracts, false)
      } catch (e: any) {
        debug('failed 2nd validation:', e.message)
        // failed validation. don't try anymore
        this.mempoolManager.removeUserOp(entry.userOp)
        continue
      }

      for (const storageAddress of Object.keys(validationResult.storageMap)) {
        if (
          storageAddress.toLowerCase() !== entry.userOp.sender.toLowerCase() &&
            knownSenders.includes(storageAddress.toLowerCase())
        ) {
          console.debug(`UserOperation from ${entry.userOp.sender} sender accessed a storage of another known sender ${storageAddress}`)
          // eslint-disable-next-line no-labels
          continue mainLoop
        }
      }

      // todo: we take UserOp's callGasLimit, even though it will probably require less (but we don't
      // attempt to estimate it to check)
      // which means we could "cram" more UserOps into a bundle.
      const userOpGasCost = BigNumber.from(validationResult.returnInfo.preOpGas).add(entry.userOp.callGasLimit)
      const newTotalGas = totalGas.add(userOpGasCost)
      if (newTotalGas.gt(this.maxBundleGas)) {
        break
      }

      if (paymaster != null) {
        if (paymasterDeposit[paymaster] == null) {
          paymasterDeposit[paymaster] = await this.entryPoint.balanceOf(paymaster)
        }
        if (paymasterDeposit[paymaster].lt(validationResult.returnInfo.prefund)) {
          // not enough balance in paymaster to pay for all UserOps
          // (but it passed validation, so it can sponsor them separately
          continue
        }
        stakedEntityCount[paymaster] = (stakedEntityCount[paymaster] ?? 0) + 1
        paymasterDeposit[paymaster] = paymasterDeposit[paymaster].sub(validationResult.returnInfo.prefund)
      }
      if (factory != null) {
        stakedEntityCount[factory] = (stakedEntityCount[factory] ?? 0) + 1
      }

      // If sender's account already exist: replace with its storage root hash
      if (this.mergeToAccountRootHash && this.conditionalRpc && entry.userOp.factory == null) {
        const { storageHash } = await this.provider.send('eth_getProof', [entry.userOp.sender, [], 'latest'])
        storageMap[entry.userOp.sender.toLowerCase()] = storageHash
      }
      mergeStorageMap(storageMap, validationResult.storageMap)

      senders.add(entry.userOp.sender)
      bundle.push(entry.userOp)
      totalGas = newTotalGas
    }
    return [bundle, storageMap]
  }

  /**
   * determine who should receive the proceedings of the request.
   * if signer's balance is too low, send it to signer. otherwise, send to configured beneficiary.
   */
  async _selectBeneficiary (): Promise<string> {
    const currentBalance = await this.provider.getBalance(this.signer.getAddress())
    let beneficiary = this.beneficiary
    // below min-balance redeem to the signer, to keep it active.
    if (currentBalance.lte(this.minSignerBalance)) {
      beneficiary = await this.signer.getAddress()
      console.log('low balance. using ', beneficiary, 'as beneficiary instead of ', this.beneficiary)
    }
    return beneficiary
  }

  // helper function to get hashes of all UserOps
  async getUserOpHashes (userOps: UserOperation[]): Promise<string[]> {
    const { userOpHashes } = await runContractScript(this.entryPoint.provider,
      new GetUserOpHashes__factory(),
      [this.entryPoint.address, userOps.map(packUserOp)])

    return userOpHashes
  }

  public async getFeeData (): Promise<{ maxFeePerGas: BigNumber, maxPriorityFeePerGas: BigNumber }> {
    const factor = this.gasFactor
    const multiplier = BigNumber.from(Math.ceil(factor * this.FEE_DENOM))
    const multiply = (base: BigNumber): BigNumber => base.mul(multiplier).div(this.FEE_DENOM)
    const [block, gasPrice] = await Promise.all([
      this.provider.getBlock('latest'),
      this.provider.getGasPrice()
    ])
    // estimate max fee per gas as a multiple of baseFeePerGas
    let maxPriorityFeePerGas: BigNumber = BigNumber.from(await this.provider
      .send('eth_maxPriorityFeePerGas', [])
      .catch((e) => {
        console.log('eth_maxPriorityFeePerGas not supported. using gasPrice - baseFeePerGas', e)
        // If the RPC Provider does not support `eth_maxPriorityFeePerGas`
        // fall back to calculating it manually via `gasPrice - baseFeePerGas`.
        const maxPriorityFeePerGas = gasPrice.sub(BigNumber.from(block.baseFeePerGas))
        if (maxPriorityFeePerGas.lt(0)) {
          return BigNumber.from(0)
        }
        return maxPriorityFeePerGas
      }))
    // console.log('maxPriorityFeePerGas=', maxPriorityFeePerGas.toString())
    // Apply linear increase based on failed attempts
    if (this.transactionAttempts > 0) {
      const effectiveIncrease = BigNumber.from(
        Math.min(this.transactionAttempts, this.maxPriorityFeeRetries)
      ).mul(this.priorityFeeIncreaseFactor)
      // Calculate increase factor using linear approach where the increase factor is a percentage on top of the base fee
      // ((50000000 * 10) / 100 + 50000000 = 55000000
      maxPriorityFeePerGas = maxPriorityFeePerGas
        .mul(effectiveIncrease)
        .div(this.FEE_DENOM)
        .add(maxPriorityFeePerGas)
      debug('Fee increase factor:', maxPriorityFeePerGas.toString(), 'after', this.transactionAttempts, 'attempts')
    }
    if (block.baseFeePerGas == null) {
      throw new Error('no baseFeePerGas')
    }
    const baseFeePerGas = multiply(block.baseFeePerGas)
    const maxFeePerGas = baseFeePerGas.add(maxPriorityFeePerGas)
    return { maxFeePerGas, maxPriorityFeePerGas }
  }
}
