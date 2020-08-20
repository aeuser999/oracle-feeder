import nodeFetch from 'node-fetch'
import { concat } from 'lodash'
import * as pako from 'pako'
import { num } from 'lib/num'
import { errorHandler } from 'lib/error'
import * as logger from 'lib/logger'
import { toQueryString } from 'lib/fetch'
import { WebSocketQuoter, Trades } from 'provider/base'
import { fiatProvider } from 'provider'
import { getQuoteCurrency, getBaseCurrency } from 'lib/currency'

interface StreamData {
  ch: string // channel name
  ts: number // timestamp
}

interface CandlestickStreamData extends StreamData {
  tick: {
    id: number // UNIX epoch timestamp in second as response id
    open: number // Opening price during the interval
    close: number // Closing price during the interval
    low: number // Low price during the interval
    high: number // High price during the interval
    amount: number // Aggregated trading volume during the interval (in base currency)
    vol: number // Aggregated trading value during the interval (in quote currency)
    count: number // Number of trades during the interval
  }
}

export class Huobi extends WebSocketQuoter {
  private isUpdated = false

  public async initialize(): Promise<void> {
    await super.initialize()

    for (const symbol of this.symbols) {
      this.setTrades(symbol, [])

      // update last trades and price of symbol/USDT
      await this.fetchLatestTrades(symbol)
        .then((trades) => {
          if (!trades.length) {
            return
          }

          this.setTrades(symbol, trades)
          this.setPrice(symbol, trades[trades.length - 1].price)

          // make base/KRW price
          this.automadeTrades(symbol, trades)
        })
        .catch(errorHandler)
    }
    this.isUpdated = true

    // try connect to websocket server
    this.connect('wss://api.huobi.pro/ws')
  }

  public getSymbols(): string[] {
    return concat(
      this.symbols,
      this.symbols
        .map((symbol) => {
          if (getQuoteCurrency(symbol) === 'USDT') {
            return `${getBaseCurrency(symbol)}/KRW`
          }
        })
        .filter((symbol) => symbol)
    )
  }

  public getAutomadeSymbols(): string[] {
    return this.symbols
      .map((symbol) => {
        if (getQuoteCurrency(symbol) === 'USDT') {
          return `${getBaseCurrency(symbol)}/KRW`
        }
      })
      .filter((symbol) => symbol)
  }

  protected onConnect(): void {
    super.onConnect()

    // subscribe transaction
    for (const symbol of this.symbols) {
      this.ws.send(`{"sub": "market.${symbol.replace('/', '').toLowerCase()}.kline.1min"}`)
    }
  }

  protected onRawData(gzipedData: pako.Data): void {
    const unzipedText = pako.inflate(gzipedData, { to: 'string' })

    try {
      this.onData(JSON.parse(unzipedText))
    } catch (error) {
      errorHandler(error)
    }
    this.alive()
  }

  // eslint-disable-next-line
  protected onData(streamData): void {
    if (streamData.ping) {
      this.ws.send(`{"pong": ${streamData.ping}}`)
    } else if (streamData.subbed) {
      if (streamData.status !== 'ok') {
        throw new Error(streamData)
      }
      // logger.info(`Huobi: subscribe to ${streamData.subbed}, status: ${streamData.status}`)
    } else if (streamData.ch?.indexOf('market.') === 0) {
      const data = streamData as CandlestickStreamData

      const ch = data.ch.replace('market.', '').replace('.kline.1min', '').toUpperCase()
      const symbol = this.symbols.find((symbol) => symbol.replace('/', '') === ch)
      if (!symbol) {
        return
      }

      const timestamp = +data.tick.id * 1000
      const price = num(data.tick.close)
      const volume = num(data.tick.amount)

      const trades = this.getTrades(symbol) || []
      const currentTrade = trades.find((trade) => trade.timestamp === timestamp)

      // make 1m candle stick
      if (currentTrade) {
        currentTrade.price = price
        currentTrade.volume = volume
      } else {
        trades.push({ price, volume, timestamp })
      }

      this.setTrades(symbol, trades)
      this.setPrice(symbol, price)

      // make base/KRW price
      this.automadeTrades(symbol, trades)

      this.isUpdated = true
    } else {
      throw new Error(streamData)
    }
  }

  // make base/KRW from base/USDT
  private automadeTrades(symbol: string, trades: Trades): void {
    const rate = fiatProvider.getPriceBy('KRW/USD')

    if (getQuoteCurrency(symbol) !== 'USDT' || !rate) {
      return
    }

    const convertedSymbol = `${getBaseCurrency(symbol)}/KRW`
    const calculatedTrades = trades.map((trade) => ({
      timestamp: trade.timestamp,
      price: trade.price.dividedBy(rate),
      volume: trade.volume,
    }))

    this.setTrades(convertedSymbol, calculatedTrades)
    this.setPrice(convertedSymbol, calculatedTrades[calculatedTrades.length - 1].price)
  }

  private async fetchLatestTrades(symbol: string): Promise<Trades> {
    const params = {
      symbol: symbol.replace('/', '').toLowerCase(),
      period: '1min',
      size: 10,
    }

    // Get candles from Huobi
    // reference: https://huobiapi.github.io/docs/spot/v1/en/#get-klines-candles
    const response = await nodeFetch(
      `https://api.huobi.pro/market/history/kline?${toQueryString(params)}`
    ).then((res) => res.json())

    if (
      !response ||
      response.status !== 'ok' ||
      !Array.isArray(response.data) ||
      response.data.length < 1
    ) {
      logger.error(
        `${this.constructor.name}: invalid api response:`,
        response ? JSON.stringify(response) : 'empty'
      )
      throw new Error('invalid response from Huobi')
    }

    return response.data
      .filter((row) => parseFloat(row.vol) > 0)
      .map((row) => ({
        price: num(row.close),
        volume: num(row.amount),
        timestamp: +row.id * 1000,
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  protected async update(): Promise<boolean> {
    if (this.isUpdated) {
      this.isUpdated = false
      return true
    }

    return false
  }
}

export default Huobi