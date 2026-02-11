import * as vscode from 'vscode';
import { encode, decode } from '@msgpack/msgpack';

/** Cache format version; bump to invalidate all caches */
export const CACHE_VERSION = 1;

const CACHE_DIR_NAME = 'search-everywhere-cache';
const FILE_INDEX_NAME = 'file-index.mp';
const DOCUMENT_SYMBOLS_NAME = 'document-symbols.mp';
const WORKSPACE_SYMBOLS_NAME = 'workspace-symbols.mp';
const ACTIVITY_SCORES_NAME = 'activity-scores.mp';

export type CacheKind = 'file-index' | 'document-symbols' | 'workspace-symbols' | 'activity-scores';

/**
 * Get a stable fingerprint for the current workspace (folder URIs + optional config hash).
 * Used to invalidate cache when workspace or key settings change.
 */
export function getWorkspaceFingerprint(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return '';
    }
    const uris = folders.map(f => f.uri.toString()).sort();
    return uris.join('|');
}

/**
 * Get the cache directory URI for this workspace. Returns undefined if no workspace or no storage.
 */
export function getCacheDirUri(storageUri: vscode.Uri | undefined): vscode.Uri | undefined {
    if (!storageUri) {
        return undefined;
    }
    return vscode.Uri.joinPath(storageUri, CACHE_DIR_NAME);
}

/**
 * Get the URI for a cache file.
 */
export function getCacheFileUri(storageUri: vscode.Uri | undefined, kind: CacheKind): vscode.Uri | undefined {
    const dir = getCacheDirUri(storageUri);
    if (!dir) {
        return undefined;
    }
    const name = kind === 'file-index' ? FILE_INDEX_NAME
        : kind === 'document-symbols' ? DOCUMENT_SYMBOLS_NAME
            : kind === 'workspace-symbols' ? WORKSPACE_SYMBOLS_NAME
                : ACTIVITY_SCORES_NAME;
    return vscode.Uri.joinPath(dir, name);
}

/**
 * Ensure the cache directory exists. Call before writing.
 */
export async function ensureCacheDir(storageUri: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
    const dir = getCacheDirUri(storageUri);
    if (!dir) {
        return undefined;
    }
    try {
        await vscode.workspace.fs.createDirectory(dir);
        return dir;
    } catch {
        return undefined;
    }
}

/**
 * Read and decode a MessagePack cache file. Returns undefined if file missing or decode fails.
 */
export async function readCache<T>(fileUri: vscode.Uri): Promise<T | undefined> {
    try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        const decoded = decode(data as Uint8Array) as T;
        return decoded;
    } catch {
        return undefined;
    }
}

/**
 * Encode payload with MessagePack and write to the cache file.
 * Call ensureCacheDir before this if the dir might not exist.
 */
export async function writeCache<T>(fileUri: vscode.Uri, payload: T): Promise<boolean> {
    try {
        const encoded = encode(payload);
        await vscode.workspace.fs.writeFile(fileUri, encoded as Uint8Array);
        return true;
    } catch (err) {
        console.error('Failed to write cache:', err);
        return false;
    }
}
