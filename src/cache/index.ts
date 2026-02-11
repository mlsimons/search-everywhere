export { CACHE_VERSION, getWorkspaceFingerprint, getCacheDirUri, getCacheFileUri, ensureCacheDir, readCache, writeCache } from './storage';
export type { CacheKind } from './storage';
export type {
    ManifestEntry,
    SerializedFileItem,
    SerializedSymbolItem,
    FileIndexCache,
    DocumentSymbolsFileEntry,
    DocumentSymbolsCache,
    WorkspaceSymbolsCache,
    ActivityScoresCache
} from './types';
