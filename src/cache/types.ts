/**
 * Serializable types for the persistent index cache.
 * SearchItem has non-serializable fields (action, iconPath); we store only these payloads.
 */

/** Single manifest entry: file uri and its last-modified time when cached */
export interface ManifestEntry {
    uri: string;
    mtime: number;
}

/** Serialized file search item (no action/iconPath; rebuilt on load) */
export interface SerializedFileItem {
    id: string;
    label: string;
    description: string;
    detail: string;
    type: 'file';
    uri: string;
}

/** Serialized symbol search item (no action/iconPath; rebuilt on load) */
export interface SerializedSymbolItem {
    id: string;
    label: string;
    description: string;
    detail: string;
    type: 'symbol' | 'class';
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    symbolKind: number;
    symbolGroup?: number;
    priority?: number;
}

/** File index cache payload */
export interface FileIndexCache {
    version: number;
    workspaceFingerprint: string;
    manifest: ManifestEntry[];
    items: SerializedFileItem[];
}

/** Per-file document symbols entry */
export interface DocumentSymbolsFileEntry {
    mtime: number;
    symbols: SerializedSymbolItem[];
}

/** Document symbols cache payload (map of uri -> entry) */
export interface DocumentSymbolsCache {
    version: number;
    workspaceFingerprint: string;
    files: Record<string, DocumentSymbolsFileEntry>;
}

/** Workspace symbols cache payload */
export interface WorkspaceSymbolsCache {
    version: number;
    workspaceFingerprint: string;
    manifest: ManifestEntry[];
    items: SerializedSymbolItem[];
}

/**
 * Persisted activity scores (selection history) keyed by item deduplication key.
 * Values are timestamps (Date.now()) so recently picked items can be boosted across sessions.
 */
export interface ActivityScoresCache {
    version: number;
    workspaceFingerprint?: string; // optional for backward compatibility
    /** Dedupe key -> timestamp when the user last selected that item */
    entries: Record<string, number>;
}
