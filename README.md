## LightFarm Server

LightFarm Server is a backend for a trading bot that works with futures/derivatives, fetches market data from Binance, and manages orders through an external trading service (Lighter). The project implements EMA-based strategies, risk management, and trailing stop logic.

### Features

- **Bot management**
  - Start and stop bots via API
  - Only one bot per account can run at the same time
  - Optional daily automatic restart (`withRestart`) with a delay after stop

- **Market data**
  - Load historical candles from Binance (REST)
  - Subscribe to live candles via Binance WebSocket

- **Trading service integration**
  - WebSocket subscriptions for:
    - account state (positions, balance, leverage)
    - open orders
    - account stats

- **Trading strategies**
  - Conservative EMA strategy (`conservativeEmaStrategy`)
  - Pluggable strategy interface via shared parameter types
  - Support for trailing stop logic (via a separate trailing bot controller)

- **Risk management**
  - Change leverage on bot start
  - Risk-per-trade configuration, ATR-based stop loss, break-even (BE), trailing, etc.

### Conservative EMA Strategy

The **Conservative EMA Strategy** combines trend following, volatility-based position sizing, and dynamic stop-loss management.

- **Trend detection (EMA crossover)**
  - Uses two EMAs on closing prices: a short-period EMA and a long-period EMA.
  - A **long** signal appears when the short EMA crosses **above** the long EMA.
  - A **short** signal appears when the short EMA crosses **below** the long EMA.

- **Momentum filter (move strength)**
  - After a crossover, the strategy looks at the last few candles and measures the price move in % from the local minimum/maximum.
  - If this price move is smaller than a configured threshold (`atrRange`), the signal is ignored as too weak.
  - There are additional higher thresholds (`atrRange2`, `atrRange3`) to classify stronger moves.

- **Volume confirmation**
  - Computes a 50-period SMA of volume.
  - Compares the last and previous candle volumes to the average volume multiplied by a configurable factor (`averageVolumesMultiple`).
  - If volume is too low relative to the average, the entry can be skipped as a weak move.

- **Risk-based position sizing**
  - Uses ATR and the planned stop-loss distance to calculate:
    - position size,
    - notional value,
    - required margin.
  - Risk per trade is set as a percentage of account balance (`riskPct`, `riskPct2`, `riskPct3` depending on move strength).
  - If required margin is too high for the current balance, the strategy can:
    - propose a higher leverage (up to a limit),
    - or skip the trade if it is still too large.

- **Stop-loss placement (ATR-based)**
  - Initial SL is placed at a distance of `atrPctforSL * ATR` from the entry price:
    - below the entry for long positions,
    - above the entry for short positions.
  - Orders are normalized to the correct tick/step for the given market.

- **Break-even activation**
  - When price moves in profit by a configured percentage (`bePrc`), and trailing is not yet active:
    - the strategy activates **break-even mode**,
    - moves the stop-loss closer to (or slightly beyond) the entry price to remove downside risk.

- **Trailing stop logic**
  - When price reaches a further profit threshold (`trailStartFromParams`), the strategy switches to **trailing mode**:
    - stop-loss is moved to follow the price with a gap defined by `trailGapFromParams` (% of price),
    - SL is only moved in the direction of profit (never loosened).
  - Logic is symmetric for long and short positions.

- **Leverage and state management**
  - On new entries, if current leverage differs from the configured optimal leverage (`optLeverage`), the strategy requests a leverage update.
  - If a position is already open, new entry signals are ignored; only SL/BE/trailing updates are applied.
  - For opposite signals (e.g. long signal while in a short), the strategy first closes the existing position before opening a new one (if risk conditions are met).
 
  
 ### Getting started  

1. **Install dependencies**

   npm install
   or
   yarn

2. Configure environment variables (e.g. in .env)

  API_PRIVATE_KEY=6fc3ce027*****
  ACCOUNT_INDEX=2*****
  API_KEY_INDEX=**
  BASE_URL=https://mainnet.zklighter.elliot.ai

  Account index you can get via get request from example
 <img width="1390" height="638" alt="image" src="https://github.com/user-attachments/assets/b2d2d20a-b26f-492b-8846-16a15f675685" />

 You can get the API private key and key index on the website in the trading UI: Tools → API Keys.

3. Run server
   
   npm run dev
   
   or
   
   npm run start

5. Control the bot via HTTP requests
   
   - Request for starting. https://***/api/bot/start It`s post request with body has parameters. See screenshot for example
   
<img width="963" height="643" alt="image" src="https://github.com/user-attachments/assets/ada02ed0-15d8-4976-a9d3-75bc7662c7eb" />

   - Request to get the bot ID and check whether it is active.
   If an ID is returned, it means the bot is running.
   GET https://***/api/bot

   - Request to stop rinning
  Post with body
  {
	"botId": "***"
  }

  POST https://***/api/bot/stop


  ## You can now deploy the service and use it online.
## Wishing you successful trading.
