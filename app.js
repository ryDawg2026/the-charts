/* The Charts — public, read-only Bitcoin market reads. No keys, no orders. */
(() => {
  const RELAY = "https://the-charts-relay.rydawg2026.workers.dev";
  const PRICE_MS = 20000;
  const CANDLE_MS = 60000;
  const QC_STALE_MS = 3 * 60 * 1000;
  const QC_OUTLIER = 0.015;
  const UA = { Accept: "application/json" };

  const charts = new Map();
  const state = {
    exchanges: {},
    priceOnly: {},
    kalshi: { odds: null, html: "", error: null, updated: 0 },
  };

  function ptTime(ts = Date.now()) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    return `${fmt.format(new Date(ts))} PT`;
  }

  function money(n, digits = 2) {
    if (!Number.isFinite(n)) return "—";
    return Number(n).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function pctText(n) {
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n).toFixed(2) + "%";
    return n > 0 ? "+" + abs : n < 0 ? "−" + abs.replace("-", "") : "0.00%";
  }

  function dirClass(n) {
    if (!Number.isFinite(n)) return "flat";
    if (n > 0) return "up";
    if (n < 0) return "down";
    return "flat";
  }

  function dirLabel(n) {
    if (!Number.isFinite(n)) return "—";
    if (n > 0) return "Up";
    if (n < 0) return "Down";
    return "Flat";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchOnce(url, useRelay) {
    const target = useRelay ? `${RELAY}?url=${encodeURIComponent(url)}` : url;
    const res = await fetch(target, { headers: UA, cache: "no-store", mode: "cors" });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      if (useRelay) {
        try {
          const body = await res.json();
          if (body && body.error) detail += ` (${body.error})`;
        } catch {}
      }
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function fetchWithRetry(url, useRelay) {
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        return await fetchOnce(url, useRelay);
      } catch (err) {
        last = err;
        const status = err.status || 0;
        if (status === 429 || status === 503 || status === 502) {
          await sleep(400 * (i + 1) * (i + 1));
          continue;
        }
        throw err;
      }
    }
    throw last;
  }

  async function fetchJson(url, { relay = "fallback" } = {}) {
    if (relay === "never") return fetchWithRetry(url, false);
    if (relay === "always") return fetchWithRetry(url, true);
    try {
      return await fetchWithRetry(url, false);
    } catch (err) {
      const status = err.status || 0;
      if (status === 451 || status === 403) {
        // Region blocks often affect the relay too; still try, then surface the original error if it also fails.
      }
      try {
        return await fetchWithRetry(url, true);
      } catch (relayErr) {
        throw err;
      }
    }
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    const n = Math.min(limit, items.length) || 0;
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  function num(v) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function candle(time, open, high, low, close) {
    const t = num(time);
    const o = num(open);
    const h = num(high);
    const l = num(low);
    const c = num(close);
    if (t == null || o == null || h == null || l == null || c == null) return null;
    const timeSec = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
    return { time: timeSec, open: o, high: h, low: l, close: c };
  }

  function normalize(list) {
    const out = [];
    const seen = new Set();
    for (const row of list || []) {
      if (!row) continue;
      if (seen.has(row.time)) continue;
      seen.add(row.time);
      if (row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) {
        row.high = Math.max(row.high, row.open, row.close);
        row.low = Math.min(row.low, row.open, row.close);
      }
      out.push(row);
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  function periodChange(candles) {
    if (!candles || !candles.length) return null;
    const c = candles[candles.length - 1];
    if (!c.open) return null;
    const pct = ((c.close - c.open) / c.open) * 100;
    return { pct, open: c.open, close: c.close };
  }

  function mondayUtc(timeSec) {
    const d = new Date(timeSec * 1000);
    const dow = d.getUTCDay();
    const diff = (dow + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff) / 1000;
  }

  function weeklyFromDaily(daily) {
    const map = new Map();
    for (const c of daily || []) {
      const start = mondayUtc(c.time);
      const cur = map.get(start);
      if (!cur) {
        map.set(start, {
          time: start,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        });
      } else {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
      }
    }
    return normalize([...map.values()]);
  }

  function take(candles, n) {
    if (!candles) return [];
    return candles.length > n ? candles.slice(-n) : candles;
  }

  // --- venue adapters ---

  function binanceStyle(rows, count = 6) {
    // [openTime, open, high, low, close]
    return normalize((rows || []).map((r) => candle(r[0], r[1], r[2], r[3], r[4])));
  }

  const venues = [
    {
      id: "coinbase",
      name: "Coinbase",
      pair: "BTC-USD",
      kind: "spot",
      quote: "USD",
      inAverage: true,
      weekFromDaily: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker");
          return { price: num(t.price), priceTime: Date.now() };
        }
        const [m15, h1, d1] = await Promise.all(
          [900, 3600, 86400].map((g) =>
            fetchJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${g}&limit=80`)
          )
        );
        // Coinbase: [time, low, high, open, close, volume]
        const parse = (rows) => normalize((rows || []).map((r) => candle(r[0], r[3], r[2], r[1], r[4])));
        const daily = parse(d1);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(daily, 60), w1: take(weeklyFromDaily(daily), 24) };
      },
    },
    {
      id: "kraken",
      name: "Kraken",
      pair: "XBT/USD",
      kind: "spot",
      quote: "USD",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
          const row = t.result && (t.result.XXBTZUSD || Object.values(t.result)[0]);
          return { price: num(row && row.c && row.c[0]), priceTime: Date.now() };
        }
        const parse = (payload) => {
          const pair = payload.result && (payload.result.XXBTZUSD || Object.values(payload.result).find((v) => Array.isArray(v)));
          return normalize((pair || []).map((r) => candle(r[0], r[1], r[2], r[3], r[4])));
        };
        const [m15, h1, d1, w1] = await Promise.all(
          [15, 60, 1440, 10080].map((i) =>
            fetchJson(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${i}`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "binanceus",
      name: "Binance.US",
      pair: "BTC/USD",
      kind: "spot",
      quote: "USD",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD");
          return { price: num(t.price), priceTime: Date.now() };
        }
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1h", "1d", "1w"].map((i) =>
            fetchJson(`https://api.binance.us/api/v3/klines?symbol=BTCUSD&interval=${i}&limit=80`)
          )
        );
        return { m15: take(binanceStyle(m15), 48), h1: take(binanceStyle(h1), 48), d1: take(binanceStyle(d1), 60), w1: take(binanceStyle(w1), 24) };
      },
    },
    {
      id: "binance",
      name: "Binance",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      note: "Fetched in the browser only. Some networks block Binance.",
      async load(kind) {
        const get = (url) => fetchJson(url, { relay: "never" });
        if (kind !== "candles") {
          const t = await get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
          return { price: num(t.price), priceTime: Date.now() };
        }
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1h", "1d", "1w"].map((i) =>
            get(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${i}&limit=80`)
          )
        );
        return { m15: take(binanceStyle(m15), 48), h1: take(binanceStyle(h1), 48), d1: take(binanceStyle(d1), 60), w1: take(binanceStyle(w1), 24) };
      },
      unavailableMessage: "Unavailable from here. Binance blocked this network or region.",
    },
    {
      id: "okx",
      name: "OKX",
      pair: "BTC-USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT");
          const row = t.data && t.data[0];
          return { price: num(row && row.last), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize((payload.data || []).map((r) => candle(r[0], r[1], r[2], r[3], r[4])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1H", "1D", "1W"].map((bar) =>
            fetchJson(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${bar}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "cryptocom",
      name: "Crypto.com",
      pair: "BTC/USD",
      kind: "spot",
      quote: "USD",
      inAverage: true,
      weekFromDaily: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTC_USD");
          const row = t.result && t.result.data && t.result.data[0];
          const px = row && (row.a ?? row.k ?? row.last);
          return { price: num(px), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize(((payload.result && payload.result.data) || []).map((r) => candle(r.t, r.o, r.h, r.l, r.c)));
        const [m15, h1, d1] = await Promise.all(
          ["15m", "1h", "1D"].map((tf) =>
            fetchJson(`https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=BTC_USD&timeframe=${tf}`)
          )
        );
        const daily = parse(d1);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(daily, 60), w1: take(weeklyFromDaily(daily), 24) };
      },
    },
    {
      id: "htx",
      name: "HTX",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.huobi.pro/market/detail/merged?symbol=btcusdt");
          const tick = t.tick || {};
          const px = tick.close ?? (Array.isArray(tick.bid) ? tick.bid[0] : null);
          return { price: num(px), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize((payload.data || []).map((r) => candle(r.id, r.open, r.high, r.low, r.close)));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15min", "60min", "1day", "1week"].map((p) =>
            fetchJson(`https://api.huobi.pro/market/history/kline?symbol=btcusdt&period=${p}&size=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "gate",
      name: "Gate.io",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT");
          return { price: num(t[0] && t[0].last), priceTime: Date.now() };
        }
        // [t, volume, close, high, low, open]
        const parse = (rows) => normalize((rows || []).map((r) => candle(r[0], r[5], r[3], r[4], r[2])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1h", "1d", "1w"].map((i) =>
            fetchJson(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=${i}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "bitget",
      name: "Bitget",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT");
          const row = t.data && t.data[0];
          return { price: num(row && row.lastPr), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize((payload.data || []).map((r) => candle(r[0], r[1], r[2], r[3], r[4])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15min", "1h", "1day", "1week"].map((g) =>
            fetchJson(`https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=${g}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "bitfinex",
      name: "Bitfinex",
      pair: "BTC/USD",
      kind: "spot",
      quote: "USD",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api-pub.bitfinex.com/v2/ticker/tBTCUSD");
          return { price: num(t[6]), priceTime: Date.now() };
        }
        // [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
        const parse = (rows) => normalize((rows || []).map((r) => candle(r[0], r[1], r[3], r[4], r[2])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1h", "1D", "1W"].map((i) =>
            fetchJson(`https://api-pub.bitfinex.com/v2/candles/trade:${i}:tBTCUSD/hist?limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "bitstamp",
      name: "Bitstamp",
      pair: "BTC/USD",
      kind: "spot",
      quote: "USD",
      inAverage: true,
      weekFromDaily: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://www.bitstamp.net/api/v2/ticker/btcusd/");
          return { price: num(t.last), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize((((payload.data && payload.data.ohlc) || [])).map((r) => candle(r.timestamp, r.open, r.high, r.low, r.close)));
        const [m15, h1, d1] = await Promise.all(
          [900, 3600, 86400].map((step) =>
            fetchJson(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=${step}&limit=80`)
          )
        );
        const daily = parse(d1);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(daily, 60), w1: take(weeklyFromDaily(daily), 24) };
      },
    },
    {
      id: "kucoin",
      name: "KuCoin",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT");
          return { price: num(t.data && t.data.price), priceTime: Date.now() };
        }
        // [time, open, close, high, low, volume, turnover]
        const parse = (payload) =>
          normalize((payload.data || []).map((r) => candle(r[0], r[1], r[3], r[4], r[2])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15min", "1hour", "1day", "1week"].map((type) =>
            fetchJson(`https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=BTC-USDT`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "mexc",
      name: "MEXC",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT");
          return { price: num(t.price), priceTime: Date.now() };
        }
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "60m", "1d", "1W"].map((i) =>
            fetchJson(`https://api.mexc.com/api/v3/klines?symbol=BTCUSDT&interval=${i}&limit=80`)
          )
        );
        return { m15: take(binanceStyle(m15), 48), h1: take(binanceStyle(h1), 48), d1: take(binanceStyle(d1), 60), w1: take(binanceStyle(w1), 24) };
      },
    },
    {
      id: "poloniex",
      name: "Poloniex",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.poloniex.com/markets/BTC_USDT/ticker24h");
          return { price: num(t.close), priceTime: Date.now() };
        }
        // [low, high, open, close, ..., startTime]
        const parse = (rows) =>
          normalize((rows || []).map((r) => candle(r[9] ?? r[12], r[2], r[1], r[0], r[3])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["MINUTE_15", "HOUR_1", "DAY_1", "WEEK_1"].map((i) =>
            fetchJson(`https://api.poloniex.com/markets/BTC_USDT/candles?interval=${i}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "upbit",
      name: "Upbit",
      pair: "USDT-BTC",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.upbit.com/v1/ticker?markets=USDT-BTC");
          return { price: num(t[0] && t[0].trade_price), priceTime: Date.now() };
        }
        const parse = (rows) =>
          normalize(
            (rows || []).map((r) =>
              candle(
                r.timestamp ? Math.floor(r.timestamp / 1000) : Date.parse(r.candle_date_time_utc + "Z") / 1000,
                r.opening_price,
                r.high_price,
                r.low_price,
                r.trade_price
              )
            )
          );
        const [m15, h1, d1, w1] = await Promise.all([
          fetchJson("https://api.upbit.com/v1/candles/minutes/15?market=USDT-BTC&count=80"),
          fetchJson("https://api.upbit.com/v1/candles/minutes/60?market=USDT-BTC&count=80"),
          fetchJson("https://api.upbit.com/v1/candles/days?market=USDT-BTC&count=80"),
          fetchJson("https://api.upbit.com/v1/candles/weeks?market=USDT-BTC&count=24"),
        ]);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "gemini",
      name: "Gemini",
      pair: "BTC/USD",
      kind: "spot",
      quote: "USD",
      inAverage: true,
      weekFromDaily: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.gemini.com/v1/pubticker/btcusd");
          return { price: num(t.last), priceTime: Date.now() };
        }
        const parse = (rows) => normalize((rows || []).map((r) => candle(r[0], r[1], r[2], r[3], r[4])));
        const [m15, h1, d1] = await Promise.all(
          ["15m", "1hr", "1day"].map((i) => fetchJson(`https://api.gemini.com/v2/candles/btcusd/${i}`))
        );
        const daily = parse(d1);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(daily, 60), w1: take(weeklyFromDaily(daily), 24) };
      },
    },
    {
      id: "bingx",
      name: "BingX",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=BTC-USDT");
          const row = Array.isArray(t.data) ? t.data[0] : t.data;
          return { price: num(row && row.lastPrice), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize((payload.data || []).map((r) => candle(r[0], r[1], r[2], r[3], r[4])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1h", "1d", "1w"].map((i) =>
            fetchJson(`https://open-api.bingx.com/openApi/spot/v1/market/kline?symbol=BTC-USDT&interval=${i}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "xt",
      name: "XT.com",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://sapi.xt.com/v4/public/ticker?symbol=btc_usdt");
          const row = t.result && t.result[0];
          return { price: num(row && row.c), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize((payload.result || []).map((r) => candle(r.t, r.o, r.h, r.l, r.c)));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1h", "1d", "1w"].map((i) =>
            fetchJson(`https://sapi.xt.com/v4/public/kline?symbol=btc_usdt&interval=${i}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "whitebit",
      name: "WhiteBIT",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://whitebit.com/api/v4/public/ticker");
          const row = t.BTC_USDT;
          return { price: num(row && row.last_price), priceTime: Date.now() };
        }
        // [time, open, close, high, low, volume, deal]
        const parse = (payload) =>
          normalize((payload.result || []).map((r) => candle(r[0], r[1], r[3], r[4], r[2])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15m", "1h", "1d", "1w"].map((i) =>
            fetchJson(`https://whitebit.com/api/v1/public/kline?market=BTC_USDT&interval=${i}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "hitbtc",
      name: "HitBTC",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.hitbtc.com/api/3/public/ticker/BTCUSDT");
          return { price: num(t.last), priceTime: Date.now() };
        }
        const parse = (rows) =>
          normalize((rows || []).map((r) => candle(Date.parse(r.timestamp) / 1000, r.open, r.max, r.min, r.close)));
        const [m15, h1, d1, w1] = await Promise.all(
          ["M15", "H1", "D1", "D7"].map((p) =>
            fetchJson(`https://api.hitbtc.com/api/3/public/candles/BTCUSDT?period=${p}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "phemex",
      name: "Phemex",
      pair: "sBTCUSDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      weekFromDaily: true,
      async load(kind) {
        const scale = 1e8;
        if (kind !== "candles") {
          const t = await fetchJson("https://api.phemex.com/md/spot/ticker/24hr?symbol=sBTCUSDT");
          const row = t.result;
          const last = row && (row.lastEp ?? row.closeEp ?? ((num(row.askEp) + num(row.bidEp)) / 2));
          return { price: num(last) != null ? last / scale : null, priceTime: Date.now() };
        }
        // [timestamp, resolution, open, close, high, low, ...]
        const now = Math.floor(Date.now() / 1000);
        const parse = (payload) => {
          const rows = (payload.data && payload.data.rows) || [];
          return normalize(rows.map((r) => candle(r[0], r[2] / scale, r[4] / scale, r[5] / scale, r[3] / scale)));
        };
        const [m15, h1, d1] = await Promise.all(
          [
            [900, 900 * 80],
            [3600, 3600 * 80],
            [86400, 86400 * 80],
          ].map(([res, span]) =>
            fetchJson(`https://api.phemex.com/exchange/public/md/kline?symbol=sBTCUSDT&resolution=${res}&from=${now - span}&to=${now}`)
          )
        );
        const daily = parse(d1);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(daily, 60), w1: take(weeklyFromDaily(daily), 24) };
      },
    },
    {
      id: "bybit",
      name: "Bybit",
      pair: "BTC/USDT",
      kind: "spot",
      quote: "USDT",
      inAverage: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT");
          const row = t.result && t.result.list && t.result.list[0];
          return { price: num(row && row.lastPrice), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize(((payload.result && payload.result.list) || []).map((r) => candle(r[0], r[1], r[2], r[3], r[4])));
        const [m15, h1, d1, w1] = await Promise.all(
          ["15", "60", "D", "W"].map((i) =>
            fetchJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=${i}&limit=80`)
          )
        );
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(parse(d1), 60), w1: take(parse(w1), 24) };
      },
    },
    {
      id: "dydx",
      name: "dYdX",
      pair: "BTC-USD perp",
      kind: "perp",
      quote: "USD",
      inAverage: false,
      weekFromDaily: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://indexer.dydx.trade/v4/perpetualMarkets");
          const m = t.markets && t.markets["BTC-USD"];
          return { price: num(m && (m.oraclePrice || m.lastPrice)), priceTime: Date.now() };
        }
        const parse = (payload) =>
          normalize(
            (payload.candles || []).map((r) =>
              candle(Date.parse(r.startedAt) / 1000, r.open, r.high, r.low, r.close)
            )
          );
        const [m15, h1, d1] = await Promise.all(
          ["15MINS", "1HOUR", "1DAY"].map((r) =>
            fetchJson(`https://indexer.dydx.trade/v4/candles/perpetualMarkets/BTC-USD?resolution=${r}&limit=80`)
          )
        );
        const daily = parse(d1);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(daily, 60), w1: take(weeklyFromDaily(daily), 24) };
      },
    },
    {
      id: "deribit",
      name: "Deribit",
      pair: "BTC-PERPETUAL",
      kind: "perp",
      quote: "USD",
      inAverage: false,
      weekFromDaily: true,
      async load(kind) {
        if (kind !== "candles") {
          const t = await fetchJson("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL");
          return { price: num(t.result && t.result.last_price), priceTime: Date.now() };
        }
        const now = Date.now();
        const parse = (payload) => {
          const r = payload.result || {};
          const ticks = r.ticks || [];
          return normalize(
            ticks.map((t, i) => candle(t / 1000, r.open[i], r.high[i], r.low[i], r.close[i]))
          );
        };
        const [m15, h1, d1] = await Promise.all(
          [
            [15, 15 * 60 * 1000 * 80],
            [60, 60 * 60 * 1000 * 80],
            ["1D", 86400 * 1000 * 80],
          ].map(([res, span]) =>
            fetchJson(
              `https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${now - span}&end_timestamp=${now}&resolution=${res}`
            )
          )
        );
        const daily = parse(d1);
        return { m15: take(parse(m15), 48), h1: take(parse(h1), 48), d1: take(daily, 60), w1: take(weeklyFromDaily(daily), 24) };
      },
    },
  ];

  const priceOnlySources = [
    {
      id: "coingecko",
      name: "CoinGecko",
      inAverage: true,
      async load() {
        const t = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
        return { price: num(t.bitcoin && t.bitcoin.usd), priceTime: Date.now() };
      },
    },
    {
      id: "coinpaprika",
      name: "CoinPaprika",
      inAverage: true,
      async load() {
        const t = await fetchJson("https://api.coinpaprika.com/v1/tickers/btc-bitcoin");
        return { price: num(t.quotes && t.quotes.USD && t.quotes.USD.price), priceTime: Date.now() };
      },
    },
    {
      id: "coinlore",
      name: "Coinlore",
      inAverage: true,
      async load() {
        const t = await fetchJson("https://api.coinlore.net/api/ticker/?id=90");
        return { price: num(t[0] && t[0].price_usd), priceTime: Date.now() };
      },
    },
    {
      id: "blockchain",
      name: "Blockchain.com",
      inAverage: true,
      async load() {
        const t = await fetchJson("https://blockchain.info/ticker");
        const usd = t.USD || {};
        return { price: num(usd.last || usd["15m"]), priceTime: Date.now() };
      },
    },
    {
      id: "bitso",
      name: "Bitso",
      inAverage: true,
      extra: true,
      async load() {
        const t = await fetchJson("https://api.bitso.com/v3/ticker/?book=btc_usd");
        return { price: num(t.payload && t.payload.last), priceTime: Date.now() };
      },
    },
    {
      id: "independentreserve",
      name: "Independent Reserve",
      inAverage: true,
      extra: true,
      async load() {
        const t = await fetchJson(
          "https://api.independentreserve.com/Public/GetMarketSummary?primaryCurrencyCode=Xbt&secondaryCurrencyCode=Usd"
        );
        const bid = num(t.CurrentHighestBidPrice);
        const ask = num(t.CurrentLowestOfferPrice);
        const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
        return { price: mid, priceTime: Date.now() };
      },
    },
  ];

  function emptyVenueState(v) {
    return {
      id: v.id,
      name: v.name,
      pair: v.pair,
      kind: v.kind,
      quote: v.quote,
      inAverage: v.inAverage,
      weekFromDaily: !!v.weekFromDaily,
      note: v.note || "",
      unavailableMessage: v.unavailableMessage || "",
      price: null,
      priceTime: 0,
      priceError: null,
      candles: {},
      candleError: null,
      candleTime: 0,
      flag: null,
      flagReason: "",
    };
  }

  venues.forEach((v) => (state.exchanges[v.id] = emptyVenueState(v)));
  priceOnlySources.forEach((s) => {
    state.priceOnly[s.id] = {
      id: s.id,
      name: s.name,
      inAverage: s.inAverage,
      extra: !!s.extra,
      price: null,
      priceTime: 0,
      error: null,
      flag: null,
      flagReason: "",
    };
  });

  function formatChange(ch) {
    if (!ch || !Number.isFinite(ch.pct)) return "—";
    return `<span class="dir ${dirClass(ch.pct)}">${dirLabel(ch.pct)}</span> <span>${pctText(ch.pct)}</span>`;
  }

  function ensureCharts(id, candles) {
    if (typeof LightweightCharts === "undefined") return;
    const periods = ["m15", "h1", "d1", "w1"];
    for (const p of periods) {
      const el = document.getElementById(`chart-${id}-${p}`);
      if (!el) continue;
      const data = candles[p] || [];
      let rec = charts.get(`${id}-${p}`);
      if (!rec) {
        const chart = LightweightCharts.createChart(el, {
          layout: {
            background: { type: "solid", color: "transparent" },
            textColor: "#6f695f",
            fontFamily: "Figtree, sans-serif",
            fontSize: 10,
          },
          grid: {
            vertLines: { color: "rgba(242,239,232,0.04)" },
            horzLines: { color: "rgba(242,239,232,0.04)" },
          },
          rightPriceScale: { borderVisible: false },
          timeScale: { borderVisible: false, visible: false },
          handleScroll: false,
          handleScale: false,
          width: el.clientWidth,
          height: el.clientHeight || 92,
        });
        const series = chart.addCandlestickSeries({
          upColor: "#3ddc86",
          downColor: "#f07272",
          borderUpColor: "#3ddc86",
          borderDownColor: "#f07272",
          wickUpColor: "#3ddc86",
          wickDownColor: "#f07272",
        });
        rec = { chart, series, el };
        charts.set(`${id}-${p}`, rec);
        const ro = new ResizeObserver(() => {
          if (rec.el.clientWidth) rec.chart.applyOptions({ width: rec.el.clientWidth, height: rec.el.clientHeight || 92 });
        });
        ro.observe(el);
      }
      if (data.length) {
        rec.series.setData(data);
        rec.chart.timeScale().fitContent();
      }
    }
  }

  function renderExchanges() {
    const root = document.getElementById("exchange-grid");
    if (!root.dataset.ready) {
      root.innerHTML = venues
        .map((v) => {
          const s = state.exchanges[v.id];
          return `<article class="card" id="card-${v.id}">
            <div class="card-head">
              <div>
                <h3>${escapeHtml(v.name)} <span class="kind-tag">${v.kind === "perp" ? "perpetual" : "spot"}</span></h3>
                <div class="pair">${escapeHtml(v.pair)}</div>
              </div>
              <div class="live-price">
                <div class="px" id="px-${v.id}">—</div>
                <div class="updated" id="upd-${v.id}"></div>
              </div>
            </div>
            <div class="qc-note" id="qc-${v.id}"></div>
            <div class="error-note" id="err-${v.id}"></div>
            <div class="reads">
              ${[
                ["m15", "15-minute"],
                ["h1", "Hour"],
                ["d1", "Daily"],
                ["w1", "Weekly"],
              ]
                .map(
                  ([k, label]) => `<div class="read">
                    <div class="read-top">
                      <span class="name">${label}</span>
                      <span class="chg" id="chg-${v.id}-${k}">—</span>
                    </div>
                    <div class="chart" id="chart-${v.id}-${k}"></div>
                    <div class="built-note" id="note-${v.id}-${k}"></div>
                  </div>`
                )
                .join("")}
            </div>
          </article>`;
        })
        .join("");
      root.dataset.ready = "1";
    }

    for (const v of venues) {
      const s = state.exchanges[v.id];
      const card = document.getElementById(`card-${v.id}`);
      card.classList.toggle("flagged", !!s.flag);
      card.classList.toggle("failed", !!(s.priceError && s.price == null));
      document.getElementById(`px-${v.id}`).textContent = s.price != null ? money(s.price) : "—";
      document.getElementById(`upd-${v.id}`).textContent = s.priceTime ? `Updated ${ptTime(s.priceTime)}` : "";
      const errBits = [];
      if (s.priceError) errBits.push(s.priceError);
      if (s.candleError) errBits.push(s.candleError);
      document.getElementById(`err-${v.id}`).textContent = errBits.join(" ");
      document.getElementById(`qc-${v.id}`).textContent = s.flag ? `QC: ${s.flagReason}` : s.note || "";
      for (const k of ["m15", "h1", "d1", "w1"]) {
        const ch = periodChange(s.candles[k]);
        document.getElementById(`chg-${v.id}-${k}`).innerHTML = formatChange(ch);
        const note = document.getElementById(`note-${v.id}-${k}`);
        note.textContent = k === "w1" && s.weekFromDaily && (s.candles.w1 || []).length ? "built from daily" : "";
      }
      ensureCharts(v.id, s.candles);
    }
  }

  function renderPriceOnly() {
    const root = document.getElementById("price-only");
    root.innerHTML = priceOnlySources
      .map((src) => {
        const s = state.priceOnly[src.id];
        const err = s.error || (s.flag ? `QC: ${s.flagReason}` : "");
        return `<article class="price-card ${s.flag ? "flagged" : ""}">
          <div>
            <div><strong>${escapeHtml(src.name)}</strong> <span class="badge">price only</span></div>
            <div class="updated">${s.priceTime ? `Updated ${ptTime(s.priceTime)}` : ""}${err ? " · " + escapeHtml(err) : ""}</div>
          </div>
          <div class="px">${s.price != null ? money(s.price) : "—"}</div>
        </article>`;
      })
      .join("");
  }

  function median(nums) {
    const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function mean(nums) {
    const a = nums.filter(Number.isFinite);
    if (!a.length) return null;
    return a.reduce((s, n) => s + n, 0) / a.length;
  }

  function applyQc() {
    const candidates = [];
    for (const s of Object.values(state.exchanges)) {
      s.flag = null;
      s.flagReason = "";
      if (!s.inAverage) continue;
      if (s.price == null) continue;
      if (s.priceError) continue;
      if (Date.now() - s.priceTime > QC_STALE_MS) {
        s.flag = "stale";
        s.flagReason = "stale price, left out of the average";
        continue;
      }
      candidates.push(s);
    }
    for (const s of Object.values(state.priceOnly)) {
      s.flag = null;
      s.flagReason = "";
      if (!s.inAverage || s.price == null || s.error) continue;
      if (Date.now() - s.priceTime > QC_STALE_MS) {
        s.flag = "stale";
        s.flagReason = "stale price, left out of the average";
        continue;
      }
      candidates.push(s);
    }
    const med = median(candidates.map((c) => c.price));
    const healthy = [];
    if (med != null) {
      for (const c of candidates) {
        const dev = Math.abs(c.price - med) / med;
        if (dev > QC_OUTLIER) {
          c.flag = "outlier";
          c.flagReason = `more than 1.5% from the median (${money(med)}), left out of the average`;
        } else {
          healthy.push(c);
        }
      }
    }
    return healthy;
  }

  function renderAverage() {
    const healthy = applyQc();
    const avg = mean(healthy.map((h) => h.price));
    document.getElementById("avg-price").textContent = avg != null ? money(avg) : "—";
    document.getElementById("avg-updated").textContent = `Last updated ${ptTime()}`;
    const names = healthy.map((h) => h.name);
    document.getElementById("avg-meta").textContent =
      avg != null
        ? `Average of ${healthy.length} healthy USD/USDT spot source${healthy.length === 1 ? "" : "s"}. Perpetual contracts, flagged reads, and Kalshi contract prices are left out.`
        : "Waiting for healthy spot prices.";

    const changes = { m15: [], h1: [], d1: [], w1: [] };
    for (const s of Object.values(state.exchanges)) {
      if (!s.inAverage || s.flag) continue;
      if (!healthy.some((h) => h.id === s.id)) continue;
      for (const k of Object.keys(changes)) {
        const ch = periodChange(s.candles[k]);
        if (ch && Number.isFinite(ch.pct)) changes[k].push(ch.pct);
      }
    }
    const ids = { m15: "avg-15m", h1: "avg-1h", d1: "avg-1d", w1: "avg-1w" };
    for (const [k, id] of Object.entries(ids)) {
      const m = mean(changes[k]);
      document.getElementById(id).innerHTML =
        m == null ? "—" : `<span class="dir ${dirClass(m)}">${dirLabel(m)}</span> <span>${pctText(m)}</span>`;
    }

    const k = state.kalshi.odds;
    const el = document.getElementById("kalshi-odds");
    if (k && Number.isFinite(k.yes)) {
      const pctUp = k.yes * 100;
      el.innerHTML = `Kalshi 15-minute implied up odds: <strong>${pctUp.toFixed(1)}% Yes</strong> (${money(k.yes, 2)} Yes / ${money(1 - k.yes, 2)} No)${k.title ? ` · ${escapeHtml(k.title)}` : ""}. These contract prices are not part of the dollar average.`;
    } else if (state.kalshi.error) {
      el.textContent = `Kalshi 15-minute up odds unavailable: ${state.kalshi.error}`;
    } else {
      el.textContent = "Kalshi 15-minute up odds will appear here once that market loads. Kalshi yes/no prices are not part of the dollar average.";
    }
  }

  function yesPrice(m) {
    const bid = num(m.yes_bid_dollars);
    const ask = num(m.yes_ask_dollars);
    const last = num(m.last_price_dollars);
    if (bid != null && ask != null) return (bid + ask) / 2;
    return last;
  }

  function marketRow(m) {
    const yes = yesPrice(m);
    const no = yes != null ? 1 - yes : null;
    const strike =
      m.subtitle ||
      m.yes_sub_title ||
      (m.floor_strike != null ? `${money(m.floor_strike)} or above` : "") ||
      (m.cap_strike != null ? `${money(m.cap_strike)} or below` : "");
    return `<tr>
      <td>${escapeHtml(strike || m.title || m.ticker)}</td>
      <td class="yes">${yes != null ? (yes * 100).toFixed(1) + "%" : "—"}</td>
      <td class="no">${no != null ? (no * 100).toFixed(1) + "%" : "—"}</td>
      <td>${m.close_time ? escapeHtml(ptTime(Date.parse(m.close_time))) : ""}</td>
    </tr>`;
  }

  function marketStrike(m) {
    if (m.floor_strike != null && m.cap_strike != null) {
      return (num(m.floor_strike) + num(m.cap_strike)) / 2;
    }
    if (m.floor_strike != null) return num(m.floor_strike);
    if (m.cap_strike != null) return num(m.cap_strike);
    return null;
  }

  function relevantMarkets(markets, spot) {
    const rows = (markets || []).map((m) => {
      const yes = yesPrice(m);
      const strike = marketStrike(m);
      const dist = spot != null && strike != null ? Math.abs(strike - spot) / spot : Number.POSITIVE_INFINITY;
      const interesting = yes != null && yes > 0.03 && yes < 0.97;
      return { m, yes, strike, dist, interesting };
    });
    let pick = rows.filter((r) => r.interesting || r.dist <= 0.1);
    if (pick.length < 8) {
      pick = rows.slice().sort((a, b) => a.dist - b.dist).slice(0, 12);
    } else {
      pick.sort((a, b) => a.dist - b.dist);
      pick = pick.slice(0, 16);
    }
    pick.sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));
    return { shown: pick.map((r) => r.m), total: rows.length };
  }

  async function fetchAllMarkets(eventTicker) {
    const all = [];
    let cursor = "";
    for (let i = 0; i < 8; i++) {
      const u =
        "https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open&event_ticker=" +
        encodeURIComponent(eventTicker) +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      const d = await fetchJson(u, { relay: "always" });
      all.push(...(d.markets || []));
      if (!d.cursor) break;
      cursor = d.cursor;
    }
    return all;
  }

  function pickEvent(events) {
    const list = (events || []).slice();
    list.sort((a, b) => Date.parse(a.strike_date || a.close_time || 0) - Date.parse(b.strike_date || b.close_time || 0));
    const now = Date.now();
    return list.find((e) => Date.parse(e.strike_date || e.close_time || 0) >= now - 5 * 60 * 1000) || list[0];
  }

  async function loadKalshi() {
    try {
      const [m15markets, rangeEvents, dailyEvents] = await Promise.all([
        fetchJson("https://api.elections.kalshi.com/trade-api/v2/markets?limit=20&status=open&series_ticker=KXBTC15M", { relay: "always" }),
        fetchJson("https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXBTC&status=open&limit=10", { relay: "always" }),
        fetchJson("https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXBTCD&status=open&limit=10", { relay: "always" }),
      ]);
      const m15 = (m15markets.markets || [])[0];
      if (m15) {
        const mid = yesPrice(m15);
        state.kalshi.odds = {
          yes: mid,
          title: m15.title || "BTC price up in next 15 mins?",
          close: m15.close_time,
        };
      }

      const rangeEv = pickEvent(rangeEvents.events);
      const dailyEv = pickEvent(dailyEvents.events);
      const extra = [];
      if (rangeEv) {
        extra.push(
          fetchAllMarkets(rangeEv.event_ticker).then((markets) => ({
            type: "range",
            event: rangeEv,
            markets,
          }))
        );
      }
      if (dailyEv) {
        extra.push(
          fetchAllMarkets(dailyEv.event_ticker).then((markets) => ({
            type: "daily",
            event: dailyEv,
            markets,
          }))
        );
      }
      const blocks = await Promise.all(extra);
      const spotGuess = Object.values(state.exchanges)
        .map((s) => s.price)
        .find((p) => Number.isFinite(p));

      const parts = [];
      if (m15) {
        const mid = yesPrice(m15);
        parts.push(`<article class="card">
          <div class="card-head">
            <div>
              <h3>15-minute up/down</h3>
              <div class="pair">${escapeHtml(m15.title || "")}</div>
            </div>
            <div class="live-price">
              <div class="px">${mid != null ? (mid * 100).toFixed(1) + "% Yes" : "—"}</div>
              <div class="updated">Closes ${m15.close_time ? ptTime(Date.parse(m15.close_time)) : ""}</div>
            </div>
          </div>
          <p class="section-note" style="margin:10px 0 0">Yes means BTC finishes the 15-minute window up (or unchanged) versus the start, per Kalshi’s BRTI rules. No is the other side.</p>
        </article>`);
      }

      const section = (title, ev, markets) => {
        const picked = relevantMarkets(markets, spotGuess);
        const rows = picked.shown.map(marketRow).join("");
        const note =
          picked.total > picked.shown.length
            ? `<p class="section-note" style="margin:10px 0 0">Showing ${picked.shown.length} of ${picked.total} open contracts, the ones nearest the current Bitcoin price.</p>`
            : "";
        return `<article class="card">
          <div class="card-head">
            <div>
              <h3>${escapeHtml(title)}</h3>
              <div class="pair">${escapeHtml((ev && ev.title) || "")}</div>
            </div>
          </div>
          ${note}
          <div style="overflow:auto;margin-top:10px">
            <table class="market-table">
              <thead><tr><th>Contract</th><th>Yes</th><th>No</th><th>Closes</th></tr></thead>
              <tbody>${rows || "<tr><td colspan=4>No open contracts returned.</td></tr>"}</tbody>
            </table>
          </div>
        </article>`;
      };

      for (const b of blocks) {
        if (b.type === "range") parts.push(section("Hourly / scheduled range", b.event, b.markets));
        if (b.type === "daily") parts.push(section("Daily / scheduled above-below", b.event, b.markets));
      }

      state.kalshi.html = parts.join("") || `<p class="error-note">No open Kalshi Bitcoin markets were returned.</p>`;
      state.kalshi.error = null;
      state.kalshi.updated = Date.now();
    } catch (err) {
      state.kalshi.error = String(err.message || err);
      if (!state.kalshi.html) {
        state.kalshi.html = `<p class="error-note">Kalshi markets unavailable: ${escapeHtml(state.kalshi.error)}</p>`;
      }
    }
    document.getElementById("kalshi").innerHTML = state.kalshi.html;
  }

  async function loadVenuePrice(v) {
    const s = state.exchanges[v.id];
    try {
      const data = await v.load("price");
      if (data.price == null) throw new Error("no price in response");
      s.price = data.price;
      s.priceTime = data.priceTime || Date.now();
      s.priceError = null;
    } catch (err) {
      s.priceError = v.unavailableMessage && (String(err.message || "").includes("HTTP 45") || String(err.message || "").includes("HTTP 403") || String(err.message || "").includes("Failed") || String(err.message || "").includes("Network") || String(err.message || "").includes("fetch"))
        ? v.unavailableMessage
        : `Price unavailable: ${err.message || err}`;
    }
  }

  async function loadVenueCandles(v) {
    const s = state.exchanges[v.id];
    try {
      const data = await v.load("candles");
      s.candles = {
        m15: data.m15 || [],
        h1: data.h1 || [],
        d1: data.d1 || [],
        w1: data.w1 || [],
      };
      if (!s.candles.m15.length && !s.candles.h1.length && !s.candles.d1.length) {
        throw new Error("no candles in response");
      }
      s.candleTime = Date.now();
      s.candleError = null;
      if (s.price == null && s.candles.m15.length) {
        s.price = s.candles.m15[s.candles.m15.length - 1].close;
        s.priceTime = Date.now();
      }
    } catch (err) {
      s.candleError = v.unavailableMessage && (String(err.message || "").includes("HTTP 45") || String(err.message || "").includes("HTTP 403"))
        ? v.unavailableMessage
        : `Candles unavailable: ${err.message || err}`;
    }
  }

  async function loadPriceOnly() {
    await Promise.all(
      priceOnlySources.map(async (src) => {
        const s = state.priceOnly[src.id];
        try {
          const data = await src.load();
          if (data.price == null) throw new Error("no price in response");
          s.price = data.price;
          s.priceTime = data.priceTime || Date.now();
          s.error = null;
        } catch (err) {
          s.error = String(err.message || err);
        }
      })
    );
  }

  async function refreshPrices() {
    await Promise.all([
      ...venues.map((v) => loadVenuePrice(v)),
      loadPriceOnly(),
    ]);
    renderExchanges();
    renderPriceOnly();
    renderAverage();
  }

  async function refreshCandles() {
    await mapLimit(venues, 6, (v) => loadVenueCandles(v));
    renderExchanges();
    renderAverage();
  }

  async function boot() {
    renderExchanges();
    renderPriceOnly();
    renderAverage();
    await Promise.all([refreshPrices(), refreshCandles(), loadKalshi()]);
    renderExchanges();
    renderPriceOnly();
    renderAverage();
    setInterval(refreshPrices, PRICE_MS);
    setInterval(refreshCandles, CANDLE_MS);
    setInterval(loadKalshi, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
