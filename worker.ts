/// <reference types="@cloudflare/workers-types" />

/**
 * Steam Deals Worker – returns a random deal from CheapShark for games the user doesn’t own on Steam.
 *
 * Input: GET with query params, or POST/PUT/PATCH with JSON body (body overrides query).
 * TRMNL (trmnl.com) can use request body or headers instead of building long URLs.
 * Optional header: X-Steam-Id (overrides steamId from query/body).
 *
 * API references:
 * - CheapShark: https://apidocs.cheapshark.com/
 * - Steam Web API (IPlayerService/GetOwnedGames): https://partner.steamgames.com/doc/webapi/IPlayerService
 * - TRMNL dynamic polling: https://help.trmnl.com/en/articles/12689499-dynamic-polling-urls
 */

const STEAM_CACHE_TTL_DEFAULT = 60 * 60 * 24 * 7; // 7 days
const CHEAPSHARK_CACHE_TTL_DEFAULT = 60 * 60 * 24; // 24 hours

function getSteamTtl(env: Env, steamId: string): number {
  const defaultTtl = env.STEAM_CACHE_TTL ?? STEAM_CACHE_TTL_DEFAULT;
  if (!env.STEAM_ID_TTLS) return defaultTtl;
  try {
    const ttls = JSON.parse(env.STEAM_ID_TTLS) as Record<string, number>;
    const ttl = ttls[steamId];
    return typeof ttl === "number" && ttl >= 0 ? ttl : defaultTtl;
  } catch {
    return defaultTtl;
  }
}

/** Metadata returned in every response for debugging and client use */
export interface ResponseMeta {
  /** Cache TTLs in seconds (deals = CheapShark, steam = owned games) */
  cache: {
    dealsTtlSeconds: number;
    steamTtlSeconds: number;
  };
  /** Whether each source was served from cache (useful for debugging) */
  cacheHits?: {
    deals: boolean;
    steam: boolean;
  };
  /** Counts when deal data was fetched */
  counts?: {
    totalDeals: number;
    filteredDeals: number;
    ownedAppCount: number;
  };
  /** Request params. Prefixed: steamId (Steam), cs* (CheapShark). */
  params?: {
    steamId: string;
    csMaxAge: string;
    csMetacritic: string;
    csSteamRating: string;
    csUpperPrice: string;
    csMinSaving: number;
    csMinDealRating: number;
    csStoreIds: number[];
  };
}

export interface Env {
  STEAM_API_KEY: string;
  STEAM_CACHE_TTL?: number;
  /** Optional. CheapShark cache TTL in seconds. Default 24 hours. */
  CHEAPSHARK_CACHE_TTL?: string;
  /**
   * Optional. JSON object mapping SteamID (string) to cache TTL in seconds (number).
   * Example: {"76561198006409530": 86400, "76561198123456789": 3600}
   * Unlisted IDs use the default (7 days).
   */
  STEAM_ID_TTLS?: string;
}

function getCheapsharkTtl(env: Env): number {
  if (env.CHEAPSHARK_CACHE_TTL === undefined || env.CHEAPSHARK_CACHE_TTL === "") {
    return CHEAPSHARK_CACHE_TTL_DEFAULT;
  }
  const n = Number(env.CHEAPSHARK_CACHE_TTL);
  return Number.isInteger(n) && n >= 0 ? n : CHEAPSHARK_CACHE_TTL_DEFAULT;
}

export interface DealParams {
  maxAge: string;
  metacritic: string;
  steamRating: string;
  upperPrice: string;
  minSaving: number;
  minDealRating: number;
  storeIds: number[];
}

/** Optional JSON body (POST/PUT/PATCH). Same keys as query; body overrides query. */
interface RequestBody {
  steamId?: string;
  csMaxAge?: string;
  csMetacritic?: string;
  csSteamRating?: string;
  csUpperPrice?: string;
  csMinSaving?: number | string;
  csMinDealRating?: number | string;
  csStoreIds?: number[] | string;
}

/**
 * CheapShark ACTIVE store IDs (for csStoreIds param). Default below = Steam, GreenManGaming, Humble, Fanatical.
 * 1=Steam, 2=GamersGate, 3=GreenManGaming, 4=Amazon, 7=GOG, 8=Origin, 11=Humble Store, 13=Uplay,
 * 15=Fanatical, 21=WinGameStore, 23=GameBillet, 24=Voidu, 25=Epic Games Store, 27=Gamesplanet,
 * 28=Gamesload, 29=2Game, 30=IndieGala, 31=Blizzard Shop, 33=DLGamer, 34=Noctre, 35=DreamGame.
 */
const DEFAULT_STORE_IDS = [1, 3, 11, 15];

function parseStoreIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((n) => Number(n)).filter((n) => !Number.isNaN(n));
  if (typeof value === "string") return value.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  return DEFAULT_STORE_IDS;
}

/**
 * Read input from query, optional JSON body (POST/PUT/PATCH), and optional header X-Steam-Id.
 * Body and header override query. TRMNL-friendly: use body or headers instead of long URLs.
 */
async function getInput(request: Request, url: URL): Promise<{ steamId: string | null; params: DealParams }> {
  const hasBody = ["POST", "PUT", "PATCH"].includes(request.method);
  const contentType = request.headers.get("Content-Type") ?? "";
  const isJson = contentType.includes("application/json");

  let body: RequestBody | null = null;
  if (hasBody && isJson) {
    try {
      const raw = await request.json();
      body = typeof raw === "object" && raw !== null ? (raw as RequestBody) : null;
    } catch {
      body = null;
    }
  }

  const get = (queryKey: string, bodyKey: keyof RequestBody): string | undefined =>
    (body?.[bodyKey] !== undefined && body[bodyKey] !== "" ? String(body[bodyKey]) : undefined) ??
    url.searchParams.get(queryKey) ??
    undefined;

  const steamId =
    request.headers.get("X-Steam-Id")?.trim() ||
    (body?.steamId !== undefined && body.steamId !== "" ? String(body.steamId) : null) ||
    url.searchParams.get("steamId");

  const csStoreIdsRaw = body?.csStoreIds ?? url.searchParams.get("csStoreIds");
  const storeIds = parseStoreIds(csStoreIdsRaw ?? DEFAULT_STORE_IDS);

  const params: DealParams = {
    maxAge: get("csMaxAge", "csMaxAge") ?? "24",
    metacritic: get("csMetacritic", "csMetacritic") ?? "1",
    steamRating: get("csSteamRating", "csSteamRating") ?? "1",
    upperPrice: get("csUpperPrice", "csUpperPrice") ?? "15",
    minSaving: Number(get("csMinSaving", "csMinSaving") ?? "0"),
    minDealRating: Number(get("csMinDealRating", "csMinDealRating") ?? "0"),
    storeIds,
  };

  return { steamId: steamId || null, params };
}

/** Deal object from CheapShark /deals API (https://apidocs.cheapshark.com/) – normalized to camelCase id */
export interface CheapSharkDeal {
  dealId: string;
  storeId: string;
  title: string;
  salePrice: string;
  normalPrice: string;
  savings: string;
  dealRating: string;
  steamAppId: string;
  /** Internal game name (e.g. for lookup) */
  internalName?: string;
  /** CheapShark game id */
  gameId?: string;
  /** Metacritic score when available */
  metacriticScore?: string;
  /** Steam rating 0–100 */
  steamRatingPercent?: string;
  steamRatingCount?: string;
  /** Release date (Unix timestamp string) */
  releaseDate?: string;
  /** Last deal change (Unix timestamp) */
  lastChange?: number;
  /** Thumbnail URL */
  thumb?: string;
  [key: string]: unknown;
}

/** Raw deal shape from CheapShark API (they use dealID, storeID, etc.) */
interface CheapSharkDealRaw {
  dealID: string;
  storeID: string;
  steamAppID: string;
  gameID?: string;
  [key: string]: unknown;
}

function normalizeDeal(raw: CheapSharkDealRaw): CheapSharkDeal {
  const { dealID, storeID, steamAppID, gameID, ...rest } = raw;
  return {
    ...rest,
    dealId: dealID,
    storeId: storeID,
    steamAppId: steamAppID,
    gameId: gameID,
  } as CheapSharkDeal;
}

/** Response from Steam Web API IPlayerService/GetOwnedGames */
interface SteamOwnedGamesResponse {
  response?: {
    game_count?: number;
    games?: Array<{ appid: number; playtime_forever?: number; playtime_2weeks?: number }>;
  };
}

/**
 * Thrown when we cannot retrieve a user's Steam library (e.g. private profile).
 * Use this to return 403 so clients can show a specific message.
 */
export class SteamLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteamLibraryError";
    Object.setPrototypeOf(this, SteamLibraryError.prototype);
  }
}

/**
 * Build a cache key URL using the Worker's origin (recommended by Cloudflare:
 * https://developers.cloudflare.com/workers/runtime-apis/cache/).
 * Using the Worker hostname avoids DNS lookups and cache inefficiencies.
 */
function getCacheKey(originalUrl: string, workerOrigin: string): string {
  const encoded = encodeURIComponent(originalUrl);
  return `${workerOrigin}/cache/${encoded}`;
}

async function getCachedJson<T>(
  url: string,
  ttl: number,
  fetcher: () => Promise<T>
): Promise<{ data: T; fromCache: boolean }> {
  const cache = caches.default;
  const cached = await cache.match(url);

  if (cached) {
    return { data: (await cached.json()) as T, fromCache: true };
  }

  const data = await fetcher();

  await cache.put(
    url,
    new Response(JSON.stringify(data), {
      headers: { "Cache-Control": `max-age=${ttl}` },
    })
  );

  return { data, fromCache: false };
}

async function getDeals(
  params: DealParams,
  workerOrigin: string,
  dealsTtl: number
): Promise<{ deals: CheapSharkDeal[]; fromCache: boolean }> {
  const cheapsharkUrl = `https://www.cheapshark.com/api/1.0/deals?storeID=${params.storeIds.join(",")}&pageSize=100&maxAge=${params.maxAge}&metacritic=${params.metacritic}&steamRating=${params.steamRating}&upperPrice=${params.upperPrice}`;

  const { data, fromCache } = await getCachedJson<CheapSharkDeal[]>(
    getCacheKey(cheapsharkUrl, workerOrigin),
    dealsTtl,
    async () => {
      const res = await fetch(cheapsharkUrl);
      if (!res.ok) {
        throw new Error(`CheapShark API error: ${res.status} ${res.statusText}`);
      }
      const raw = (await res.json()) as CheapSharkDealRaw[];
      return raw.map(normalizeDeal);
    }
  );
  // Normalize in case cache had old raw shape (dealID, steamAppID, etc.)
  const deals = data[0] && "steamAppID" in data[0]
    ? (data as unknown as CheapSharkDealRaw[]).map(normalizeDeal)
    : data;
  return { deals, fromCache };
}

async function getOwnedAppIds(
  env: Env,
  steamId: string,
  workerOrigin: string
): Promise<{ appIds: Set<number>; fromCache: boolean }> {
  const steamUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${env.STEAM_API_KEY}&steamid=${steamId}&format=json`;
  const ttl = getSteamTtl(env, steamId);

  const { data: appIds, fromCache } = await getCachedJson<number[]>(
    getCacheKey(steamUrl, workerOrigin),
    ttl,
    async () => {
      const res = await fetch(steamUrl);
      if (res.status === 403) {
        throw new SteamLibraryError(
          "Could not retrieve owned games: access denied. The user's game library may be set to private. They need to set their Steam profile (and \"My profile\" / \"Game details\") to public."
        );
      }
      if (!res.ok) {
        throw new SteamLibraryError(
          `Could not retrieve owned games: Steam API returned ${res.status} ${res.statusText}.`
        );
      }
      const json = (await res.json()) as SteamOwnedGamesResponse;
      const games = json.response?.games;
      if (!Array.isArray(games)) {
        throw new SteamLibraryError(
          "Could not retrieve owned games. The user's game library may be set to private, or the Steam ID may be invalid. They need to set their Steam profile and \"Game details\" to public."
        );
      }
      return games.map((g) => g.appid);
    }
  );

  return { appIds: new Set(appIds), fromCache };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const steamId = url.searchParams.get("steamId");

    const dealsTtlSeconds = getCheapsharkTtl(env);

    if (!steamId) {
      return Response.json(
        {
          deal: null,
          error: "Missing steamId parameter",
          meta: {
            cache: {
              dealsTtlSeconds,
              steamTtlSeconds: STEAM_CACHE_TTL_DEFAULT,
            },
          },
        },
        { status: 400 }
      );
    }

    const steamTtlSeconds = getSteamTtl(env, steamId);
    const baseMeta: ResponseMeta = {
      cache: {
        dealsTtlSeconds,
        steamTtlSeconds,
      },
    };

    const params: DealParams = {
      maxAge: url.searchParams.get("csMaxAge") ?? "24",
      metacritic: url.searchParams.get("csMetacritic") ?? "1",
      steamRating: url.searchParams.get("csSteamRating") ?? "1",
      upperPrice: url.searchParams.get("csUpperPrice") ?? "15",
      minSaving: Number(url.searchParams.get("csMinSaving") ?? "0"),
      minDealRating: Number(url.searchParams.get("csMinDealRating") ?? "0"),
      storeIds: (url.searchParams.get("csStoreIds") ?? "1,3,11,15")
        .split(",")
        .map(Number),
    };

    try {
      const workerOrigin = new URL(request.url).origin;
      const [
        { deals, fromCache: dealsFromCache },
        { appIds: ownedAppIds, fromCache: steamFromCache },
      ] = await Promise.all([
        getDeals(params, workerOrigin, dealsTtlSeconds),
        getOwnedAppIds(env, steamId, workerOrigin),
      ]);

      const filtered = deals.filter(
        (deal) =>
          parseFloat(deal.savings) >= params.minSaving &&
          parseFloat(deal.dealRating) >= params.minDealRating &&
          !ownedAppIds.has(parseInt(deal.steamAppId, 10))
      );

      const meta: ResponseMeta = {
        ...baseMeta,
        cacheHits: { deals: dealsFromCache, steam: steamFromCache },
        counts: {
          totalDeals: deals.length,
          filteredDeals: filtered.length,
          ownedAppCount: ownedAppIds.size,
        },
        params: {
          steamId,
          csMaxAge: params.maxAge,
          csMetacritic: params.metacritic,
          csSteamRating: params.steamRating,
          csUpperPrice: params.upperPrice,
          csMinSaving: params.minSaving,
          csMinDealRating: params.minDealRating,
          csStoreIds: params.storeIds,
        },
      };

      if (filtered.length === 0) {
        return Response.json({ deal: null, meta });
      }

      const randomDeal =
        filtered[Math.floor(Math.random() * filtered.length)];

      return Response.json({ deal: randomDeal, meta });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const status = err instanceof SteamLibraryError ? 403 : 502;
      return Response.json(
        {
          deal: null,
          error: message,
          meta: baseMeta,
        },
        { status }
      );
    }
  },
};
