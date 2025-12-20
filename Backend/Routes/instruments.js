// Routes/instruments.js - KITE VERSION
// Updated to use Kite instrument schema (instrument_token, name, lot_size, etc.)

import { Router } from "express";
import Instrument from "../Model/InstrumentModel.js";
import { getCache, setCache } from "../services/redisCache.js";

const router = Router();

// ==================== SEARCH OPTIMIZATION CACHE ====================
const searchCache = new Map();
const SEARCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

const searchAnalytics = new Map();
const ANALYTICS_WINDOW = 60 * 60 * 1000; // 1 hour

function trackSearch(query, category, resultsCount) {
    const key = `${query.toLowerCase()}:${category}`;
    const now = Date.now();
    if (!searchAnalytics.has(key)) {
        searchAnalytics.set(key, { query, category, count: 0, lastSearched: now, avgResults: 0 });
    }
    const stats = searchAnalytics.get(key);
    stats.count++;
    stats.lastSearched = now;
    stats.avgResults = Math.round((stats.avgResults * (stats.count - 1) + resultsCount) / stats.count);
}

function getTopSearches(limit = 20) {
    const now = Date.now();
    return Array.from(searchAnalytics.entries())
        .filter(([_, stats]) => (now - stats.lastSearched) < ANALYTICS_WINDOW)
        .map(([key, stats]) => ({ key, ...stats }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

// Cache cleanup interval
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of searchCache.entries()) {
        if (now - value.timestamp > SEARCH_CACHE_TTL) searchCache.delete(key);
    }
    console.log(`[Cache Cleanup] Search: ${searchCache.size} entries`);
}, 5 * 60 * 1000);

// ==================== KITE SEGMENT MAPPING ====================
// Kite segments: NFO-FUT, NFO-OPT, BFO-FUT, BFO-OPT, MCX-FUT, MCX-OPT, NSE, BSE, INDICES
// Kite instrument_type: FUT, CE, PE, EQ

// Map category filter to Kite segment patterns
function getSegmentFilter(category) {
    switch (category) {
        case "F&O":
            return { $in: ["NFO-FUT", "NFO-OPT", "BFO-FUT", "BFO-OPT"] };
        case "Commodity":
            return { $in: ["MCX-FUT", "MCX-OPT", "CDS-FUT", "CDS-OPT"] };
        case "Index":
        case "NSE_INDEX":
            return { $in: ["INDICES"] };
        case "Equity":
            return { $in: ["NSE", "BSE"] };
        case "All":
        default:
            // Default: F&O + Commodity (excluding indices and equity for trading)
            return { $in: ["NFO-FUT", "NFO-OPT", "BFO-FUT", "BFO-OPT", "MCX-FUT", "MCX-OPT"] };
    }
}

// Check if instrument is a futures contract
function isFutures(instrument_type) {
    return instrument_type === "FUT";
}

// Check if instrument is an options contract
function isOptions(instrument_type) {
    return ["CE", "PE"].includes(instrument_type);
}

// ==================== SEARCH ENDPOINT ====================
router.get("/search", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();
        const category = String(req.query.category || "All").trim();
        if (!q) return res.json([]);

        // Cache check
        const cacheKey = `search:${q.toLowerCase()}:${category}`;
        const now = Date.now();

        const redisCache = await getCache(cacheKey);
        if (redisCache) {
            console.log(`[Search Redis Cache HIT] "${q}" (${category}) - ${redisCache.length} results`);
            trackSearch(q, category, redisCache.length);
            return res.json(redisCache);
        }

        const memoryCached = searchCache.get(cacheKey);
        if (memoryCached && (now - memoryCached.timestamp) < SEARCH_CACHE_TTL) {
            console.log(`[Search Memory Cache HIT] "${q}" (${category}) - ${memoryCached.results.length} results`);
            trackSearch(q, category, memoryCached.results.length);
            return res.json(memoryCached.results);
        }

        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const segmentFilter = getSegmentFilter(category);
        const currentDate = new Date();

        // Simple search: Get all matching instruments (futures + options)
        const searchResults = await Instrument.aggregate([
            {
                $match: {
                    segment: segmentFilter,
                    expiry: { $gte: currentDate },
                    $or: [
                        { tradingsymbol: regex },
                        { name: regex }
                    ]
                }
            },
            {
                $addFields: {
                    // Prioritize futures over options
                    typeScore: {
                        $cond: {
                            if: { $eq: ["$instrument_type", "FUT"] },
                            then: 1000,
                            else: 0
                        }
                    },
                    // Sort by nearest expiry first
                    expiryScore: { $subtract: [0, { $toLong: "$expiry" }] }
                }
            },
            { $sort: { typeScore: -1, expiryScore: -1 } },
            { $limit: 200 }
        ]);

        // Format response with Kite fields
        const results = searchResults.map(item => ({
            _id: item._id,
            instrument_token: item.instrument_token,
            exchange_token: item.exchange_token,
            tradingsymbol: item.tradingsymbol,
            name: item.name,
            segment: item.segment,
            exchange: item.exchange,
            instrument_type: item.instrument_type,
            expiry: item.expiry,
            strike: item.strike,
            lot_size: item.lot_size,
            tick_size: item.tick_size,
            last_price: item.last_price
        }));

        console.log(`[Search] Returning ${results.length} results for "${q}"`);
        trackSearch(q, category, results.length);
        searchCache.set(cacheKey, { results, timestamp: Date.now() });
        setCache(cacheKey, results, 120).catch(console.error);
        res.json(results);

    } catch (e) {
        console.error("instruments/search error:", e);
        res.status(500).json({ error: "failed" });
    }
});

// ==================== WATCHLIST ENDPOINT ====================
router.get("/watchlist", async (req, res) => {
    try {
        const start = Date.now();
        const popularKeywords = [
            "NIFTY", "BANKNIFTY", "RELIANCE", "HDFCBANK", "TATASTEEL",
            "SBIN", "ICICIBANK", "INFY", "TCS", "ADANIENT"
        ];

        const currentDate = new Date();
        const results = [];

        for (const keyword of popularKeywords.slice(0, 5)) {
            const futDoc = await Instrument.findOne({
                name: { $regex: new RegExp(`^${keyword}$`, 'i') },
                instrument_type: "FUT",
                expiry: { $gte: currentDate }
            })
                .sort({ expiry: 1 })
                .lean();

            if (futDoc) results.push(futDoc);
        }

        console.log(`[Watchlist API] Loaded ${results.length} instruments in ${Date.now() - start}ms`);
        res.json(results);
    } catch (e) {
        console.error("instruments/watchlist error:", e);
        res.status(500).json({ error: "failed" });
    }
});

// ==================== INDEXES ENDPOINT ====================
router.get("/indexes", async (req, res) => {
    try {
        const cacheKey = 'indexes:all';

        // Check memory cache
        const cached = searchCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < 5 * 60 * 1000) {
            return res.json(cached.results);
        }

        // Kite: Indices are in segment "INDICES"
        const indexes = await Instrument.find({
            segment: "INDICES"
        })
            .limit(50)
            .lean();

        const results = indexes.map(item => ({
            instrument_token: item.instrument_token,
            tradingsymbol: item.tradingsymbol,
            name: item.name,
            segment: item.segment,
            exchange: item.exchange
        }));

        console.log(`[Indexes] Found ${results.length} index instruments`);
        searchCache.set(cacheKey, { results, timestamp: Date.now() });
        res.json(results);
    } catch (e) {
        console.error("instruments/indexes error:", e);
        res.status(500).json({ error: "failed" });
    }
});

// ==================== RESOLVE ENDPOINT ====================
router.get("/resolve", async (req, res) => {
    try {
        const { segment, tradingsymbol, name, instrument_type, expiry, strike } = req.query;
        const q = {};
        if (segment) q.segment = segment.toUpperCase();
        if (tradingsymbol) q.tradingsymbol = tradingsymbol.toUpperCase();
        if (name) q.name = name.toUpperCase();
        if (instrument_type) q.instrument_type = instrument_type.toUpperCase();
        if (expiry) q.expiry = new Date(expiry);
        if (strike) q.strike = Number(strike);

        const doc = await Instrument.findOne(q).lean();
        if (!doc) return res.status(404).json({ error: "Instrument not found" });

        res.json({
            instrument_token: doc.instrument_token,
            segment: doc.segment,
            tradingsymbol: doc.tradingsymbol,
            lot_size: doc.lot_size
        });
    } catch (e) {
        console.error("instruments/resolve error:", e);
        res.status(500).json({ error: "failed" });
    }
});

// ==================== LOOKUP ENDPOINT ====================
router.get("/lookup", async (req, res) => {
    try {
        const { instrument_token, segment } = req.query;

        if (!instrument_token) {
            return res.status(400).json({ error: "instrument_token is required" });
        }

        const query = { instrument_token: String(instrument_token) };
        if (segment) query.segment = segment;

        const instrument = await Instrument.findOne(query)
            .select("instrument_token segment exchange tradingsymbol name instrument_type lot_size")
            .lean();

        if (!instrument) {
            return res.status(404).json({ error: "Instrument not found" });
        }

        res.json(instrument);
    } catch (e) {
        console.error("instruments/lookup error:", e);
        res.status(500).json({ error: "failed" });
    }
});

// ==================== ANALYTICS ENDPOINT ====================
router.get("/analytics", async (req, res) => {
    try {
        const topSearches = getTopSearches(50);
        const cacheStats = {
            memory: {
                searchCache: searchCache.size,
                analyticsTracked: searchAnalytics.size
            }
        };

        res.json({
            topSearches,
            cacheStats,
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        console.error("instruments/analytics error:", e);
        res.status(500).json({ error: "failed" });
    }
});

export default router;
