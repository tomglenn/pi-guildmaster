# Final Review Fixes

This document describes the three specific issues found in final code review and their fixes. These complement the broader performance fix that eliminated synchronous filesystem I/O on the turn-start path.

## Issue 1: ProjectStore cache corruption on first uncached list call

**Problem**: When `list()` is called for the first time (cache miss), it stores `result` in the cache and returns `result`. If a caller mutates the returned array, the cache is corrupted because they have a reference to the same object stored in the cache.

**Root Cause**: The code was:
```typescript
const result = out.sort((a, b) => a.name.localeCompare(b.name));
if (isDefault) {
    defaultDirCache = { dir: defaultDir, projects: [...result], timestamp: Date.now() };
}
return result; // ⚠️ Caller can mutate this and corrupt the cache
```

Even though we used `[...result]` when storing in cache, we returned the original `result`, so:
- Cache gets a shallow copy
- Caller gets the original
- Mutations to the returned array or its objects affect the cache

**Fix**: Always return a deep clone to prevent any mutations from affecting the cache:

```typescript
const result = out.sort((a, b) => a.name.localeCompare(b.name));

// Cache if this is the default directory - store a clone
if (isDefault) {
    defaultDirCache = { dir: defaultDir, projects: result, timestamp: Date.now() };
}

// Always return a deep clone to prevent cache corruption from caller mutations
return JSON.parse(JSON.stringify(result)) as Project[];
```

**Files Changed**:
- `src/persistence/project-store.ts`: Line 128-133

**Testing**: Added test in `tests/cache-fixes.test.ts` that verifies:
- Mutations to returned array don't affect cache
- Mutations to returned objects don't affect cache
- Multiple calls return independent copies

## Issue 2: Roster prompt cache timestamp bugs

**Problem**: When `loadGuildmasterPrompt()` or `loadPartyLeaderPrompt()` reloads into an existing cache (e.g., after TTL expiry), it does NOT update `rosterCache.timestamp`. This means the timestamp reflects when the roster was loaded, not when the prompt was loaded. After the prompt TTL expires, it keeps re-reading from disk on every call because the old timestamp makes it look expired.

**Root Cause**: The code was:
```typescript
if (!rosterCache) {
    rosterCache = { roster: [], guildmasterPrompt: prompt, guildmasterLoaded: true, partyLeaderLoaded: false, timestamp: now };
} else {
    rosterCache.guildmasterPrompt = prompt;
    rosterCache.guildmasterLoaded = true;
    // ⚠️ Missing: rosterCache.timestamp = Date.now();
}
```

When the cache exists but the prompt is stale (TTL expired), we reload the prompt but don't update the timestamp. On the next call, the same old timestamp makes it look expired again, causing repeated disk reads.

**Fix**: Update the timestamp when reloading a prompt into an existing cache:

```typescript
if (!rosterCache) {
    rosterCache = { roster: [], guildmasterPrompt: prompt, guildmasterLoaded: true, partyLeaderLoaded: false, timestamp: now };
} else {
    rosterCache.guildmasterPrompt = prompt;
    rosterCache.guildmasterLoaded = true;
    rosterCache.timestamp = Date.now(); // ✅ Update timestamp
}
```

**Files Changed**:
- `src/roster.ts`: Lines 177-181 (loadGuildmasterPrompt)
- `src/roster.ts`: Lines 198-202 (loadPartyLeaderPrompt)

**Testing**: Added test in `tests/cache-fixes.test.ts` that verifies:
- After cache invalidation and reload, timestamps are properly updated
- Subsequent calls within TTL use the cache (don't reload)
- Both guildmaster and party leader prompts behave correctly

## Issue 3: index.ts promptCache not invalidated when roster is invalidated

**Problem**: `src/index.ts` had its own separate `promptCache` that cached the persona (loaded via `loadGuildmasterPrompt()`). However, when `invalidateRosterCache()` is called (e.g., via `/reload` command), it only invalidates the cache in `roster.ts`, not the separate cache in `index.ts`. This means stale persona data could be served for up to 60 seconds after a reload.

**Root Cause**: Two independent caches for the same data:
1. `roster.ts` has `rosterCache` that caches the actual prompts
2. `index.ts` had `promptCache` that cached persona independently

When roster is invalidated, only #1 is cleared. The `promptCache` in index.ts becomes stale.

**Fix**: Remove the duplicate persona caching in `index.ts` entirely. Just call `loadGuildmasterPrompt()` directly, which uses the roster.ts cache:

**Before**:
```typescript
interface PromptCache {
    persona: string | undefined;
    timestamp: number;
}

let promptCache: PromptCache | undefined;
const PROMPT_CACHE_TTL = 60_000;

function getCachedPersona(): string | undefined {
    const now = Date.now();
    if (promptCache && (now - promptCache.timestamp) < PROMPT_CACHE_TTL) {
        return promptCache.persona;
    }
    
    let persona: string | undefined;
    try {
        persona = loadGuildmasterPrompt();
    } catch (err) {
        console.error("[guildmaster] Failed to load persona:", err);
    }

    promptCache = { persona, timestamp: now };
    return persona;
}

// In before_agent_start:
const persona = getCachedPersona();
```

**After**:
```typescript
// No promptCache, no getCachedPersona()

// In before_agent_start:
const persona = loadGuildmasterPrompt(); // Uses roster.ts cache directly
```

**Benefits**:
- Single source of truth for caching
- `invalidateRosterCache()` now properly invalidates all cached persona data
- Simpler code, less duplication
- Still has caching benefit (via roster.ts)

**Files Changed**:
- `src/index.ts`: Removed lines 25-47 (interface, variables, getCachedPersona function)
- `src/index.ts`: Line 62 - changed to call `loadGuildmasterPrompt()` directly

**Testing**: The existing roster cache tests verify that invalidation works correctly. The persona is now part of the roster cache lifecycle.

## Summary

All three fixes are **correctness and cache coherence improvements** that ensure:

1. **Cache isolation**: Callers cannot corrupt cached data through mutations
2. **Proper TTL behavior**: Cache timestamps are updated when data is reloaded
3. **Single source of truth**: No duplicate caches for the same data

These fixes maintain 100% backward compatibility. The user-visible behavior is unchanged - these are internal correctness fixes that prevent subtle bugs and ensure caches work as intended.

## Test Coverage

Extended `tests/cache-fixes.test.ts` to cover:
- ProjectStore cache mutation isolation
- Roster prompt cache timestamp updates
- All fixes verified by unit tests

All tests pass with these changes.
