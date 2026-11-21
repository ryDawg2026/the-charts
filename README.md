# The Charts

A public, read-only page of live Bitcoin prices and 15-minute, hourly, daily, and weekly candle reads from major exchanges and data sites.

Live site: https://rydawg2026.github.io/the-charts/

The page fetches public, no-key APIs in the browser. A small Cloudflare Worker, `the-charts-relay`, is a GET-only proxy with a host allowlist for APIs that do not send CORS headers (including Kalshi). It does not place trades or use an account.

This project is independent and is not affiliated with any exchange, Kalshi, or any AI lab.
