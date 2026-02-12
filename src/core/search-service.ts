import * as vscode from 'vscode';
import { FuzzySearcher, OnBatchCallback, SearchEverywhereConfig, SearchItem, SearchItemType, SearchProvider } from './types';
import { FileSearchProvider } from '../providers/file-provider';
import { CommandSearchProvider } from '../providers/command-provider';
import { SymbolSearchProvider } from '../providers/symbol-provider';
import { DocumentSymbolProvider } from '../providers/document-symbol-provider';
import { TextSearchProvider } from '../providers/text-provider';
import { getConfiguration } from '../utils/config';
import { SearchFactory } from '../search/search-factory';
import { Debouncer } from '../utils/debouncer';
import Logger from '../utils/logging';
import { getCacheFileUri, ensureCacheDir, readCache, writeCache, getWorkspaceFingerprint, CACHE_VERSION } from '../cache';
import type { ActivityScoresCache } from '../cache';

/**
 * Main service for coordinating search functionality
 */
export class SearchService {
    private providers: Map<string, SearchProvider> = new Map();
    private searcher: FuzzySearcher;
    private config: SearchEverywhereConfig;
    private allItems: SearchItem[] = [];
    private recentlyModifiedFiles: Map<string, number> = new Map(); // Uri -> timestamp
    private activityDebouncer: Debouncer;
    private indexUpdateDebouncer: Debouncer;
    private activitySaveDebouncer: Debouncer;
    /** Persisted selection timestamps (dedupe key -> Date.now()); applied to items when index is built */
    private persistedActivityScores: Record<string, number> = {};
    /** In-flight refresh promise so concurrent callers share one refresh instead of each starting their own */
    private refreshPromise: Promise<void> | null = null;
    /** True while the search quick pick is visible; we delay only the search-results update (see scheduleIndexUpdate) */
    private searchUIActive: boolean = false;
    /** Set when a search-results update was requested while searchUIActive; run when UI closes */
    private pendingIndexUpdate: boolean = false;

    /**
     * Initialize the search service
     */
    constructor(private context: vscode.ExtensionContext) {
        // Get initial configuration
        this.config = getConfiguration();

        // Create the searcher based on configuration
        this.searcher = SearchFactory.createSearcher(this.config.fuzzySearch.library);

        // Set up debouncers
        this.activityDebouncer = new Debouncer(500);
        this.indexUpdateDebouncer = new Debouncer(3500); // Wait a bit longer than provider refresh
        this.activitySaveDebouncer = new Debouncer(2000);

        // Register search providers
        this.registerProviders();

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('searchEverywhere')) {
                this.config = getConfiguration();

                // Update searcher if library changed
                if (e.affectsConfiguration('searchEverywhere.fuzzySearch.library')) {
                    this.searcher = SearchFactory.createSearcher(this.config.fuzzySearch.library);
                }

                // Refresh providers if indexing settings changed
                if (e.affectsConfiguration('searchEverywhere.indexing')) {
                    this.refreshIndex();
                }
            }
        });

        // Track file activity
        this.trackFileActivity();

        // Watch for file changes to update indexes
        this.watchFileChanges();

        // Initial index
        this.refreshIndex();
    }

    /**
     * Watch for file changes to update the indexes
     */
    private watchFileChanges(): void {
        // Watch for file saves - the providers will refresh internally, we need to collect their results
        vscode.workspace.onDidSaveTextDocument(() => {
            Logger.log('File saved, scheduling index update...');
            this.scheduleIndexUpdate();
        });

        // Watch for file deletions, renames, etc.
        vscode.workspace.onDidCloseTextDocument(() => {
            // console.log('File closed, scheduling index update...');
            this.scheduleIndexUpdate();
        });
    }

    /**
     * Schedule a search-results update (merge provider data into allItems), debounced.
     * Only this update is delayed while the search UI is active; providers still index in the
     * background. Delaying just the results update keeps the list stable so accept goes to the right place.
     */
    private scheduleIndexUpdate(): void {
        this.indexUpdateDebouncer.debounce(() => {
            if (this.searchUIActive) {
                this.pendingIndexUpdate = true;
                Logger.log('Search UI active: delaying search-results update (indexing continues in background)');
                return;
            }
            Logger.log('Updating search results from providers...');
            this.updateIndexFromProviders();
        });
    }

    /**
     * Notify the service when the search quick pick is shown or hidden.
     * While active, only the search-results update is postponed; indexing in providers continues.
     */
    public setSearchUIActive(active: boolean): void {
        this.searchUIActive = active;
        if (!active && this.pendingIndexUpdate) {
            this.pendingIndexUpdate = false;
            Logger.log('Search UI closed: applying postponed search-results update');
            void this.updateIndexFromProviders();
        }
    }

    /**
     * Update the index by getting the latest items from all providers
     * This is faster than a full refresh because it doesn't force providers to re-index
     */
    private async updateIndexFromProviders(): Promise<void> {
        // Temporary map to deduplicate items
        const deduplicationMap = new Map<string, SearchItem>();
        Logger.log('Updating index from providers...');

        // Collect latest items from all providers
        for (const [name, provider] of this.providers.entries()) {
            try {
                const items = await provider.getItems();

                Logger.log(`Got ${items.length} items from ${name} provider after file change`);

                // Deduplicate items as they come in
                for (const item of items) {
                    const dedupeKey = this.getDeduplicationKey(item);

                    if (!deduplicationMap.has(dedupeKey)) {
                        deduplicationMap.set(dedupeKey, item);
                    }
                }
            } catch (error) {
                console.error(`Error getting items from ${name} provider:`, error);
            }
        }

        // Update the allItems array with the latest items
        this.allItems = Array.from(deduplicationMap.values());
        this.applyPersistedActivityScores();

        Logger.log(`Index update completed: ${this.allItems.length} items (after deduplication)`);
    }

    /**
     * Load persisted activity scores from cache so selections are remembered across sessions.
     */
    private async loadActivityScores(): Promise<void> {
        const storageUri = this.context.storageUri;
        const fileUri = getCacheFileUri(storageUri, 'activity-scores');
        if (!fileUri) {
            return;
        }
        const cache = await readCache<ActivityScoresCache>(fileUri);
        if (!cache || cache.version !== CACHE_VERSION) {
            return;
        }
        const fingerprint = getWorkspaceFingerprint();
        if (cache.workspaceFingerprint !== undefined && cache.workspaceFingerprint !== fingerprint) {
            return; // Different workspace, ignore
        }
        this.persistedActivityScores = cache.entries || {};
        Logger.log(`Loaded ${Object.keys(this.persistedActivityScores).length} activity scores from cache`);
    }

    /**
     * Persist activity scores to cache (debounced from recordItemUsed).
     */
    private static readonly MAX_PERSISTED_ACTIVITY_ENTRIES = 500;

    private async saveActivityScores(): Promise<void> {
        const storageUri = this.context.storageUri;
        const fileUri = getCacheFileUri(storageUri, 'activity-scores');
        if (!fileUri) {
            return;
        }
        await ensureCacheDir(storageUri);
        let entries = this.persistedActivityScores;
        if (Object.keys(entries).length > SearchService.MAX_PERSISTED_ACTIVITY_ENTRIES) {
            // Keep only the most recent entries by timestamp
            const sorted = Object.entries(entries).sort((a, b) => b[1] - a[1]);
            entries = Object.fromEntries(sorted.slice(0, SearchService.MAX_PERSISTED_ACTIVITY_ENTRIES));
            this.persistedActivityScores = entries;
        }
        const payload: ActivityScoresCache = {
            version: CACHE_VERSION,
            workspaceFingerprint: getWorkspaceFingerprint(),
            entries: { ...entries }
        };
        await writeCache(fileUri, payload);
        Logger.debug(`Saved ${Object.keys(entries).length} activity scores to cache`);
    }

    /**
     * Apply persisted activity scores to current allItems so boosting works after load/refresh.
     */
    private applyPersistedActivityScores(): void {
        for (const item of this.allItems) {
            const key = this.getDeduplicationKey(item);
            const ts = this.persistedActivityScores[key];
            if (typeof ts === 'number') {
                item.activityScore = ts;
            }
        }
    }

    /**
     * Track user file activity to boost recently modified files in search results
     */
    private trackFileActivity(): void {
        // Track document saves
        vscode.workspace.onDidSaveTextDocument(document => {
            this.trackDocumentActivity(document.uri);
        });

        // Track active editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document) {
                this.trackDocumentActivity(editor.document.uri);
            }
        });
    }

    /**
     * Track document activity
     */
    private trackDocumentActivity(uri: vscode.Uri): void {
        this.activityDebouncer.debounce(() => {
            // Record the timestamp when this file was accessed
            this.recentlyModifiedFiles.set(uri.toString(), Date.now());

            // Keep only the 20 most recent files
            if (this.recentlyModifiedFiles.size > 20) {
                // Get all entries sorted by timestamp (oldest first)
                const entries = [...this.recentlyModifiedFiles.entries()]
                    .sort((a, b) => a[1] - b[1]);

                // Remove the oldest entry
                this.recentlyModifiedFiles.delete(entries[0][0]);
            }
        });
    }

    /**
     * Register all search providers
     */
    private registerProviders(): void {
        const storageUri = this.context.storageUri;

        // Add file provider
        if (this.config.indexing.includeFiles) {
            this.providers.set('files', new FileSearchProvider(storageUri));
        } else {
            Logger.log('File provider not registered (searchEverywhere.indexing.includeFiles is false)');
        }

        // Add symbol providers
        if (this.config.indexing.includeSymbols) {
            this.providers.set('symbols', new SymbolSearchProvider(storageUri));
            this.providers.set('docSymbols', new DocumentSymbolProvider(storageUri));
        }

        // Add command provider
        if (this.config.indexing.includeCommands) {
            this.providers.set('commands', new CommandSearchProvider());
        } else {
            Logger.log('Command provider not registered (searchEverywhere.indexing.includeCommands is false)');
        }

        // Add text search provider
        if (this.config.indexing.includeText) {
            this.providers.set('text', new TextSearchProvider());
        }
        Logger.debug(`Providers registered: ${[...this.providers.keys()].join(', ')} (includeFiles=${this.config.indexing.includeFiles}, includeCommands=${this.config.indexing.includeCommands}, includeSymbols=${this.config.indexing.includeSymbols}, includeText=${this.config.indexing.includeText})`);
    }

    /**
     * Refresh all search indexes
     * @param force If true, forces a complete reindex even if the provider is already refreshing
     */
    public async refreshIndex(force: boolean = false): Promise<void> {
        // If a refresh is already in progress, wait for it instead of starting another (avoids
        // multiple "Workspace symbols: loaded from cache" and duplicate provider work)
        if (this.refreshPromise !== null) {
            if (!force) {
                await this.refreshPromise;
                return;
            }
            await this.refreshPromise;
            this.refreshPromise = null;
        }

        const doRefresh = async (): Promise<void> => {
            await this.loadActivityScores();

            // Clear existing items
            this.allItems = [];

            // Refresh providers based on configuration
            this.providers.clear();
            this.registerProviders();

            // Temporary map to deduplicate items
            const deduplicationMap = new Map<string, SearchItem>();

            // Helper: merge items into the index and update allItems (so search sees results as they stream)
            const mergeBatch: OnBatchCallback = (batch: SearchItem[]) => {
                for (const item of batch) {
                    const dedupeKey = this.getDeduplicationKey(item);

                    if (!deduplicationMap.has(dedupeKey)) {
                        deduplicationMap.set(dedupeKey, item);
                    }
                }
                this.allItems = Array.from(deduplicationMap.values());
            };

            // Run all providers in parallel so the first results appear sooner (max latency instead of sum)
            const providerEntries = [...this.providers.entries()];
            await Promise.all(
                providerEntries.map(async ([name, provider]) => {
                    try {
                        if (force) {
                            Logger.log(`Forcing refresh of ${name} provider...`);
                        }
                        // Always run refresh so providers load from cache or do a full index when there is no cache
                        await provider.refresh(force);

                        const items = await provider.getItems(mergeBatch);

                        Logger.log(`Got ${items.length} items from ${name} provider`);

                        // Merge final result (handles providers that don't stream; dedupe is idempotent)
                        for (const item of items) {
                            const dedupeKey = this.getDeduplicationKey(item);

                            if (!deduplicationMap.has(dedupeKey)) {
                                deduplicationMap.set(dedupeKey, item);
                            }
                        }
                        this.allItems = Array.from(deduplicationMap.values());
                    } catch (error) {
                        console.error(`Error getting items from ${name} provider:`, error);
                    }
                })
            );

            Logger.log(`Indexing completed: ${this.allItems.length} items (after deduplication)`);
            this.logItemCountsByType(this.allItems, 'after indexing');
            this.applyPersistedActivityScores();
        };

        this.refreshPromise = doRefresh();
        try {
            await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * Log counts per SearchItemType for debugging (e.g. why Files category is empty).
     */
    private logItemCountsByType(items: SearchItem[], context: string): void {
        const counts: Record<string, number> = {};
        for (const t of Object.values(SearchItemType)) {
            counts[t] = 0;
        }
        for (const item of items) {
            counts[item.type] = (counts[item.type] ?? 0) + 1;
        }
        Logger.debug(`Item counts ${context}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    /**
     * Generate a key for deduplicating search items
     */
    private getDeduplicationKey(item: SearchItem): string {
        // Normalize the label by removing parentheses from method names
        const normalizedLabel = item.label.replace(/\(\)$/, '');

        // Prefer structure over type: anything with uri+range is a symbol/class for key purposes.
        // This prevents document-symbol items (e.g. from cache with wrong type) from using file keys
        // and overwriting file entries when docSymbols finishes merging.
        if ('uri' in item && 'range' in item) {
            const withRange = item as { uri: vscode.Uri; range: vscode.Range };
            const prefix = item.type === SearchItemType.Class ? 'class' : 'symbol';
            return `${prefix}:${normalizedLabel}:${withRange.uri.toString()}:${withRange.range.start.line}:${withRange.range.start.character}`;
        }
        if (item.type === SearchItemType.File && 'uri' in item) {
            // For files, deduplicate based on URI
            const fileItem = item as { uri: vscode.Uri };

            return `file:${fileItem.uri.toString()}`;
        } else if (item.type === SearchItemType.Command && 'command' in item) {
            // For commands, deduplicate based on command id
            const cmdItem = item as { command: string };

            return `command:${cmdItem.command}`;
        }

        // Fallback to the item ID with normalized label
        return `${item.type}:${normalizedLabel}:${item.id.split(':').slice(1).join(':')}`;
    }

    /**
     * Record that the user selected an item so it can be boosted in future results.
     * Updates the selected item and any matching canonical item(s) in the index.
     * This ensures that when the same name appears as both a text match and a symbol,
     * selecting either one boosts the symbol in the Symbols tab (and in empty-query results).
     */
    public recordItemUsed(item: SearchItem): void {
        const now = Date.now();
        item.activityScore = now;

        const key = this.getDeduplicationKey(item);
        const normalizedLabel = item.label.replace(/\(\)$/, '');
        let updatedCount = 0;

        for (const indexed of this.allItems) {
            if (indexed === item) {
                indexed.activityScore = now;
                this.persistedActivityScores[this.getDeduplicationKey(indexed)] = now;
                updatedCount++;
                continue;
            }
            if (this.getDeduplicationKey(indexed) === key) {
                indexed.activityScore = now;
                this.persistedActivityScores[this.getDeduplicationKey(indexed)] = now;
                updatedCount++;
            } else if (
                (item.type === SearchItemType.TextMatch || item.type === SearchItemType.Symbol || item.type === SearchItemType.Class) &&
                (indexed.type === SearchItemType.Symbol || indexed.type === SearchItemType.Class) &&
                indexed.label.replace(/\(\)$/, '') === normalizedLabel
            ) {
                indexed.activityScore = now;
                this.persistedActivityScores[this.getDeduplicationKey(indexed)] = now;
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            this.activitySaveDebouncer.debounce(() => void this.saveActivityScores());
        }
        Logger.debug(`recordItemUsed label=${item.label} type=${item.type} updatedIndexed=${updatedCount}`);
    }

    /**
     * Search for items matching the query
     */
    public async search(query: string): Promise<SearchItem[]> {
        // If nothing indexed yet, refresh
        if (this.allItems.length === 0) {
            await this.refreshIndex();
        }
        let results: SearchItem[] = [];

        // Get text search results if enabled (these are always on-demand)
            if (this.config.indexing.includeText && query.trim()) {
            try {
                const textProvider = this.providers.get('text') as TextSearchProvider;

                if (textProvider) {
                    const textResults = await textProvider.search(query);

                    results = [...textResults];
                }
            } catch (error) {
                console.error('Error performing text search:', error);
            }
        }
        // If no query, return all indexed items
        if (!query.trim()) {
            const sortedItems = [...this.allItems];
            if (this.config.activity.enabled) {
                this.boostRecentlyModifiedItems(sortedItems);
            }
            this.sortResultsByPriority(sortedItems);
            this.logItemCountsByType(sortedItems, 'search (empty query)');
            return sortedItems;
        }
        // Perform fuzzy search on indexed items (no limit - UI will apply maxResults when displaying)
        const fuzzyResults = await this.searcher.search(this.allItems, query);

        // Combine fuzzy and text results
        results = [...results, ...fuzzyResults];
        // Boost recently modified files and recently picked symbols (activityScore)
        if (this.config.activity.enabled) {
            this.boostRecentlyModifiedItems(results);
        }
        // Apply priority-based sorting as a tie-breaker
        this.sortResultsByPriority(results);

        this.logItemCountsByType(results, 'search (with query)');
        return results;
    }

    /**
     * Sort search results by score first, then by priority as tie-breaker.
     * Score (including recency boost) dominates so e.g. a modified method can sort
     * above a non-modified class; priority only decides when scores are effectively equal.
     */
    private sortResultsByPriority(results: SearchItem[]): void {
        const SCORE_EPSILON = 1e-9;
        results.sort((a, b) => {
            // Recently used items (activityScore) always sort above others when they match the query
            const hasActivityA = typeof a.activityScore === 'number' ? 1 : 0;
            const hasActivityB = typeof b.activityScore === 'number' ? 1 : 0;
            if (hasActivityB !== hasActivityA) {
                return hasActivityB - hasActivityA; // With activity first
            }
            // Among items with activity, most recently used first (higher timestamp = more recent)
            if (hasActivityA === 1 && hasActivityB === 1) {
                const tsA = a.activityScore ?? 0;
                const tsB = b.activityScore ?? 0;
                if (tsB !== tsA) {
                    return tsB - tsA;
                }
            }
            const scoreA = ('score' in a && typeof a.score === 'number') ? a.score : -Infinity;
            const scoreB = ('score' in b && typeof b.score === 'number') ? b.score : -Infinity;
            if (Math.abs(scoreA - scoreB) > SCORE_EPSILON) {
                return scoreB - scoreA; // Higher score first
            }
            // Scores effectively equal: use priority as tie-breaker
            const priorityA = a.priority || 50;
            const priorityB = b.priority || 50;
            return priorityB - priorityA; // Higher priority first
        });

        // Debug: log top 5 result labels when we have activityScore in the set (to verify order)
        // quick pick re-orders, so we put it in right order and quick pick will fuck it up.
        /* const withActivity = results.filter(r => typeof r.activityScore === 'number');
        if (withActivity.length > 0) {
            Logger.debug(`sortResultsByPriority: top 5 = ${results.slice(0, 5).map(r => r.label).join(' | ')}`);
        } */
    }

    /**
     * Boost items related to recently modified files.
     * Any item with a uri in recentlyModifiedFiles gets a higher score so they sort to the top.
     */
    private boostRecentlyModifiedItems(results: SearchItem[]): void {
        const activityWeight = this.config.activity.weight;
        const now = Date.now();
        const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

        for (const item of results) {
            // Check if this item is related to a recently modified file
            if (item.type === SearchItemType.File && 'uri' in item) {
                const fileItem = item as { uri: vscode.Uri };
                const timestamp = this.recentlyModifiedFiles.get(fileItem.uri.toString());

                if (timestamp) {
                    // Calculate a recency score (1.0 for just modified, decreasing over time)
                    const age = now - timestamp;
                    const recencyScore = Math.max(0, 1 - (age / oneHour));

                    // Apply the recency boost based on configuration weight
                    const boost = 1 + (recencyScore * activityWeight);

                    // Boost the result's score if it has one
                    if ('score' in item && typeof item.score === 'number') {
                        item.score *= boost;
                    }
                }
            }
            // Boost symbols in recently modified files (same file uri)
            else if ((item.type === SearchItemType.Symbol || item.type === SearchItemType.Class) && 'uri' in item) {
                const symbolItem = item as { uri: vscode.Uri; score?: number };
                const timestamp = this.recentlyModifiedFiles.get(symbolItem.uri.toString());
                if (timestamp && 'score' in item && typeof item.score === 'number') {
                    const age = now - timestamp;
                    const recencyScore = Math.max(0, 1 - (age / oneHour));
                    const boost = 1 + (recencyScore * activityWeight * 0.8); // Slightly lower than files
                    item.score *= boost;
                }
            }
            // Boost symbols when they have been recently used (activityScore set)
            // Use a stronger factor (1.5) so recently picked items reliably sort to the top when they match the query
            if ((item.type === SearchItemType.Symbol || item.type === SearchItemType.Class) && typeof item.activityScore === 'number') {
                const timestamp = item.activityScore; // Date.now() when the symbol was used
                const age = now - timestamp;
                const recencyScore = Math.max(0, 1 - (age / oneHour));
                const boost = 1 + (recencyScore * activityWeight * 1.5);

                if ('score' in item && typeof item.score === 'number') {
                    item.score *= boost;
                    // Add a small additive boost so recently used items beat similar fuzzy scores
                    item.score += recencyScore * 0.4;
                }
            }
        }
        const activityCount = results.filter(
            r => (r.type === SearchItemType.Symbol || r.type === SearchItemType.Class) && typeof r.activityScore === 'number'
        ).length;
        if (activityCount > 0) {
            Logger.debug(`boostRecentlyModifiedItems: ${activityCount} symbol(s) had activityScore and were boosted`);
        }
    }

    /**
     * Run benchmarks for different search libraries
     */
    public async runBenchmarks(query: string): Promise<Record<string, number>> {
        const benchmarks: Record<string, number> = {};
        const searchers = SearchFactory.getAllSearchers();

        for (const searcher of searchers) {
            const startTime = performance.now();

            // Run search 5 times and take average
            for (let i = 0; i < 5; i++) {
                await searcher.search(this.allItems, query, 100);
            }

            const endTime = performance.now();
            const averageTime = (endTime - startTime) / 5;

            benchmarks[searcher.name] = averageTime;
        }

        return benchmarks;
    }
}
