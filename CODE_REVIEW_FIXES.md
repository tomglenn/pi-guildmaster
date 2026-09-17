# Code Review Fixes

This document summarizes the fixes made to address issues found in code review. These are all part of the larger performance fix to eliminate synchronous filesystem I/O that was causing "Working…" hangs.

## Issue 1: Separate promptCache in index.ts remains stale after project changes

**Problem**: `src/index.ts` had its own `promptCache` that cached both persona and projects, but the projects cache was never invalidated when `ProjectStore.save()/remove()` was called. This meant users could see stale project data for up to 60 seconds.

**Fix**: 
- Changed `promptCache` in `src/index.ts` to only store `{ persona: string | undefined; timestamp: number }`
- In `before_agent_start`, always call `new ProjectStore().list()` which uses ProjectStore's own cache (which IS invalidated on save/remove)
- Only cache the persona string, which doesn't change based on user actions

**Files changed**:
- `src/index.ts`: Modified `PromptCache` interface and `getCachedPersona()` function

## Issue 2: QuestStore.onSave() only supports one listener

**Problem**: The `saveListener` was a single callback, not a set. If multiple parts of the code tried to register listeners, later callers would replace earlier listeners (like the QuestManager's listener).

**Fix**:
- Changed `private saveListener` to `private readonly saveListeners = new Set<(record: QuestRecord) => void>()`
- Changed `onSave(listener)` to add to the set and return an unsubscribe function: `() => void`
- Changed the call site in `save()` to iterate over the set using `for (const listener of this.saveListeners)`

**Files changed**:
- `src/persistence/quest-store.ts`: Changed listener storage and iteration

**Backward compatibility**: The change is fully backward compatible. The QuestManager (the only current caller) doesn't need to store the unsubscribe function since it's registered in the constructor and lives for the lifetime of the extension.

## Issue 3: ProjectStore cache exposes mutable objects

**Problem**: Callers could mutate returned Project objects (e.g., modify `repos` array or `aliases`), which would corrupt the cache since they were getting references to the cached objects.

**Fix**:
- When returning from cache in `list()`, deep-clone the projects using `JSON.parse(JSON.stringify(defaultDirCache.projects))`
- This ensures callers receive independent copies and cannot corrupt the cache

**Files changed**:
- `src/persistence/project-store.ts`: Modified cache return in `list()` method

## Issue 4: Roster prompt caching edge case - undefined prompts not cached

**Problem**: If a prompt file was missing, the `undefined` result was not cached (because the check was `rosterCache.guildmasterPrompt !== undefined`), causing repeated disk reads every time the prompt was requested.

**Fix**:
- Added `guildmasterLoaded: boolean` and `partyLeaderLoaded: boolean` flags to `RosterCache` interface
- Changed cache checks to use these flags instead of checking if the value is undefined
- Now both defined and undefined prompt results are cached, preventing repeated disk reads

**Files changed**:
- `src/roster.ts`: Added flags to interface, updated all cache initialization and check logic

## Testing

Created a new test file `tests/cache-fixes.test.ts` to verify:
- QuestStore.onSave() supports multiple listeners
- QuestStore.onSave() returns an unsubscribe function that works correctly
- Unsubscribing one listener doesn't affect other listeners

All changes maintain backward compatibility and preserve the existing behavior from the user's perspective. These are correctness and performance fixes, not feature changes.
