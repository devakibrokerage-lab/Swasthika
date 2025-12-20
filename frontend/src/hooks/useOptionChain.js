// hooks/useOptionChain.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { useMarketData } from '../contexts/MarketDataContext';

const apiBase = import.meta.env.VITE_REACT_APP_API_URL || 'http://localhost:8080';

/**
 * Custom hook to fetch and manage option chain data with live WebSocket updates
 * @param {Object} params - { segment, securityId, expiry }
 * @returns {Object} - { chainData, loading, error, spotPrice, expiries, refetch }
 */
export function useOptionChain({ segment, securityId, expiry }) {
  const [chainData, setChainData] = useState(null);
  const [spotPrice, setSpotPrice] = useState(null);
  const [expiries, setExpiries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { ticksRef, subscribe, unsubscribe, isConnected } = useMarketData();

  // Track subscribed option securityIds for cleanup
  const subscribedSecurityIdsRef = useRef([]);
  const lastFetchParamsRef = useRef(null);

  // Store securityId to chain position mapping for tick updates
  const securityIdMapRef = useRef(new Map());

  /**
   * Fetch option chain data from backend
   */
  const fetchOptionChain = useCallback(async () => {
    if (!segment || !securityId) {
      console.warn('[useOptionChain] Missing required params:', { segment, securityId });
      return;
    }

    const symbol = `${segment}|${securityId}`;
    const params = new URLSearchParams({ symbol });
    if (expiry) params.append('expiry', expiry);

    const paramsKey = `${segment}|${securityId}|${expiry || 'default'}`;

    // Avoid duplicate fetches
    if (lastFetchParamsRef.current === paramsKey) {
      console.log('[useOptionChain] Skipping duplicate fetch');
      return;
    }

    setLoading(true);
    setError(null);
    console.log('[useOptionChain] Fetching option chain:', { symbol, expiry });

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${apiBase}/api/option-chain?${params.toString()}`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.details || errData.error || 'Failed to fetch option chain');
      }

      const result = await response.json();
      console.log('[useOptionChain] Received data:', {
        totalStrikes: result.data?.chain?.length,
        spotPrice: result.data?.spotPrice,
        expiry: result.data?.expiry
      });

      setChainData(result.data.chain);
      setSpotPrice(result.data.spotPrice);

      lastFetchParamsRef.current = paramsKey;
      return result.data;

    } catch (err) {
      console.error('[useOptionChain] Fetch error:', err);
      setError(err.message);
      setChainData(null);
    } finally {
      setLoading(false);
    }
  }, [segment, securityId, expiry]);

  /**
   * Fetch available expiry dates for the underlying
   */
  const fetchExpiries = useCallback(async () => {
    if (!segment || !securityId) return;

    const symbol = `${segment}|${securityId}`;
    const params = new URLSearchParams({ symbol });

    console.log('[useOptionChain] Fetching expiries for:', symbol);

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${apiBase}/api/option-chain/expiries?${params.toString()}`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
      });

      if (!response.ok) {
        console.warn('[useOptionChain] Failed to fetch expiries');
        return;
      }

      const result = await response.json();
      console.log('[useOptionChain] Expiries received:', result.data?.expiries);
      setExpiries(result.data?.expiries || []);

    } catch (err) {
      console.warn('[useOptionChain] Expiries fetch error:', err);
    }
  }, [segment, securityId]);

  /**
   * Subscribe to live ticker data for all option strikes in the chain
   * Uses 'ticker' packet type for LTP-only updates (most efficient)
   */
  const subscribeToOptionStrikes = useCallback((chainArray) => {
    if (!chainArray || chainArray.length === 0 || !isConnected) {
      console.warn('[useOptionChain] Cannot subscribe - no chain data or socket disconnected');
      return;
    }

    // Build subscription list and securityId mapping
    const subscriptionList = [];
    const newSecurityIdMap = new Map();

    chainArray.forEach((row, index) => {
      // Subscribe to CE (call) option if has securityId
      if (row.call?.securityId) {
        subscriptionList.push({
          segment: 'NSE_FNO',
          securityId: String(row.call.securityId)
        });
        // Map securityId to chain position for tick updates
        newSecurityIdMap.set(String(row.call.securityId), {
          index,
          type: 'call',
          strike: row.strike
        });
      }

      // Subscribe to PE (put) option if has securityId
      if (row.put?.securityId) {
        subscriptionList.push({
          segment: 'NSE_FNO',
          securityId: String(row.put.securityId)
        });
        newSecurityIdMap.set(String(row.put.securityId), {
          index,
          type: 'put',
          strike: row.strike
        });
      }
    });

    if (subscriptionList.length === 0) {
      console.warn('[useOptionChain] No securityIds found in chain data');
      return;
    }

    // Store mapping for tick updates
    securityIdMapRef.current = newSecurityIdMap;

    // Store for cleanup
    subscribedSecurityIdsRef.current = subscriptionList;

    console.log(`[useOptionChain] Subscribing to ${subscriptionList.length} option contracts (ticker mode)`);

    // Subscribe with 'ticker' packet type for LTP-only updates
    subscribe(subscriptionList, 'ticker');

  }, [isConnected, subscribe]);

  /**
   * Unsubscribe from option strikes
   */
  const unsubscribeFromOptionStrikes = useCallback(() => {
    if (subscribedSecurityIdsRef.current.length === 0) return;

    console.log('[useOptionChain] Unsubscribing from', subscribedSecurityIdsRef.current.length, 'option contracts');

    unsubscribe(subscribedSecurityIdsRef.current, 'ticker');

    // Clear tracking
    subscribedSecurityIdsRef.current = [];
    securityIdMapRef.current.clear();
    lastFetchParamsRef.current = null;

  }, [unsubscribe]);

  /**
   * Initial fetch when params change
   */
  useEffect(() => {
    if (!segment || !securityId) return;

    // Unsubscribe from previous subscriptions
    unsubscribeFromOptionStrikes();

    fetchOptionChain().then(data => {
      if (data?.chain && isConnected) {
        subscribeToOptionStrikes(data.chain);
      }
    });

    fetchExpiries();

    // Cleanup on unmount or param change
    return () => {
      unsubscribeFromOptionStrikes();
    };
  }, [segment, securityId, expiry, isConnected, fetchOptionChain, fetchExpiries, subscribeToOptionStrikes, unsubscribeFromOptionStrikes]);

  /**
   * Re-subscribe when socket reconnects
   */
  useEffect(() => {
    if (isConnected && chainData && subscribedSecurityIdsRef.current.length === 0) {
      console.log('[useOptionChain] Socket reconnected - re-subscribing');
      subscribeToOptionStrikes(chainData);
    }
  }, [isConnected, chainData, subscribeToOptionStrikes]);

  /**
   * Update chain data with live ticks from WebSocket
   * Maps incoming ticker updates to the correct CE/PE in the chain
   * Uses ref to track current chain to avoid dependency loop
   */
  const chainDataRef = useRef(chainData);
  useEffect(() => {
    chainDataRef.current = chainData;
  }, [chainData]);

  useEffect(() => {
    let animationFrameId;
    let lastUpdate = 0;
    const THROTTLE_MS = 50; // Update UI max 20 times per second

    const updateLoop = (timestamp) => {
      // Throttle checks
      if (timestamp - lastUpdate < THROTTLE_MS) {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      const ticks = ticksRef.current;
      if (!chainDataRef.current || chainDataRef.current.length === 0 || ticks.size === 0) {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      if (securityIdMapRef.current.size === 0) {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      // NSE_FNO exchangeSegment = 2
      const NSE_FNO_SEGMENT = 2;

      let hasUpdates = false;
      const currentChain = chainDataRef.current; // Read from ref, not state dependency

      // We'll build a map of indices that need updates to avoid iterating the whole chain if possible
      // But for React state we need a new array reference if ANYTHING changes.
      // Strategy: Check for changes first, then clone only if needed.

      // OPTIMIZATION: Check if any relevant ticks have changed since last render
      // We can iterate our subscribed map which is smaller than the ticks map

      const pendingUpdates = new Map(); // index -> { call: ltp, put: ltp }

      securityIdMapRef.current.forEach((position, securityId) => {
        const tickKey = `${NSE_FNO_SEGMENT}-${securityId}`;
        const tick = ticks.get(tickKey);

        if (tick?.ltp !== undefined && tick.ltp > 0) {
          const { index, type } = position;
          const row = currentChain[index];
          if (!row) return;

          const currentLtp = type === 'call' ? row.call?.ltp : row.put?.ltp;

          if (currentLtp !== tick.ltp) {
            // Found a change!
            const entry = pendingUpdates.get(index) || {};
            if (type === 'call') entry.callLtp = tick.ltp;
            if (type === 'put') entry.putLtp = tick.ltp;
            pendingUpdates.set(index, entry);
          }
        }
      });

      if (pendingUpdates.size > 0) {
        // Apply updates
        // console.log(`[useOptionChain] ⚡ RAF UPDATE: ${pendingUpdates.size} rows changed`);

        const updatedChain = [...currentChain]; // Shallow clone array

        for (const [index, updates] of pendingUpdates.entries()) {
          const row = updatedChain[index];
          const newRow = { ...row };

          if (updates.callLtp !== undefined && newRow.call) {
            newRow.call = { ...newRow.call, ltp: updates.callLtp };
          }
          if (updates.putLtp !== undefined && newRow.put) {
            newRow.put = { ...newRow.put, ltp: updates.putLtp };
          }
          updatedChain[index] = newRow;
        }

        chainDataRef.current = updatedChain;
        setChainData(updatedChain);
        hasUpdates = true;
        lastUpdate = timestamp;
      }

      animationFrameId = requestAnimationFrame(updateLoop);
    };

    // Start the loop
    animationFrameId = requestAnimationFrame(updateLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, []); // Empty dependency array = runs once on mount, but closes over Refs

  return {
    chainData,
    spotPrice,
    expiries,
    loading,
    error,
    refetch: fetchOptionChain,
  };
}
