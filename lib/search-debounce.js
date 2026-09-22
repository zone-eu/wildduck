'use strict';

const KEY_PREFIX = 'search-debounce:';

const normalizeWindow = value => {
    value = Number(value);
    return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
};

const acquireSearchDebounce = async (redis, user, windowMs) => {
    windowMs = normalizeWindow(windowMs);
    if (!windowMs) {
        return {
            success: true,
            retryAfterMs: 0
        };
    }

    const key = `${KEY_PREFIX}${user}`;
    const acquired = await redis.set(key, '1', 'PX', windowMs, 'NX');
    if (acquired) {
        return {
            success: true,
            retryAfterMs: 0
        };
    }

    let retryAfterMs = await redis.pttl(key);

    // The key may expire between SET NX and PTTL. Give the request one chance to
    // acquire the new window instead of returning a rate-limit response with no lock.
    if (retryAfterMs < 1) {
        const reacquired = await redis.set(key, '1', 'PX', windowMs, 'NX');
        if (reacquired) {
            return {
                success: true,
                retryAfterMs: 0
            };
        }
        retryAfterMs = await redis.pttl(key);
    }

    return {
        success: false,
        retryAfterMs: retryAfterMs > 0 ? retryAfterMs : windowMs
    };
};

module.exports = { acquireSearchDebounce };
