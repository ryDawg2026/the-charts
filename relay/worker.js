/**
 * the-charts-relay
 * Read-only GET proxy for public Bitcoin market-data hosts that block browser CORS.
 * No keys, no trading, no other workers involved.
 */
const ALLOWED_HOSTS = new Set([
  "api.elections.kalshi.com",
  "api.huobi.pro",
  "api.htx.com",
  "api-pub.bitfinex.com",
  "api.kraken.com",
  "www.okx.com",
  "okx.com",
  "api.crypto.com",
  "api.kucoin.com",
  "api.mexc.com",
  "api.poloniex.com",
  "api.upbit.com",
  "api.gemini.com",
  "api.coinpaprika.com",
  "www.deribit.com",
  "api.bybit.com",
  "www.bitmex.com",
  "api.bitflyer.com",
  "api.hitbtc.com",
  "whitebit.com",
  "www.whitebit.com",
  "api.phemex.com",
  "api.luno.com",
  "api.bitso.com",
  "sapi.xt.com",
  "api.independentreserve.com",
  "api.bithumb.com",
  "api.exchange.coinbase.com",
  "api.binance.us",
  "www.bitstamp.net",
  "api.gateio.ws",
  "api.bitget.com",
  "open-api.bingx.com",
  "indexer.dydx.trade",
  "api.coingecko.com",
  "api.coinlore.net",
  "blockchain.info",
  "api.blockchain.info",
  "api.bitso.com",
]);

const MAX_BYTES = 2_000_000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...extra,
    },
  });
}

function cacheTtl(target) {
  const u = target.toLowerCase();
  if (
    /kline|klines|candle|candles|candlestick|ohlc|ohlcv|bucketed|chart_data/.test(u)
  ) {
    return 45;
  }
  if (/markets|events|series/.test(u) && u.includes("kalshi")) return 20;
  return 12;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "GET only" }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      if (!url.searchParams.get("url")) {
        return json({ ok: true, service: "the-charts-relay" });
      }
    }

    const target = url.searchParams.get("url");
    if (!target) return json({ error: "missing url parameter" }, 400);

    let dest;
    try {
      dest = new URL(target);
    } catch {
      return json({ error: "invalid url" }, 400);
    }
    if (dest.protocol !== "https:") return json({ error: "https only" }, 400);
    if (dest.username || dest.password) return json({ error: "invalid url" }, 400);
    if (!ALLOWED_HOSTS.has(dest.hostname)) {
      return json({ error: "host not allowed" }, 403);
    }

    const ttl = cacheTtl(dest.toString());
    const cache = caches.default;
    const cacheKey = new Request(
      "https://the-charts-relay.cache/v1/" + dest.toString(),
      { method: "GET" }
    );
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set("Access-Control-Allow-Origin", "*");
      hit.headers.set("X-Relay-Cache", "hit");
      return hit;
    }

    let upstream;
    try {
      upstream = await fetch(dest.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
          "User-Agent": "TheChartsRelay/1.0",
        },
      });
    } catch (err) {
      return json({ error: "upstream fetch failed", detail: String(err) }, 502);
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get("Location");
      if (!loc) return json({ error: "redirect without location" }, 502);
      let next;
      try {
        next = new URL(loc, dest);
      } catch {
        return json({ error: "invalid redirect" }, 502);
      }
      if (next.protocol !== "https:" || !ALLOWED_HOSTS.has(next.hostname)) {
        return json({ error: "redirect host not allowed" }, 502);
      }
      try {
        upstream = await fetch(next.toString(), {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
            "User-Agent": "TheChartsRelay/1.0",
          },
        });
      } catch (err) {
        return json({ error: "redirect fetch failed", detail: String(err) }, 502);
      }
    }

    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return json({ error: "upstream response too large" }, 502);
    }

    const contentType =
      upstream.headers.get("Content-Type") || "application/json; charset=utf-8";
    const out = new Response(buf, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${ttl}`,
        "X-Relay-Cache": "miss",
        "X-Upstream-Status": String(upstream.status),
        ...corsHeaders(),
      },
    });

    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
    }
    return out;
  },
};
