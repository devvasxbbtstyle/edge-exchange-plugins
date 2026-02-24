import {
  asArray,
  asDate,
  asEither,
  asMaybe,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'
import {
  EdgeCorePluginOptions,
  EdgeMemo,
  EdgeSpendInfo,
  EdgeSwapApproveOptions,
  EdgeSwapInfo,
  EdgeSwapPlugin,
  EdgeSwapQuote,
  EdgeSwapRequest,
  EdgeSwapResult,
  SwapAboveLimitError,
  SwapBelowLimitError,
  SwapCurrencyError,
  SwapPermissionError
} from 'edge-core-js/types'

import { xgram as xgramMapping } from '../../mappings/xgram'
import { EdgeCurrencyPluginId } from '../../util/edgeCurrencyPluginIds'
import {
  checkWhitelistedMainnetCodes,
  CurrencyPluginIdSwapChainCodeMap,
  getContractAddresses,
  getMaxSwappable,
  mapToRecord,
  SwapOrder
} from '../../util/swapHelpers'
import {
  convertRequest,
  denominationToNative,
  getAddress,
  memoType,
  nativeToDenomination
} from '../../util/utils'
import { asNumberString, EdgeSwapRequestPlugin, StringMap } from '../types'
import { asOptionalBlank } from './changenow'

const pluginId = 'xgram'

export const swapInfo: EdgeSwapInfo = {
  pluginId,
  isDex: false,
  displayName: 'Xgram',
  supportEmail: 'support@xgram.io'
}

const asInitOptions = asObject({
  apiKey: asString
})

const orderUri = 'https://xgram.io/exchange/order?id='
const uri = 'https://xgram.io/api/v2/'
const newExchange = 'launch-new-exchange-edge'
const newRevExchange = 'launch-new-payment-exchange-edge'

export const MAINNET_CODE_TRANSCRIPTION: CurrencyPluginIdSwapChainCodeMap = mapToRecord(
  xgramMapping
)

const addressTypeMap: StringMap = {
  zcash: 'transparentAddress'
}

const swapType = 'fixed' as const
const ccyAmountLimitRegex = /ccyAmount must be ([><])\s*([\d.]+)/

function throwOnXgramErrors(
  errors: ReturnType<typeof asXgramError>['errors'],
  request: EdgeSwapRequestPlugin,
  isSelling: boolean,
  quoteFor: 'from' | 'to',
  fallbackMsg: string
): never {
  if (errors.find(error => error.code === 'REGION_UNSUPPORTED') != null) {
    throw new SwapPermissionError(swapInfo, 'geoRestriction')
  }
  if (errors.find(error => error.code === 'CURRENCY_UNSUPPORTED') != null) {
    throw new SwapCurrencyError(swapInfo, request)
  }
  const limitError = errors
    .map(e => asMaybe(asXgramLimitError)(e))
    .find(e => e != null)
  if (limitError?.code === 'BELOW_LIMIT') {
    const nativeLimit = denominationToNative(
      isSelling ? request.fromWallet : request.toWallet,
      isSelling
        ? limitError.sourceAmountLimit
        : limitError.destinationAmountLimit,
      isSelling ? request.fromTokenId : request.toTokenId
    )
    throw new SwapBelowLimitError(swapInfo, nativeLimit, quoteFor)
  }
  if (limitError?.code === 'ABOVE_LIMIT') {
    const nativeLimit = denominationToNative(
      isSelling ? request.fromWallet : request.toWallet,
      isSelling
        ? limitError.sourceAmountLimit
        : limitError.destinationAmountLimit,
      isSelling ? request.fromTokenId : request.toTokenId
    )
    throw new SwapAboveLimitError(swapInfo, nativeLimit, quoteFor)
  }
  throw new Error(fallbackMsg)
}

export function makeXgramPlugin(opts: EdgeCorePluginOptions): EdgeSwapPlugin {
  const { io } = opts

  const fetchCors = io.fetch
  const { apiKey } = asInitOptions(opts.initOptions)

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey
  }

  async function fetchRate(
    isSelling: boolean,
    largeDenomAmount: string,
    ctx: XgramContext,
    request: EdgeSwapRequestPlugin
  ): Promise<XgramRate> {
    const qs = new URLSearchParams({
      fromNetwork: ctx.fromNetwork,
      fromContractAddress: ctx.fromContractAddress ?? '',
      toContractAddress: ctx.toContractAddress ?? '',
      toNetwork: ctx.toNetwork,
      ccyAmount: largeDenomAmount
    }).toString()

    const rateRes = await fetchCors(uri + `retrieve-rate-value?${qs}`, {
      headers
    })

    const json = await rateRes.json()
    const rateReply = asXgramRateResponse(json)
    const quoteFor = request.quoteFor === 'from' ? 'from' : 'to'

    if ('errors' in rateReply) {
      throwOnXgramErrors(
        rateReply.errors,
        request,
        isSelling,
        quoteFor,
        'Xgram rate error'
      )
    }

    if ('error' in rateReply) {
      const match = ccyAmountLimitRegex.exec(rateReply.error)
      if (match != null) {
        const [, direction, limitStr] = match
        const nativeLimit = denominationToNative(
          isSelling ? request.fromWallet : request.toWallet,
          limitStr,
          isSelling ? request.fromTokenId : request.toTokenId
        )
        if (direction === '>') {
          throw new SwapBelowLimitError(swapInfo, nativeLimit, quoteFor)
        }
        throw new SwapAboveLimitError(swapInfo, nativeLimit, quoteFor)
      }
      throw new Error(`Xgram: ${rateReply.error}`)
    }

    return {
      fromAmount: isSelling ? rateReply.ccyAmountFrom : largeDenomAmount,
      toAmount: isSelling
        ? rateReply.ccyAmountToExpected
        : rateReply.ccyAmountFrom
    }
  }

  async function createOrder(
    isSelling: boolean,
    largeDenomAmount: string,
    ctx: XgramContext,
    request: EdgeSwapRequestPlugin
  ): Promise<XgramResponse> {
    const createExchangeUrl = isSelling ? newExchange : newRevExchange
    const qs = new URLSearchParams({
      toAddress: String(ctx.toAddress),
      refundAddress: String(ctx.fromAddress),
      ccyAmount: largeDenomAmount,
      type: swapType,
      fromContractAddress: ctx.fromContractAddress ?? '',
      toContractAddress: ctx.toContractAddress ?? '',
      fromNetwork: ctx.fromNetwork,
      toNetwork: ctx.toNetwork
    }).toString()

    const orderResponse = await fetchCors(uri + createExchangeUrl + `?${qs}`, {
      headers
    })

    if (!orderResponse.ok) {
      throw new Error('Xgram create order failed')
    }

    const orderResponseJson = await orderResponse.json()
    const quoteFor = request.quoteFor === 'from' ? 'from' : 'to'
    const quoteReply = asXgramQuoteReply(orderResponseJson)

    if ('errors' in quoteReply) {
      throwOnXgramErrors(
        quoteReply.errors,
        request,
        isSelling,
        quoteFor,
        'Xgram create order error'
      )
    }
    if ('error' in quoteReply) {
      const match = ccyAmountLimitRegex.exec(quoteReply.error)
      if (match != null) {
        const [, direction, limitStr] = match
        const nativeLimit = denominationToNative(
          isSelling ? request.fromWallet : request.toWallet,
          limitStr,
          isSelling ? request.fromTokenId : request.toTokenId
        )
        if (direction === '>') {
          throw new SwapBelowLimitError(swapInfo, nativeLimit, quoteFor)
        }
        throw new SwapAboveLimitError(swapInfo, nativeLimit, quoteFor)
      }

      throw new Error(`Xgram: ${quoteReply.error}`)
    }

    if (quoteReply.ccyAmountToExpected == null && isSelling) {
      throw new Error('Xgram quote missing ccyAmountToExpected')
    }

    return {
      id: quoteReply.id,
      validUntil: quoteReply.expiresAt,
      fromAmount: quoteReply.ccyAmountFrom,
      toAmount:
        quoteReply.ccyAmountToExpected != null
          ? quoteReply.ccyAmountToExpected.toString()
          : largeDenomAmount,
      payinAddress: quoteReply.depositAddress,
      payinExtraId: quoteReply.depositTag
    }
  }

  const fetchSwapQuoteInner = async (
    request: EdgeSwapRequestPlugin,
    _opts: { promoCode?: string }
  ): Promise<SwapOrder> => {
    const { fromWallet, toWallet, nativeAmount } = request

    const [fromAddress, toAddress] = await Promise.all([
      getAddress(fromWallet, addressTypeMap[fromWallet.currencyInfo.pluginId]),
      getAddress(toWallet, addressTypeMap[toWallet.currencyInfo.pluginId])
    ])

    const { fromContractAddress, toContractAddress } = getContractAddresses(
      request
    )
    const fromNetwork =
      MAINNET_CODE_TRANSCRIPTION[
        fromWallet.currencyInfo.pluginId as EdgeCurrencyPluginId
        ] ?? ''
    const toNetwork =
      MAINNET_CODE_TRANSCRIPTION[
        toWallet.currencyInfo.pluginId as EdgeCurrencyPluginId
        ] ?? ''

    if (fromNetwork === '' || toNetwork === '') {
      throw new SwapCurrencyError(swapInfo, request)
    }

    const ctx: XgramContext = {
      fromAddress,
      toAddress,
      fromContractAddress,
      toContractAddress,
      fromNetwork,
      toNetwork
    }

    const isSelling = request.quoteFor !== 'to'
    const largeDenomAmount = nativeToDenomination(
      isSelling ? fromWallet : toWallet,
      nativeAmount,
      isSelling ? request.fromTokenId : request.toTokenId
    )

    const order = await createOrder(isSelling, largeDenomAmount, ctx, request)

    const fromNativeAmount = denominationToNative(
      fromWallet,
      order.fromAmount,
      request.fromTokenId
    )
    const toNativeAmount = denominationToNative(
      toWallet,
      order.toAmount,
      request.toTokenId
    )

    const memos: EdgeMemo[] =
      order.payinExtraId == null || order.payinExtraId === ''
        ? []
        : [
          {
            type: memoType(fromWallet.currencyInfo.pluginId),
            value: order.payinExtraId
          }
        ]

    const spendInfo: EdgeSpendInfo = {
      tokenId: request.fromTokenId,
      spendTargets: [
        {
          nativeAmount: fromNativeAmount,
          publicAddress: order.payinAddress
        }
      ],
      memos,
      networkFeeOption: 'high',
      assetAction: { assetActionType: 'swap' },
      savedAction: {
        actionType: 'swap',
        swapInfo,
        orderId: order.id,
        orderUri: orderUri + order.id,
        isEstimate: false,
        toAsset: {
          pluginId: toWallet.currencyInfo.pluginId,
          tokenId: request.toTokenId,
          nativeAmount: toNativeAmount
        },
        fromAsset: {
          pluginId: fromWallet.currencyInfo.pluginId,
          tokenId: request.fromTokenId,
          nativeAmount: fromNativeAmount
        },
        payoutAddress: toAddress,
        payoutWalletId: toWallet.id,
        refundAddress: fromAddress
      }
    }

    return {
      request,
      spendInfo,
      swapInfo,
      fromNativeAmount,
      expirationDate: order.validUntil ?? new Date(Date.now() + 1000 * 60)
    }
  }

  const out: EdgeSwapPlugin = {
    swapInfo,

    async fetchSwapQuote(
      req: EdgeSwapRequest,
      userSettings: Object | undefined,
      opts: { promoCode?: string }
    ): Promise<EdgeSwapQuote> {
      const request = convertRequest(req)

      checkWhitelistedMainnetCodes(
        MAINNET_CODE_TRANSCRIPTION,
        request,
        swapInfo
      )

      const newRequest = await getMaxSwappable(
        fetchSwapQuoteInner,
        request,
        opts
      )

      const { fromWallet, toWallet, nativeAmount } = newRequest

      const [fromAddress, toAddress] = await Promise.all([
        getAddress(
          fromWallet,
          addressTypeMap[fromWallet.currencyInfo.pluginId]
        ),
        getAddress(toWallet, addressTypeMap[toWallet.currencyInfo.pluginId])
      ])

      const { fromContractAddress, toContractAddress } = getContractAddresses(
        newRequest
      )
      const fromNetwork =
        MAINNET_CODE_TRANSCRIPTION[
          fromWallet.currencyInfo.pluginId as EdgeCurrencyPluginId
          ] ?? ''
      const toNetwork =
        MAINNET_CODE_TRANSCRIPTION[
          toWallet.currencyInfo.pluginId as EdgeCurrencyPluginId
          ] ?? ''

      if (fromNetwork === '' || toNetwork === '') {
        throw new SwapCurrencyError(swapInfo, newRequest)
      }

      const ctx: XgramContext = {
        fromAddress,
        toAddress,
        fromContractAddress,
        toContractAddress,
        fromNetwork,
        toNetwork
      }

      const isSelling = newRequest.quoteFor !== 'to'
      const largeDenomAmount = nativeToDenomination(
        isSelling ? fromWallet : toWallet,
        nativeAmount,
        isSelling ? newRequest.fromTokenId : newRequest.toTokenId
      )

      const rate = await fetchRate(isSelling, largeDenomAmount, ctx, newRequest)

      const fromNativeAmount = denominationToNative(
        fromWallet,
        rate.fromAmount,
        newRequest.fromTokenId
      )
      const toNativeAmount = denominationToNative(
        toWallet,
        rate.toAmount,
        newRequest.toTokenId
      )

      const quote: EdgeSwapQuote = {
        swapInfo,
        request: req,
        pluginId: swapInfo.pluginId,
        isEstimate: false,
        fromNativeAmount,
        toNativeAmount,
        networkFee: {
          currencyCode: fromWallet.currencyInfo.currencyCode,
          nativeAmount: '0',
          tokenId: null
        },
        expirationDate: new Date(Date.now() + 1000 * 60),

        async approve(
          approveOpts?: EdgeSwapApproveOptions
        ): Promise<EdgeSwapResult> {
          const order = await createOrder(
            isSelling,
            largeDenomAmount,
            ctx,
            newRequest
          )

          const orderFromNativeAmount = denominationToNative(
            fromWallet,
            order.fromAmount.toString(),
            newRequest.fromTokenId
          )
          const orderToNativeAmount = denominationToNative(
            toWallet,
            order.toAmount.toString(),
            newRequest.toTokenId
          )

          const memos: EdgeMemo[] =
            order.payinExtraId == null || order.payinExtraId === ''
              ? []
              : [
                {
                  type: memoType(fromWallet.currencyInfo.pluginId),
                  value: order.payinExtraId
                }
              ]

          const spendInfo: EdgeSpendInfo = {
            tokenId: newRequest.fromTokenId,
            spendTargets: [
              {
                nativeAmount: orderFromNativeAmount,
                publicAddress: order.payinAddress
              }
            ],
            memos,
            networkFeeOption: 'high',
            assetAction: { assetActionType: 'swap' },
            savedAction: {
              actionType: 'swap',
              swapInfo,
              orderId: order.id,
              orderUri: orderUri + order.id,
              isEstimate: false,
              toAsset: {
                pluginId: toWallet.currencyInfo.pluginId,
                tokenId: newRequest.toTokenId,
                nativeAmount: orderToNativeAmount
              },
              fromAsset: {
                pluginId: fromWallet.currencyInfo.pluginId,
                tokenId: newRequest.fromTokenId,
                nativeAmount: orderFromNativeAmount
              },
              payoutAddress: toAddress,
              payoutWalletId: toWallet.id,
              refundAddress: fromAddress
            }
          }

          const tx = await fromWallet.makeSpend(spendInfo)
          tx.metadata = approveOpts?.metadata ?? {}
          const signedTx = await fromWallet.signTx(tx)
          const broadcastedTx = await fromWallet.broadcastTx(signedTx)
          await fromWallet.saveTx(broadcastedTx)

          return {
            transaction: broadcastedTx,
            orderId: order.id,
            destinationAddress: toAddress
          }
        },

        async close(): Promise<void> {}
      }

      return quote
    }
  }
  return out
}

interface XgramContext {
  fromAddress: string
  toAddress: string
  fromContractAddress: string | undefined
  toContractAddress: string | undefined
  fromNetwork: string
  toNetwork: string
}

interface XgramRate {
  fromAmount: string
  toAmount: string
}

interface XgramResponse {
  id: string
  fromAmount: string
  toAmount: string
  payinExtraId?: string
  payinAddress: string
  validUntil?: Date | null
}

const asXgramLimitError = asObject({
  code: asValue('BELOW_LIMIT', 'ABOVE_LIMIT'),
  destinationAmountLimit: asString,
  error: asString,
  sourceAmountLimit: asString
})

const asXgramRegionError = asObject({
  code: asValue('REGION_UNSUPPORTED'),
  message: asString
})

const asXgramCurrencyError = asObject({
  code: asValue('CURRENCY_UNSUPPORTED'),
  error: asString
})
const asXgramError = asObject({
  errors: asArray(
    asEither(asXgramLimitError, asXgramRegionError, asXgramCurrencyError)
  )
})
const asXgramStringError = asObject({
  error: asString
})
const asXgramQuote = asObject({
  ccyAmountToExpected: asOptional(asNumberString),
  depositAddress: asString,
  depositTag: asOptionalBlank(asString),
  id: asString,
  result: asValue(true),
  expiresAt: asOptional(asDate),
  ccyAmountFrom: asNumberString
})
const asXgramQuoteReply = asEither(
  asXgramQuote,
  asXgramError,
  asXgramStringError
)
const asXgramRateReply = asObject({
  ccyAmountFrom: asNumberString,
  ccyAmountToExpected: asNumberString
})
const asXgramRateResponse = asEither(
  asXgramRateReply,
  asXgramError,
  asXgramStringError
)
