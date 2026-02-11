import * as vscode from 'vscode';
import { FileSearchItem, SearchItemType, SearchProvider } from '../core/types';
import { ExclusionPatterns } from '../utils/exclusions';
import {
    CACHE_VERSION,
    getCacheFileUri,
    getWorkspaceFingerprint,
    ensureCacheDir,
    readCache,
    writeCache
} from '../cache';
import type { FileIndexCache, SerializedFileItem, ManifestEntry } from '../cache';
import Logger from '../utils/logging';

/**
 * Provides file search items from the workspace.
 * Uses a persistent cache keyed by file mtime; only re-indexes new or modified files.
 */
export class FileSearchProvider implements SearchProvider {
    private fileItems: FileSearchItem[] = [];
    private isRefreshing: boolean = false;
    /** In-flight refresh promise so getItems() can wait for it instead of returning [] when refresh started elsewhere */
    private refreshPromise: Promise<void> | null = null;
    private readonly storageUri: vscode.Uri | undefined;

    constructor(storageUri?: vscode.Uri) {
        this.storageUri = storageUri;
        // Listen for changes in workspace files
        vscode.workspace.onDidCreateFiles(() => this.refresh());
        vscode.workspace.onDidDeleteFiles(() => this.refresh());
        vscode.workspace.onDidRenameFiles(() => this.refresh());
    }

    /**
     * Get all indexed file items.
     * If a refresh is in progress (e.g. from initial index or updateIndexFromProviders racing),
     * waits for it to finish so we never return [] while cache is still loading.
     */
    public async getItems(_onBatch?: import('../core/types').OnBatchCallback): Promise<FileSearchItem[]> {
        if (this.fileItems.length === 0 && !this.isRefreshing) {
            await this.refresh();
        } else if (this.isRefreshing && this.refreshPromise) {
            await this.refreshPromise;
        }
        return this.fileItems;
    }

    /**
     * Refresh the file index. Uses cache when possible; only re-indexes new or modified files.
     * @param force If true, ignores cache and does a full re-index.
     */
    public async refresh(force: boolean = false): Promise<void> {
        if (this.isRefreshing) {
            return this.refreshPromise ?? Promise.resolve();
        }

        this.isRefreshing = true;
        Logger.log('Refreshing file index...');
        const startTime = performance.now();

        this.fileItems = [];

        const doRefresh = async (): Promise<void> => {
            try {
                if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                    Logger.log('No workspace folders found');
                    return;
                }

                if (force || !this.storageUri) {
                    await this.fullRefresh();
                } else {
                    const usedCache = await this.refreshFromCacheOrFull();
                    if (!usedCache) {
                        await this.fullRefresh();
                    }
                }

                if (this.storageUri) {
                    await this.saveCache();
                }
            } catch (error) {
                console.error('Error refreshing file index:', error);
            } finally {
                this.isRefreshing = false;
                this.refreshPromise = null;
                const endTime = performance.now();
                Logger.log(`Indexed ${this.fileItems.length} files in ${endTime - startTime}ms`);
            }
        };

        this.refreshPromise = doRefresh();
        await this.refreshPromise;
    }

    /**
     * Try to load from cache and do incremental update. Returns true if cache was used.
     */
    private async refreshFromCacheOrFull(): Promise<boolean> {
        const fileUri = getCacheFileUri(this.storageUri, 'file-index');
        if (!fileUri) {
            return false;
        }

        const cache = await readCache<FileIndexCache>(fileUri);
        const fingerprint = getWorkspaceFingerprint();
        if (!cache || cache.version !== CACHE_VERSION || cache.workspaceFingerprint !== fingerprint) {
            return false;
        }

        const excludePattern = ExclusionPatterns.getExclusionGlob();
        const currentEntries: { uri: vscode.Uri; mtime: number }[] = [];

        for (const folder of vscode.workspace.workspaceFolders!) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*.*'),
                excludePattern
            );
            const batchSize = 1500;
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
                currentEntries.push(...stats);
                if (i + batchSize < files.length) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
        }

        const cachedMtimeByUri = new Map(cache.manifest.map((e) => [e.uri, e.mtime]));
        const cachedItemByUri = new Map(cache.items.map((i) => [i.uri, i]));

        const unchanged: FileSearchItem[] = [];
        const toIndex: vscode.Uri[] = [];

        for (const { uri, mtime } of currentEntries) {
            const uriStr = uri.toString();
            const cachedMtime = cachedMtimeByUri.get(uriStr);
            if (cachedMtime !== undefined && cachedMtime === mtime) {
                const serialized = cachedItemByUri.get(uriStr);
                if (serialized) {
                    unchanged.push(this.deserializeFileItem(serialized));
                } else {
                    toIndex.push(uri);
                }
            } else {
                toIndex.push(uri);
            }
        }

        this.fileItems = [...unchanged];

        if (toIndex.length > 0) {
            const byFolder = this.groupUrisByFolder(toIndex);
            for (const [folder, uris] of byFolder.entries()) {
                this.processFileBatch(uris, folder);
            }
        }

        // Sort by mtime (newest first) - currentEntries order is not sorted, so sort this.fileItems by uri position in currentEntries
        const orderMap = new Map(currentEntries.map((e, idx) => [e.uri.toString(), idx]));
        const mtimeMap = new Map(currentEntries.map((e) => [e.uri.toString(), e.mtime]));
        this.fileItems.sort((a, b) => {
            const mtimeA = mtimeMap.get(a.uri.toString()) ?? 0;
            const mtimeB = mtimeMap.get(b.uri.toString()) ?? 0;
            return mtimeB - mtimeA;
        });

        Logger.log(`File index: ${unchanged.length} from cache, ${toIndex.length} re-indexed`);
        return true;
    }

    private groupUrisByFolder(uris: vscode.Uri[]): Map<vscode.WorkspaceFolder, vscode.Uri[]> {
        const map = new Map<vscode.WorkspaceFolder, vscode.Uri[]>();
        const folders = vscode.workspace.workspaceFolders!;
        for (const uri of uris) {
            const folder = folders.find((f) => uri.toString().startsWith(f.uri.toString()));
            if (folder) {
                let list = map.get(folder);
                if (!list) {
                    list = [];
                    map.set(folder, list);
                }
                list.push(uri);
            }
        }
        return map;
    }

    private async fullRefresh(): Promise<void> {
        const excludePattern = ExclusionPatterns.getExclusionGlob();

        for (const folder of vscode.workspace.workspaceFolders!) {
            Logger.log(`Indexing files in workspace folder: ${folder.name}`);

            let files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*.*'),
                excludePattern
            );
            Logger.log(`Found ${files.length} files in ${folder.name}`);

            files = await this.sortFilesByModifiedDate(files);

            const batchSize = 1000;
            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                this.processFileBatch(batch, folder);

                if (i > 0 && i % 5000 === 0) {
                    Logger.log(`Processed ${i} files...`);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
        }
    }

    private async saveCache(): Promise<void> {
        const fileUri = getCacheFileUri(this.storageUri, 'file-index');
        if (!fileUri) {
            return;
        }

        await ensureCacheDir(this.storageUri);

        const manifest: ManifestEntry[] = [];
        const items: SerializedFileItem[] = [];

        for (const item of this.fileItems) {
            try {
                const stat = await vscode.workspace.fs.stat(item.uri);
                manifest.push({ uri: item.uri.toString(), mtime: stat.mtime });
            } catch {
                manifest.push({ uri: item.uri.toString(), mtime: 0 });
            }
            items.push(this.serializeFileItem(item));
        }

        const payload: FileIndexCache = {
            version: CACHE_VERSION,
            workspaceFingerprint: getWorkspaceFingerprint(),
            manifest,
            items
        };

        await writeCache(fileUri, payload);
    }

    private serializeFileItem(item: FileSearchItem): SerializedFileItem {
        return {
            id: item.id,
            label: item.label,
            description: item.description,
            detail: item.detail,
            type: 'file',
            uri: item.uri.toString()
        };
    }

    private deserializeFileItem(s: SerializedFileItem): FileSearchItem {
        const uri = vscode.Uri.parse(s.uri);
        const fileName = uri.fsPath.split(/[\/\\]/).pop() || '';
        return {
            id: s.id,
            label: s.label,
            description: s.description,
            detail: s.detail,
            type: SearchItemType.File,
            uri,
            iconPath: this.getFileIcon(fileName),
            action: async () => {
                await vscode.window.showTextDocument(uri);
            }
        };
    }

    /**
     * Sort files by last modified date (newest first).
     */
    private async sortFilesByModifiedDate(files: vscode.Uri[]): Promise<vscode.Uri[]> {
        if (files.length === 0) {
            return files;
        }

        const batchSize = 1500;
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
     * Process a batch of files
     */
    private processFileBatch(files: vscode.Uri[], workspaceFolder: vscode.WorkspaceFolder): void {
        for (const uri of files) {
            try {
                let relativePath = uri.fsPath;
                const workspacePath = workspaceFolder.uri.fsPath;

                if (relativePath.startsWith(workspacePath)) {
                    relativePath = relativePath.substring(workspacePath.length);
                    if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
                        relativePath = relativePath.substring(1);
                    }
                }

                const fileName = uri.fsPath.split(/[\/\\]/).pop() || '';

                this.fileItems.push({
                    id: `file:${uri.toString()}`,
                    label: fileName,
                    description: relativePath,
                    detail: uri.fsPath,
                    type: SearchItemType.File,
                    uri: uri,
                    iconPath: this.getFileIcon(fileName),
                    action: async () => {
                        await vscode.window.showTextDocument(uri);
                    }
                });
            } catch (error) {
                console.error(`Error processing file ${uri.fsPath}:`, error);
            }
        }
    }

    private getFileIcon(fileName: string): vscode.ThemeIcon {
        const extension = fileName.split('.').pop()?.toLowerCase();

        switch (extension) {
            case 'js':
            case 'jsx':
            case 'ts':
            case 'tsx':
                return new vscode.ThemeIcon('file-code');
            case 'json':
                return new vscode.ThemeIcon('file-json');
            case 'md':
                return new vscode.ThemeIcon('markdown');
            case 'html':
            case 'htm':
                return new vscode.ThemeIcon('html');
            case 'css':
            case 'scss':
            case 'sass':
            case 'less':
                return new vscode.ThemeIcon('file-css');
            case 'xml':
                return new vscode.ThemeIcon('file-xml');
            case 'py':
                return new vscode.ThemeIcon('python');
            case 'cs':
                return new vscode.ThemeIcon('c-sharp');
            case 'java':
                return new vscode.ThemeIcon('java');
            case 'c':
            case 'cpp':
            case 'h':
            case 'hpp':
            case 'php':
            case 'go':
            case 'rb':
            case 'rust':
            case 'rs':
                return new vscode.ThemeIcon('file-code');
            case 'sh':
            case 'bash':
                return new vscode.ThemeIcon('terminal');
            case 'yaml':
            case 'yml':
                return new vscode.ThemeIcon('file-yaml');
            case 'toml':
            case 'sql':
                return new vscode.ThemeIcon('file-text');
            case 'ps1':
                return new vscode.ThemeIcon('terminal-powershell');
            case 'git':
            case 'gitignore':
            case 'gitattributes':
                return new vscode.ThemeIcon('git');
            default:
                return new vscode.ThemeIcon('file');
        }
    }
}
