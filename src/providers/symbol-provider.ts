import * as vscode from 'vscode';
import { SearchItemType, SearchProvider, SymbolKindGroup, SymbolSearchItem, mapSymbolKindToGroup } from '../core/types';
import { Debouncer } from '../utils/debouncer';
import { ExclusionPatterns } from '../utils/exclusions';
import { getConfiguration } from '../utils/config';
import {
    CACHE_VERSION,
    getCacheFileUri,
    getWorkspaceFingerprint,
    ensureCacheDir,
    readCache,
    writeCache
} from '../cache';
import type { ManifestEntry, WorkspaceSymbolsCache, SerializedSymbolItem } from '../cache';
import Logger from '../utils/logging';

/**
 * Provides workspace symbols for searching using VSCode's symbol providers
 */
export class SymbolSearchProvider implements SearchProvider {
    private symbolItems: SymbolSearchItem[] = [];
    private isRefreshing: boolean = false;
    private refreshDebouncer: Debouncer;
    private readonly storageUri: vscode.Uri | undefined;
    /** Single in-flight refresh so concurrent getItems() / refresh() share one run */
    private loadPromise: Promise<void> | null = null;

    constructor(storageUri?: vscode.Uri) {
        this.storageUri = storageUri;
        // Create a debouncer with 2 second delay to avoid excessive refreshes
        this.refreshDebouncer = new Debouncer(2000);

        // Setup automatic reindexing when documents change
        this.setupChangeListeners();
    }

    /**
     * Setup workspace change listeners to automatically reindex symbols
     */
    private setupChangeListeners(): void {
        // Listen for document saves - best time to update symbols
        vscode.workspace.onDidSaveTextDocument(() => {
            this.scheduleRefresh();
        });

        // Listen for document changes (optional, can cause heavy load)
        // Only track significant changes (50+ characters changed)
        vscode.workspace.onDidChangeTextDocument((event) => {
            // Only reindex if significant changes were made
            if (event.contentChanges.length > 0) {
                const changeSize = event.contentChanges.reduce(
                    (sum, change) => sum + change.text.length, 0
                );

                // If it's a significant change (e.g., added a function or class)
                if (changeSize > 50) {
                    this.scheduleRefresh();
                }
            }
        });

        // Listen for document closes (could be save, delete, or rename)
        vscode.workspace.onDidCloseTextDocument(() => {
            this.scheduleRefresh();
        });

        // Listen for folder changes
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.refreshDebouncer.clear(); // Clear any pending updates
            this.refresh(); // Refresh immediately
        });
    }

    /**
     * Schedule a refresh operation, debounced to prevent excessive updates.
     * Uses force so we always run a full refresh and pick up new symbols even if a previous
     * refresh was in progress; otherwise incremental index updates would never see new workspace symbols.
     */
    private scheduleRefresh(): void {
        // mstodo console.log('Scheduling symbol index refresh...');
        this.refreshDebouncer.debounce(() => {
            this.refresh(true);
        });
    }

    /**
     * Get all indexed workspace symbol items
     */
    public async getItems(_onBatch?: import('../core/types').OnBatchCallback): Promise<SymbolSearchItem[]> {
        if (this.symbolItems.length === 0) {
            if (this.loadPromise) {
                await this.loadPromise;
            } else {
                // Assign before awaiting so concurrent getItems() see loadPromise and share this run
                this.loadPromise = this.runRefreshInternal(false);
                try {
                    await this.loadPromise;
                } finally {
                    this.loadPromise = null;
                }
            }
        }

        return this.symbolItems;
    }

    /**
     * Refresh the workspace symbol index.
     * Uses persistent cache when possible; invalidates if any source file mtime changed.
     * @param force If true, forces refresh even if already refreshing and ignores cache
     */
    public async refresh(force: boolean = false): Promise<void> {
        if (this.loadPromise !== null) {
            if (!force) {
                await this.loadPromise;
                return;
            }
            await this.loadPromise;
            this.loadPromise = null;
        }
        if (this.isRefreshing && !force) {
            return;
        }

        this.loadPromise = this.runRefreshInternal(force);
        try {
            await this.loadPromise;
        } finally {
            this.loadPromise = null;
        }
    }

    /**
     * Single implementation of the refresh work. Caller must assign to loadPromise before awaiting
     * so concurrent callers share one run.
     */
    private async runRefreshInternal(force: boolean): Promise<void> {
        this.isRefreshing = true;
        //Logger.log('Refreshing workspace symbol index...');
        const startTime = performance.now();

        this.symbolItems = [];

        try {
            if (force || !this.storageUri) {
                await this.fullRefresh();
            } else {
                const usedCache = await this.tryLoadFromCache();
                if (!usedCache) {
                    await this.fullRefresh();
                }
            }

            if (this.storageUri) {
                await this.saveCache();
            }
        } catch (error) {
            console.error('Error refreshing symbol index:', error);
        } finally {
            this.isRefreshing = false;

            const endTime = performance.now();

            //Logger.log(`Indexed ${this.symbolItems.length} symbols in ${endTime - startTime}ms`);
        }
    }

    /**
     * Build manifest of source file uris + mtimes (same scope as document symbols) for cache invalidation.
     */
    private async getSourceFileManifest(): Promise<ManifestEntry[]> {
        const sourceFilePattern = '**/*.{js,jsx,ts,tsx,py,java,c,cpp,cs,go,rb,php,rust,swift}';
        const excludePattern = ExclusionPatterns.getExclusionGlob();
        const { maxDocumentSymbolFiles } = getConfiguration().performance;
        const manifest: ManifestEntry[] = [];

        for (const folder of vscode.workspace.workspaceFolders!) {
            let files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, sourceFilePattern),
                excludePattern
            );
            const batchSize = 500;
            const entries: { uri: vscode.Uri; mtime: number }[] = [];
            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                const stats = await Promise.all(
                    batch.map(async (uri) => {
                        try {
                            const stat = await vscode.workspace.fs.stat(uri);
                            return { uri, mtime: stat.mtime };
                        } catch {
                            return { uri, mtime: 0 };
                        }
                    })
                );
                entries.push(...stats);
            }
            entries.sort((a, b) => b.mtime - a.mtime);
            const slice = entries.slice(0, maxDocumentSymbolFiles);
            for (const { uri, mtime } of slice) {
                manifest.push({ uri: uri.toString(), mtime });
            }
        }
        return manifest;
    }

    /**
     * Try to load from cache. Returns true if cache was valid and used.
     */
    private async tryLoadFromCache(): Promise<boolean> {
        const fileUri = getCacheFileUri(this.storageUri, 'workspace-symbols');
        if (!fileUri) {
            return false;
        }

        const cache = await readCache<WorkspaceSymbolsCache>(fileUri);
        const fingerprint = getWorkspaceFingerprint();
        if (!cache || cache.version !== CACHE_VERSION || cache.workspaceFingerprint !== fingerprint) {
            return false;
        }

        const currentManifest = await this.getSourceFileManifest();
        const cachedManifest = cache.manifest || [];

        if (currentManifest.length !== cachedManifest.length) {
            return false;
        }

        const cachedMtimeByUri = new Map(cachedManifest.map((e) => [e.uri, e.mtime]));
        for (const { uri, mtime } of currentManifest) {
            if (cachedMtimeByUri.get(uri) !== mtime) {
                return false;
            }
        }

        this.symbolItems = (cache.items || []).map((s) => this.deserializeSymbolItem(s));
        //Logger.log(`Workspace symbols: loaded ${this.symbolItems.length} from cache`);
        return true;
    }

    private async fullRefresh(): Promise<void> {
        //Logger.log('executeCommand vscode.executeWorkspaceSymbolProvider (pattern=)');
        const basicSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            ''
        ) || [];

        const queryPatterns = ['*', 'a*', 'b*', 'c*', 'd*', 'e*', 'f*', 'g*', 'h*', 'i*',
                              'j*', 'k*', 'l*', 'm*', 'n*', 'o*', 'p*', 'q*', 'r*', 's*',
                              't*', 'u*', 'v*', 'w*', 'x*', 'y*', 'z*', '_*', '$*'];

        const allSymbols: vscode.SymbolInformation[] = [...basicSymbols];
        const symbolIds = new Set(basicSymbols.map(s => this.getSymbolId(s)));

        for (const pattern of queryPatterns) {
            //Logger.log(`executeCommand vscode.executeWorkspaceSymbolProvider pattern=${pattern}`);
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                pattern
            ) || [];

            for (const symbol of symbols) {
                const id = this.getSymbolId(symbol);
                if (!symbolIds.has(id)) {
                    symbolIds.add(id);
                    allSymbols.push(symbol);
                }
            }
        }

        //Logger.log(`Found ${allSymbols.length} total workspace symbols (before filtering)`);

        const filteredSymbols = allSymbols.filter(symbol =>
            !ExclusionPatterns.shouldExclude(symbol.location.uri)
        );

        //Logger.log(`Filtered to ${filteredSymbols.length} symbols after applying exclusions`);

        this.symbolItems = filteredSymbols.map(symbol => this.convertToSearchItem(symbol));
    }

    private async saveCache(): Promise<void> {
        const fileUri = getCacheFileUri(this.storageUri, 'workspace-symbols');
        if (!fileUri) {
            return;
        }

        await ensureCacheDir(this.storageUri);

        const manifest = await this.getSourceFileManifest();
        const items: SerializedSymbolItem[] = this.symbolItems.map((item) => this.serializeSymbolItem(item));

        const payload: WorkspaceSymbolsCache = {
            version: CACHE_VERSION,
            workspaceFingerprint: getWorkspaceFingerprint(),
            manifest,
            items
        };

        await writeCache(fileUri, payload);
    }

    private serializeSymbolItem(item: SymbolSearchItem): SerializedSymbolItem {
        return {
            id: item.id,
            label: item.label,
            description: item.description,
            detail: item.detail,
            type: item.type as 'symbol' | 'class',
            uri: item.uri.toString(),
            range: {
                start: { line: item.range.start.line, character: item.range.start.character },
                end: { line: item.range.end.line, character: item.range.end.character }
            },
            symbolKind: item.symbolKind as number,
            symbolGroup: item.symbolGroup !== undefined ? (item.symbolGroup as number) : undefined,
            priority: item.priority
        };
    }

    private deserializeSymbolItem(s: SerializedSymbolItem): SymbolSearchItem {
        const uri = vscode.Uri.parse(s.uri);
        const range = new vscode.Range(
            s.range.start.line,
            s.range.start.character,
            s.range.end.line,
            s.range.end.character
        );
        return {
            id: s.id,
            label: s.label,
            description: s.description,
            detail: s.detail,
            type: s.type as SymbolSearchItem['type'],
            uri,
            range,
            symbolKind: s.symbolKind as vscode.SymbolKind,
            symbolGroup: s.symbolGroup !== undefined ? (s.symbolGroup as SymbolKindGroup) : undefined,
            priority: s.priority,
            iconPath: this.getSymbolIcon(s.symbolKind as vscode.SymbolKind),
            action: async () => {
                const document = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(document);
                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        };
    }

    /**
     * Generate a unique ID for a symbol
     */
    private getSymbolId(symbol: vscode.SymbolInformation): string {
        return `symbol:${symbol.name}:${symbol.location.uri.toString()}:${symbol.location.range.start.line}:${symbol.location.range.start.character}`;
    }

    /**
     * Convert a SymbolInformation to a SearchItem
     */
    private convertToSearchItem(symbol: vscode.SymbolInformation): SymbolSearchItem {
        // Determine symbol group
        const symbolGroup = mapSymbolKindToGroup(symbol.kind);

        // Determine if this is a class-like symbol
        const isClass = symbolGroup === SymbolKindGroup.Class;

        // Get priority based on symbol kind
        const priority = this.getSymbolPriority(symbol.kind);

        return {
            id: this.getSymbolId(symbol),
            label: symbol.name,
            description: `${this.getSymbolKindName(symbol.kind)}${symbol.containerName ? ` - ${symbol.containerName}` : ''}`,
            detail: symbol.location.uri.fsPath,
            type: isClass ? SearchItemType.Class : SearchItemType.Symbol,
            uri: symbol.location.uri,
            range: symbol.location.range,
            symbolKind: symbol.kind,
            symbolGroup: symbolGroup,
            priority: priority,
            iconPath: this.getSymbolIcon(symbol.kind),
            action: async () => {
                // Open document and reveal the symbol's position
                const document = await vscode.workspace.openTextDocument(symbol.location.uri);
                const editor = await vscode.window.showTextDocument(document);

                // Position the cursor and reveal the range
                const range = symbol.location.range;

                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        };
    }

    /**
     * Get priority value for a symbol kind
     * Higher values indicate higher priority in search results
     */
    private getSymbolPriority(kind: vscode.SymbolKind): number {
        switch (kind) {
            // Highest priority: Classes and interfaces
            case vscode.SymbolKind.Class:

            case vscode.SymbolKind.Interface:

            case vscode.SymbolKind.Enum:

            case vscode.SymbolKind.Struct:
                return 100;

            // High priority: Methods and functions
            case vscode.SymbolKind.Method:

            case vscode.SymbolKind.Function:

            case vscode.SymbolKind.Constructor:
                return 90;

            // Medium-high priority: Properties and fields
            case vscode.SymbolKind.Property:

            case vscode.SymbolKind.Field:

            case vscode.SymbolKind.EnumMember:
                return 70;

            // Medium priority: Constants
            case vscode.SymbolKind.Constant:
                return 60;

            // Low priority: Variables
            case vscode.SymbolKind.Variable:
                return 40;

            // Default priority for other symbols
            default:
                return 50;
        }
    }

    /**
     * Get a user-friendly name for a symbol kind
     */
    private getSymbolKindName(kind: vscode.SymbolKind): string {
        switch (kind) {
            case vscode.SymbolKind.File: return 'File';

            case vscode.SymbolKind.Module: return 'Module';

            case vscode.SymbolKind.Namespace: return 'Namespace';

            case vscode.SymbolKind.Package: return 'Package';

            case vscode.SymbolKind.Class: return 'Class';

            case vscode.SymbolKind.Method: return 'Method';

            case vscode.SymbolKind.Property: return 'Property';

            case vscode.SymbolKind.Field: return 'Field';

            case vscode.SymbolKind.Constructor: return 'Constructor';

            case vscode.SymbolKind.Enum: return 'Enum';

            case vscode.SymbolKind.Interface: return 'Interface';

            case vscode.SymbolKind.Function: return 'Function';

            case vscode.SymbolKind.Variable: return 'Variable';

            case vscode.SymbolKind.Constant: return 'Constant';

            case vscode.SymbolKind.String: return 'String';

            case vscode.SymbolKind.Number: return 'Number';

            case vscode.SymbolKind.Boolean: return 'Boolean';

            case vscode.SymbolKind.Array: return 'Array';

            case vscode.SymbolKind.Object: return 'Object';

            case vscode.SymbolKind.Key: return 'Key';

            case vscode.SymbolKind.Null: return 'Null';

            case vscode.SymbolKind.EnumMember: return 'EnumMember';

            case vscode.SymbolKind.Struct: return 'Struct';

            case vscode.SymbolKind.Event: return 'Event';

            case vscode.SymbolKind.Operator: return 'Operator';

            case vscode.SymbolKind.TypeParameter: return 'TypeParameter';

            default: return 'Symbol';
        }
    }

    /**
     * Get an icon for a symbol kind
     */
    private getSymbolIcon(kind: vscode.SymbolKind): vscode.ThemeIcon {
        switch (kind) {
            case vscode.SymbolKind.File: return new vscode.ThemeIcon('file');

            case vscode.SymbolKind.Module: return new vscode.ThemeIcon('package');

            case vscode.SymbolKind.Namespace: return new vscode.ThemeIcon('symbol-namespace');

            case vscode.SymbolKind.Package: return new vscode.ThemeIcon('package');

            case vscode.SymbolKind.Class: return new vscode.ThemeIcon('symbol-class');

            case vscode.SymbolKind.Method: return new vscode.ThemeIcon('symbol-method');

            case vscode.SymbolKind.Property: return new vscode.ThemeIcon('symbol-property');

            case vscode.SymbolKind.Field: return new vscode.ThemeIcon('symbol-field');

            case vscode.SymbolKind.Constructor: return new vscode.ThemeIcon('symbol-constructor');

            case vscode.SymbolKind.Enum: return new vscode.ThemeIcon('symbol-enum');

            case vscode.SymbolKind.Interface: return new vscode.ThemeIcon('symbol-interface');

            case vscode.SymbolKind.Function: return new vscode.ThemeIcon('symbol-method');

            case vscode.SymbolKind.Variable: return new vscode.ThemeIcon('symbol-variable');

            case vscode.SymbolKind.Constant: return new vscode.ThemeIcon('symbol-constant');

            case vscode.SymbolKind.String: return new vscode.ThemeIcon('symbol-string');

            case vscode.SymbolKind.Number: return new vscode.ThemeIcon('symbol-numeric');

            case vscode.SymbolKind.Boolean: return new vscode.ThemeIcon('symbol-boolean');

            case vscode.SymbolKind.Array: return new vscode.ThemeIcon('symbol-array');

            case vscode.SymbolKind.Object: return new vscode.ThemeIcon('symbol-object');

            case vscode.SymbolKind.Key: return new vscode.ThemeIcon('symbol-key');

            case vscode.SymbolKind.Null: return new vscode.ThemeIcon('symbol-null');

            case vscode.SymbolKind.EnumMember: return new vscode.ThemeIcon('symbol-enum-member');

            case vscode.SymbolKind.Struct: return new vscode.ThemeIcon('symbol-struct');

            case vscode.SymbolKind.Event: return new vscode.ThemeIcon('symbol-event');

            case vscode.SymbolKind.Operator: return new vscode.ThemeIcon('symbol-operator');

            case vscode.SymbolKind.TypeParameter: return new vscode.ThemeIcon('symbol-parameter');

            default: return new vscode.ThemeIcon('symbol-misc');
        }
    }
}
