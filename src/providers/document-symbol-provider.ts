import * as vscode from 'vscode';
import { OnBatchCallback, SearchItemType, SearchProvider, SymbolKindGroup, SymbolSearchItem, mapSymbolKindToGroup } from '../core/types';
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
import type { DocumentSymbolsCache, DocumentSymbolsFileEntry, SerializedSymbolItem } from '../cache';
import Logger from '../utils/logging';

/**
 * Provides document symbols for searching by scanning each file individually
 * This complements the workspace symbol provider by finding symbols that might be missed
 */
export class DocumentSymbolProvider implements SearchProvider {
    private symbolItems: SymbolSearchItem[] = [];
    private isRefreshing: boolean = false;
    private refreshDebouncer: Debouncer;
    /** URIs updated by updateDocumentSymbols since last incremental cache save */
    private dirtyDocSymbolUris = new Set<string>();
    private saveCacheDebouncer: Debouncer;
    private fileUriCache = new Set<string>();
    private readonly storageUri: vscode.Uri | undefined;

    constructor(storageUri?: vscode.Uri) {
        this.storageUri = storageUri;
        // Create a debouncer with 3 second delay to avoid excessive refreshes
        // Using a slightly longer delay than workspace symbols to stagger the operations
        this.refreshDebouncer = new Debouncer(3000);
        this.saveCacheDebouncer = new Debouncer(800);

        // Setup automatic reindexing when documents change
        this.setupChangeListeners();
    }

    /**
     * Setup workspace change listeners to automatically reindex document symbols
     */
    private setupChangeListeners(): void {
        // Listen for document saves
        vscode.workspace.onDidSaveTextDocument((document) => {
            this.updateDocumentSymbols(document);
        });

        // Listen for folder changes
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.refreshDebouncer.clear(); // Clear any pending updates
            this.refresh(); // Refresh immediately
        });
    }

    /**
     * Update symbols for a specific document
     */
    private async updateDocumentSymbols(document: vscode.TextDocument): Promise<void> {
        const uri = document.uri;

        // Skip files that should be excluded
        if (ExclusionPatterns.shouldExclude(uri)) {
            return;
        }

        // Only process supported languages to avoid unnecessary work
        if (!this.isSupportedLanguage(uri.fsPath)) {
            return;
        }

        try {
            // Remove existing symbols for this file
            this.symbolItems = this.symbolItems.filter(item =>
                item.uri.toString() !== uri.toString()
            );

            // Get document symbols for the file
            Logger.log(`executeCommand vscode.executeDocumentSymbolProvider uri=${uri.toString()}`);
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );

            if (symbols && symbols.length > 0) {
                this.fileUriCache.add(uri.toString());
                this.processSymbols(symbols, uri);
                Logger.log(`Updated ${symbols.length} symbols for ${uri.fsPath}`);
            }
            // Persist cache so next load avoids re-executing executeDocumentSymbolProvider for this file
            // (including when symbols are now empty so we don't re-query on next load)
            this.dirtyDocSymbolUris.add(uri.toString());
            this.saveCacheDebouncer.debounce(() => this.flushIncrementalCacheSave());
        } catch (error) {
            console.error(`Error updating symbols for ${uri.fsPath}:`, error);
        }
    }

    /**
     * Persist cache after incremental updates. Uses existing cache and patches only
     * dirty file entries to avoid expensive getSourceFileEntries() on every save.
     */
    private async flushIncrementalCacheSave(): Promise<void> {
        const uris = new Set(this.dirtyDocSymbolUris);
        this.dirtyDocSymbolUris.clear();
        if (uris.size === 0 || !this.storageUri) {
            return;
        }
        const fileUri = getCacheFileUri(this.storageUri, 'document-symbols');
        if (!fileUri) {
            return;
        }
        const cache = await readCache<DocumentSymbolsCache>(fileUri);
        const fingerprint = getWorkspaceFingerprint();
        if (!cache || cache.version !== CACHE_VERSION || cache.workspaceFingerprint !== fingerprint || !cache.files) {
            await this.saveCache();
            return;
        }
        for (const uriStr of uris) {
            try {
                const uri = vscode.Uri.parse(uriStr);
                const stat = await vscode.workspace.fs.stat(uri);
                const items = this.symbolItems.filter((item) => item.uri.toString() === uriStr);
                cache.files[uriStr] = {
                    mtime: stat.mtime,
                    symbols: items.map((item) => this.serializeSymbolItem(item))
                };
            } catch {
                // File may have been deleted; leave cache entry as-is or remove
                delete cache.files[uriStr];
            }
        }
        await ensureCacheDir(this.storageUri);
        await writeCache(fileUri, cache);
    }

    /**
     * Schedule a full refresh operation, debounced to prevent excessive updates
     */
    private scheduleRefresh(): void {
        Logger.log('Scheduling document symbol index refresh...');
        this.refreshDebouncer.debounce(() => {
            this.refresh();
        });
    }

    /**
     * Check if a file is a supported language for symbol indexing
     */
    private isSupportedLanguage(filePath: string): boolean {
        const supportedExtensions = [
            '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs',
            '.go', '.rb', '.php', '.rust', '.swift', '.html', '.css', '.scss',
            '.sass', '.less', '.json', '.yaml', '.yml', '.toml', '.xml'
        ];

        return supportedExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
    }

    /**
     * Get all indexed document symbol items.
     * When onBatch is provided, it is called after each batch of files is indexed so results are available immediately.
     */
    public async getItems(onBatch?: OnBatchCallback): Promise<SymbolSearchItem[]> {
        if (this.symbolItems.length === 0 && !this.isRefreshing) {
            await this.refresh(false, onBatch);
        }

        return this.symbolItems;
    }

    /**
     * Refresh the document symbol index by scanning documents in the workspace.
     * Uses persistent cache when possible; only re-indexes new or modified files.
     * @param force If true, forces refresh even if already refreshing and ignores cache
     * @param onBatch When provided, called after each batch of files with the newly indexed symbols (for streaming results)
     */
    public async refresh(force: boolean = false, onBatch?: OnBatchCallback): Promise<void> {
        if (this.isRefreshing && !force) {
            return;
        }

        this.isRefreshing = true;
        Logger.log('Refreshing document symbol index...');
        const startTime = performance.now();

        this.symbolItems = [];

        try {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                return;
            }

            if (force || !this.storageUri) {
                await this.fullRefresh(onBatch);
            } else {
                const usedCache = await this.refreshFromCacheOrFull(onBatch);
                if (!usedCache) {
                    await this.fullRefresh(onBatch);
                }
            }

            if (this.storageUri) {
                await this.saveCache();
            }
        } catch (error) {
            console.error('Error refreshing document symbol index:', error);
        } finally {
            this.isRefreshing = false;

            const endTime = performance.now();

            Logger.log(`Indexed ${this.symbolItems.length} document symbols in ${endTime - startTime}ms`);
        }
    }

    /**
     * Get source file URIs and mtimes using the same discovery logic as full refresh.
     */
    private async getSourceFileEntries(): Promise<{ uri: vscode.Uri; mtime: number }[]> {
        const sourceFilePattern = '**/*.{js,jsx,ts,tsx,py,java,c,cpp,cs,go,rb,php,rust,swift}';
        const excludePattern = ExclusionPatterns.getExclusionGlob();
        const { maxDocumentSymbolFiles } = getConfiguration().performance;
        const entries: { uri: vscode.Uri; mtime: number }[] = [];

        for (const folder of vscode.workspace.workspaceFolders!) {
            let files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, sourceFilePattern),
                excludePattern
            );
            files = await this.sortFilesByModifiedDate(files);
            const filesToProcess = files.slice(0, maxDocumentSymbolFiles);

            const batchSize = 500;
            for (let i = 0; i < filesToProcess.length; i += batchSize) {
                const batch = filesToProcess.slice(i, i + batchSize);
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
                if (i + batchSize < filesToProcess.length) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
        }
        return entries;
    }

    /**
     * Try to load from cache and do incremental update. Returns true if cache was used.
     */
    private async refreshFromCacheOrFull(onBatch?: OnBatchCallback): Promise<boolean> {
        const fileUri = getCacheFileUri(this.storageUri, 'document-symbols');
        if (!fileUri) {
            return false;
        }

        const cache = await readCache<DocumentSymbolsCache>(fileUri);
        const fingerprint = getWorkspaceFingerprint();
        if (!cache || cache.version !== CACHE_VERSION || cache.workspaceFingerprint !== fingerprint) {
            return false;
        }

        const currentEntries = await this.getSourceFileEntries();
        const currentUriSet = new Set(currentEntries.map((e) => e.uri.toString()));
        const cachedFiles = cache.files || {};

        let fromCache = 0;
        const toIndex: { uri: vscode.Uri; mtime: number }[] = [];

        for (const { uri, mtime } of currentEntries) {
            const uriStr = uri.toString();
            const entry = cachedFiles[uriStr];
            if (entry && entry.mtime === mtime && entry.symbols.length >= 0) {
                for (const s of entry.symbols) {
                    this.symbolItems.push(this.deserializeSymbolItem(s));
                }
                fromCache++;
            } else {
                toIndex.push({ uri, mtime });
            }
        }

        if (toIndex.length > 0) {
            const batchSize = 20;
                for (let i = 0; i < toIndex.length; i += batchSize) {
                const batch = toIndex.slice(i, i + batchSize);
                const countBefore = this.symbolItems.length;
                for (const { uri } of batch) {
                    if (ExclusionPatterns.shouldExclude(uri)) {
                        continue;
                    }
                    try {
                        Logger.log(`executeCommand vscode.executeDocumentSymbolProvider uri=${uri.toString()}`);
                        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                            'vscode.executeDocumentSymbolProvider',
                            uri
                        );
                        if (symbols && symbols.length > 0) {
                            this.processSymbols(symbols, uri);
                        }
                    } catch (err) {
                        console.error(`Error indexing ${uri.fsPath}:`, err);
                    }
                }
                if (onBatch && this.symbolItems.length > countBefore) {
                    onBatch(this.symbolItems.slice(countBefore));
                }
                if (this.storageUri) {
                    await this.saveCache();
                }
                if (i % 100 === 0 && i > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
        }

        Logger.log(`Document symbols: ${fromCache} files from cache, ${toIndex.length} re-indexed`);
        return true;
    }

    private async fullRefresh(onBatch?: OnBatchCallback): Promise<void> {
        const currentEntries = await this.getSourceFileEntries();

        let cachedFiles: Record<string, DocumentSymbolsFileEntry> = {};
        if (this.storageUri) {
            const fileUri = getCacheFileUri(this.storageUri, 'document-symbols');
            if (fileUri) {
                const cache = await readCache<DocumentSymbolsCache>(fileUri);
                const fingerprint = getWorkspaceFingerprint();
                if (cache && cache.version === CACHE_VERSION && cache.workspaceFingerprint === fingerprint && cache.files) {
                    cachedFiles = cache.files;
                }
            }
        }

        let fromCacheCount = 0;
        const toProcess: { uri: vscode.Uri; mtime: number }[] = [];

        for (const { uri, mtime } of currentEntries) {
            const uriStr = uri.toString();
            const entry = cachedFiles[uriStr];
            if (entry && entry.mtime === mtime && entry.symbols.length >= 0) {
                for (const s of entry.symbols) {
                    this.symbolItems.push(this.deserializeSymbolItem(s));
                }
                fromCacheCount++;
            } else {
                if (!ExclusionPatterns.shouldExclude(uri)) {
                    toProcess.push({ uri, mtime });
                }
            }
        }

        if (onBatch && fromCacheCount > 0) {
            onBatch([...this.symbolItems]);
        }

        const batchSize = 20;
        for (let i = 0; i < toProcess.length; i += batchSize) {
            const batch = toProcess.slice(i, i + batchSize).map((e) => e.uri);
            Logger.log(`Processing batch ${JSON.stringify(batch)}...`);
            const countBefore = this.symbolItems.length;

            await this.processFileBatch(batch);

            if (onBatch && this.symbolItems.length > countBefore) {
                onBatch(this.symbolItems.slice(countBefore));
            }

            if (this.storageUri) {
                await this.saveCache();
            }

            if (i % 100 === 0 && i > 0) {
                Logger.log(`Processed ${i} files...`);
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }

        Logger.log(`Document symbols: ${fromCacheCount} files from cache, ${toProcess.length} re-indexed`);
    }

    private async saveCache(): Promise<void> {
        const fileUri = getCacheFileUri(this.storageUri, 'document-symbols');
        if (!fileUri) {
            return;
        }

        await ensureCacheDir(this.storageUri);

        const currentEntries = await this.getSourceFileEntries();
        const uriToMtime = new Map(currentEntries.map((e) => [e.uri.toString(), e.mtime]));

        const symbolsByUri = new Map<string, SymbolSearchItem[]>();
        for (const item of this.symbolItems) {
            const uriStr = item.uri.toString();
            if (!symbolsByUri.has(uriStr)) {
                symbolsByUri.set(uriStr, []);
            }
            symbolsByUri.get(uriStr)!.push(item);
        }

        // Write a cache entry for every file we consider (including 0-symbol files) so we don't re-execute on next load
        const files: Record<string, DocumentSymbolsFileEntry> = {};
        for (const { uri } of currentEntries) {
            const uriStr = uri.toString();
            const mtime = uriToMtime.get(uriStr) ?? 0;
            const items = symbolsByUri.get(uriStr) ?? [];
            files[uriStr] = {
                mtime,
                symbols: items.map((item) => this.serializeSymbolItem(item))
            };
        }

        const payload: DocumentSymbolsCache = {
            version: CACHE_VERSION,
            workspaceFingerprint: getWorkspaceFingerprint(),
            files
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
        // Coerce type to symbol or class only (never 'file') so cache corruption/old format cannot
        // produce items that overwrite file entries in the search index deduplication map.
        const type = s.type === 'class' ? SearchItemType.Class : SearchItemType.Symbol;
        return {
            id: s.id,
            label: s.label,
            description: s.description,
            detail: s.detail,
            type,
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
     * Sort files by last modified date (newest first) so recently edited files get indexed first
     */
    private async sortFilesByModifiedDate(files: vscode.Uri[]): Promise<vscode.Uri[]> {
        if (files.length === 0) {
            return files;
        }

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
            if (i + batchSize < files.length) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }

        entries.sort((a, b) => b.mtime - a.mtime);
        return entries.map((e) => e.uri);
    }

    /**
     * Process a batch of files to extract symbols
     */
    private async processFileBatch(files: vscode.Uri[]): Promise<void> {
        for (const uri of files) {
            try {
                // Skip files that should be excluded
                if (ExclusionPatterns.shouldExclude(uri)) {
                    continue;
                }

                // Get document symbols using VSCode's document symbol provider
                Logger.log(`executeCommand vscode.executeDocumentSymbolProvider uri=${uri.toString()}`);
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    uri
                );

                if (!symbols || symbols.length === 0) {
                    continue;
                }

                // Process symbols recursively
                this.processSymbols(symbols, uri);
            } catch (error) {
                // Continue with other files if one fails
                console.error(`Error processing file ${uri.fsPath}:`, error);
            }
        }
    }

    /**
     * Process symbols iteratively using an explicit stack to avoid stack overflow
     * when document symbol trees are very deeply nested.
     */
    private processSymbols(symbols: vscode.DocumentSymbol[], uri: vscode.Uri, containerName: string = ''): void {
        type StackEntry = { symbols: vscode.DocumentSymbol[]; containerName: string };
        const stack: StackEntry[] = [{ symbols, containerName }];

        while (stack.length > 0) {
            const { symbols: currentSymbols, containerName: currentContainer } = stack.pop()!;

            for (const symbol of currentSymbols) {
                const symbolGroup = mapSymbolKindToGroup(symbol.kind);
                const isClass = symbolGroup === SymbolKindGroup.Class;
                const priority = this.getSymbolPriority(symbol.kind);

                const symbolItem: SymbolSearchItem = {
                    id: `symbol:${symbol.name}:${uri.toString()}:${symbol.range.start.line}:${symbol.range.start.character}`,
                    label: symbol.name,
                    description: `${this.getSymbolKindName(symbol.kind)}${currentContainer ? ` - ${currentContainer}` : ''}`,
                    detail: uri.fsPath,
                    type: isClass ? SearchItemType.Class : SearchItemType.Symbol,
                    uri: uri,
                    range: symbol.range,
                    symbolKind: symbol.kind,
                    symbolGroup: symbolGroup,
                    priority: priority,
                    iconPath: this.getSymbolIcon(symbol.kind),
                    action: async () => {
                        const document = await vscode.workspace.openTextDocument(uri);
                        const editor = await vscode.window.showTextDocument(document);
                        const range = symbol.selectionRange;
                        editor.selection = new vscode.Selection(range.start, range.start);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    }
                };

                this.symbolItems.push(symbolItem);

                if (symbol.children && symbol.children.length > 0) {
                    stack.push({ symbols: symbol.children, containerName: symbol.name });
                }
            }
        }
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
