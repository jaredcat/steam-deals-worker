# Steam Deals Worker

A [Cloudflare Worker](https://workers.cloudflare.com/) that returns a **random game deal** from [CheapShark](https://www.cheapshark.com/) for games the user **doesn’t already own** on Steam.

Useful for “surprise me with a deal” flows, widgets, or [TRMNL](https://trmnl.com?ref=krylic) dynamic polling.

For example, used in a private fork of TRMNL plugin [Steam Deals of the Day](https://trmnl.com/recipes/18131)

## How it works

1. Fetches current deals from CheapShark (with optional filters: max price, Metacritic score, Steam rating, etc.).
2. Fetches the user’s owned Steam app IDs via the Steam Web API.
3. Filters out deals for games the user already owns.
4. Returns one random deal from the remaining list (or `null` if none match).

Deals and Steam library data are cached (configurable TTLs) to reduce external API calls.

## Requirements

- **Steam Web API key** – [Get one here](https://steamcommunity.com/dev/apikey) (required).
- Node.js and npm (for local dev and deployment).

## Quick start

```bash
npm install
```

Set your Steam API key as a secret:

```bash
npx wrangler secret put STEAM_API_KEY
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

## API

**Endpoint:** `GET` (or `POST`/`PUT`/`PATCH` with JSON body for TRMNL; body and optional `X-Steam-Id` header override query params).

### Required

| Parameter  | Description                    |
|-----------|---------------------------------|
| `steamId` | Steam 64-bit ID (e.g. `76561198006409530`). |

### Optional (CheapShark filters)

| Parameter        | Default | Description                                      |
|------------------|--------|--------------------------------------------------|
| `csMaxAge`       | `24`   | Deal age in hours.                              |
| `csMetacritic`   | `1`    | Min Metacritic (0 = any).                        |
| `csSteamRating`  | `1`    | Min Steam rating (0 = any).                      |
| `csUpperPrice`   | `15`   | Max price (USD).                                |
| `csMinSaving`    | `0`    | Min savings percentage.                          |
| `csMinDealRating`| `0`    | Min CheapShark deal rating.                     |
| `csStoreIds`     | `1,3,11,15` | Comma-separated store IDs (1=Steam, 3=GMG, 11=Humble, 15=Fanatical, etc.). |

### Example

```http
GET https://your-worker.workers.dev/?steamId=76561198006409530&csUpperPrice=20
```

### Response

- **200** – `{ "deal": <deal object or null>, "meta": { "cache": {...}, "cacheHits": {...}, "counts": {...}, "params": {... } } }`
- **400** – Missing `steamId`.
- **403** – Could not read Steam library (e.g. profile/game details private).
- **502** – Upstream error (CheapShark or Steam API).

When the user’s Steam profile or “Game details” is private, the worker returns **403** with a message asking them to set visibility to public.

## Configuration (wrangler / env)

| Variable              | Required | Description |
|-----------------------|----------|-------------|
| `STEAM_API_KEY`       | Yes      | Steam Web API key. Set via `npx wrangler secret put STEAM_API_KEY`. |
| `STEAM_CACHE_TTL`     | No       | Default Steam library cache TTL (seconds). Default: 7 days. |
| `STEAM_ID_TTLS`       | No       | JSON map of `SteamID → TTL` in seconds, e.g. `{"76561198006409530": 86400}`. |
| `CHEAPSHARK_CACHE_TTL`| No       | Deals cache TTL in seconds. Default: 24 hours. |

## References

- [CheapShark API](https://apidocs.cheapshark.com/)
- [Steam Web API – IPlayerService/GetOwnedGames](https://partner.steamgames.com/doc/webapi/IPlayerService)