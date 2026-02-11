import * as vscode from 'vscode';

/**
 * Type of search item
 */
export enum SearchItemType {
    File = 'file',
    Command = 'command',
    Symbol = 'symbol',
    Class = 'class',        // Added for specific class filtering
    TextMatch = 'text'      // Text search matches
}

/**
 * Category groups for symbols
 */
export enum SymbolKindGroup {
    Class,        // Classes, interfaces, etc.
    Function,     // Methods, functions
    Variable,     // Variables, properties, fields
    Other         // Everything else
}

/**
 * Maps VS Code symbol kinds to our simplified groups
 */
export function mapSymbolKindToGroup(kind: vscode.SymbolKind): SymbolKindGroup {
    switch (kind) {
        case vscode.SymbolKind.Class:

        case vscode.SymbolKind.Interface:

        case vscode.SymbolKind.Struct:

        case vscode.SymbolKind.Enum:
            return SymbolKindGroup.Class;

        case vscode.SymbolKind.Function:

        case vscode.SymbolKind.Method:

        case vscode.SymbolKind.Constructor:
            return SymbolKindGroup.Function;

        case vscode.SymbolKind.Variable:

        case vscode.SymbolKind.Property:

        case vscode.SymbolKind.Field:

        case vscode.SymbolKind.Constant:
            return SymbolKindGroup.Variable;

        default:
            return SymbolKindGroup.Other;
    }
}

/**
 * Base interface for all searchable items
 */
export interface SearchItem {
    id: string;
    label: string;
    description: string;
    detail: string;
    type: SearchItemType;
    iconPath?: vscode.ThemeIcon | vscode.Uri;
    action: () => Promise<void>;

    // Optional scores for ranking
    score?: number;         // Fuzzy search score
    activityScore?: number; // User activity score
    priority?: number;      // Higher number = higher priority
}

/**
 * File search item interface
 */
export interface FileSearchItem extends SearchItem {
    type: SearchItemType.File;
    uri: vscode.Uri;
    // Optional relativePath allows for backward compatibility
    relativePath?: string;
}

/**
 * Command search item interface
 */
export interface CommandSearchItem extends SearchItem {
    type: SearchItemType.Command;
    command: string;
    args?: any[];
}

/**
 * Symbol search item interface
 */
export interface SymbolSearchItem extends SearchItem {
    type: SearchItemType.Symbol | SearchItemType.Class;
    uri: vscode.Uri;
    range: vscode.Range;
    symbolKind: vscode.SymbolKind;
    symbolGroup?: SymbolKindGroup;
}

/**
 * Text match search item interface
 */
export interface TextMatchItem extends SearchItem {
    type: SearchItemType.TextMatch;
    uri: vscode.Uri;
    range: vscode.Range;
    lineText: string;     // The content of the line containing the match
    matchText: string;    // The actual matched text
}

/**
 * Options passed to fuzzy search (e.g. from config)
 */
export interface FuzzySearchOptions {
    // Reserved for future options
}

/**
 * Interface for fuzzy searchers
 */
export interface FuzzySearcher {
    name: string;
    search(items: SearchItem[], query: string, limit?: number, options?: FuzzySearchOptions): Promise<SearchItem[]>;
}

/**
 * Optional callback for providers that stream results as they are indexed.
 * When provided, the provider may call it with batches of items (e.g. after each file or batch of files).
 */
export type OnBatchCallback = (items: SearchItem[]) => void;

/**
 * Interface for search providers
 */
export interface SearchProvider {
    /**
     * Get all items. If onBatch is provided, the provider may call it with batches of items
     * as they become available (e.g. after each file is indexed). The promise still resolves
     * with the full list when indexing is complete.
     */
    getItems(onBatch?: OnBatchCallback): Promise<SearchItem[]>;
    /** @param force If true, ignore cache and do a full re-index */
    refresh(force?: boolean): Promise<void>;
}

/**
 * Configuration interface for Search Everywhere
 */
export interface SearchEverywhereConfig {
    indexing: {
        includeFiles: boolean;
        includeSymbols: boolean;
        includeCommands: boolean;
        includeText: boolean;
    };
    activity: {
        enabled: boolean;
        weight: number;
    };
    performance: {
        maxResults: number;
        maxTextResults: number;
        /** Max number of source files to scan for document symbols (private methods, etc.). */
        maxDocumentSymbolFiles: number;
    };
    fuzzySearch: {
        library: string;
    };
    preview: {
        enabled: boolean;
    };
    // Global exclusions that apply to all providers (files, symbols, etc.)
    exclusions?: string[];
    // Debug mode for detailed logging
    debug?: boolean;
}
