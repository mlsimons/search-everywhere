import * as vscode from 'vscode';
import { SearchItem, SearchItemType } from '../core/types';
import { SearchService } from '../core/search-service';
import { getConfiguration } from '../utils/config';
import Logger from '../utils/logging';

/**
 * Filter categories for search results (order used for Tab cycling)
 */
export enum FilterCategory {
    All = 'all',
    Classes = 'classes',
    Files = 'files',
    Symbols = 'symbols',
    Actions = 'actions',
    Text = 'text'
}

/** Order of filters when cycling with Tab (all possible categories) */
const FILTER_ORDER: FilterCategory[] = [
    FilterCategory.All,
    FilterCategory.Classes,
    FilterCategory.Files,
    FilterCategory.Symbols,
    FilterCategory.Actions,
    FilterCategory.Text
];

/**
 * Manages the VSCode UI for search everywhere
 */
export class SearchUI {
    private quickPick: vscode.QuickPick<SearchQuickPickItem>;
    private searchDebounce: NodeJS.Timeout | undefined;
    private lastQuery: string = '';
    private config = getConfiguration();
    private previewDisposables: vscode.Disposable[] = [];

    // Active filter category
    private activeFilter: FilterCategory = FilterCategory.All;

    // Custom buttons for filter categories
    private filterButtons: Map<FilterCategory, vscode.QuickInputButton> = new Map();

    /** Last item the user highlighted; used to preserve selection when items list is replaced (avoids wrong-item bug) */
    private lastActiveOriginalItem: SearchItem | undefined;

    /** Last unfiltered search results; used to re-apply category filter instantly when switching filters without re-running search. */
    private lastRawResults: SearchItem[] = [];

    /** True only after the first result set from show() is displayed; until then we ignore filter input to avoid clearing/race. */
    private initialLoadComplete = true;

    // Prefixes for button tooltips
    private readonly ACTIVE_PREFIX = '● '; // Filled circle for active filter
    private readonly INACTIVE_PREFIX = '○ '; // Empty circle for inactive filter

    /**
     * Initialize the search UI
     */
    constructor(private searchService: SearchService) {
        // Create quick pick UI
        this.quickPick = vscode.window.createQuickPick<SearchQuickPickItem>();
        this.quickPick.placeholder = 'Type to search everywhere (files, classes, symbols...)';
        this.quickPick.matchOnDescription = false;
        this.quickPick.matchOnDetail = false;
        this.quickPick.ignoreFocusOut = false;

        // Create filter category buttons
        this.createFilterButtons();

        // Set initial buttons
        this.updateFilterButtons();

        // Set up event handlers
        this.quickPick.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.quickPick.onDidAccept(this.onDidAccept.bind(this));
        this.quickPick.onDidHide(this.onDidHide.bind(this));
        this.quickPick.onDidTriggerButton(this.onDidTriggerButton.bind(this));

        // Add preview handler
        this.quickPick.onDidChangeActive(this.onDidChangeActive.bind(this));

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('searchEverywhere')) {
                this.config = getConfiguration();
            }
        });
    }

    /**
     * Return filter categories that are enabled by config (only show buttons for registered providers).
     */
    private getEnabledFilterOrder(): FilterCategory[] {
        return FILTER_ORDER.filter(f => {
            switch (f) {
                case FilterCategory.All: return true;
                case FilterCategory.Classes:
                case FilterCategory.Symbols: return this.config.indexing.includeSymbols;
                case FilterCategory.Files: return this.config.indexing.includeFiles;
                case FilterCategory.Actions: return this.config.indexing.includeCommands;
                case FilterCategory.Text: return this.config.indexing.includeText;
                default: return true;
            }
        });
    }

    /**
     * Create filter buttons for each category (buttons for disabled categories exist but are not shown).
     */
    private createFilterButtons(): void {
        // Define icons for each category
        this.filterButtons.set(FilterCategory.All, {
            iconPath: new vscode.ThemeIcon('search'),
            tooltip: this.INACTIVE_PREFIX + 'All'
        });

        this.filterButtons.set(FilterCategory.Classes, {
            iconPath: new vscode.ThemeIcon('symbol-class'),
            tooltip: this.INACTIVE_PREFIX + 'Classes'
        });

        this.filterButtons.set(FilterCategory.Files, {
            iconPath: new vscode.ThemeIcon('file'),
            tooltip: this.INACTIVE_PREFIX + 'Files'
        });

        this.filterButtons.set(FilterCategory.Symbols, {
            iconPath: new vscode.ThemeIcon('symbol-method'),
            tooltip: this.INACTIVE_PREFIX + 'Symbols'
        });

        this.filterButtons.set(FilterCategory.Actions, {
            iconPath: new vscode.ThemeIcon('run'),
            tooltip: this.INACTIVE_PREFIX + 'Actions'
        });

        this.filterButtons.set(FilterCategory.Text, {
            iconPath: new vscode.ThemeIcon('file-text'),
            tooltip: this.INACTIVE_PREFIX + 'Text'
        });
    }

    /**
     * Update the filter buttons in the UI based on the active filter
     */
    private updateFilterButtons(): void {
        const enabledOrder = this.getEnabledFilterOrder();
        // If current filter is disabled (e.g. Actions when commands provider not registered), switch to All
        if (!enabledOrder.includes(this.activeFilter)) {
            this.activeFilter = FilterCategory.All;
        }

        // Create filter buttons only for enabled categories
        const buttons: vscode.QuickInputButton[] = [];
        const filterNames: string[] = []; // Collect names for the placeholder text

        for (const filter of enabledOrder) {
            // Get the base filter button
            const baseButton = this.filterButtons.get(filter);

            if (!baseButton) {continue;}

            const isActive = filter === this.activeFilter;
            const filterName = filter.charAt(0).toUpperCase() + filter.slice(1);

            // Track filter name (with highlighting if active)
            filterNames.push(isActive ? `[${filterName}]` : filterName);

            // Get base name without the prefix
            const baseName = (baseButton.tooltip || '').replace(this.ACTIVE_PREFIX, '').replace(this.INACTIVE_PREFIX, '');

            // Create a modified button with visual indicator for the active filter
            const button: vscode.QuickInputButton = {
                // Active filter: colored icon; inactive: default icon
                iconPath: isActive
                    ? this.getActiveIcon(filter)
                    : baseButton.iconPath,
                // Tooltip makes selected filter obvious (● Name = active, ○ Name = inactive)
                tooltip: isActive
                    ? this.ACTIVE_PREFIX + baseName + ' (selected)'
                    : this.INACTIVE_PREFIX + baseName
            };

            buttons.push(button);
        }

        // Update the QuickPick interface
        this.quickPick.buttons = buttons;

        // Update placeholder text with filter information
        if (this.activeFilter !== FilterCategory.All) {
            const activeFilterName = this.activeFilter.charAt(0).toUpperCase() + this.activeFilter.slice(1);

            this.quickPick.placeholder = `Searching in ${activeFilterName} only. Type to search...`;
        } else {
            this.quickPick.placeholder = 'Type to search everywhere (files, classes, symbols...)';
        }
    }

    /**
     * Get a visually distinct active icon so the selected filter is easy to see.
     * Uses a different icon shape (circle-filled) for the active filter so it stands out even when
     * theme colors are ignored by the quick pick toolbar. The title/placeholder still show which category (e.g. "⟪ Files ⟫").
     */
    private getActiveIcon(_filter: FilterCategory): vscode.ThemeIcon {
        const activeColor = new vscode.ThemeColor('badge.background');
        return new vscode.ThemeIcon('circle-filled', activeColor);
    }

    /**
     * Cycle to the next filter category (e.g. when user presses Tab).
     * Keybinding is only active when searchEverywhereQuickPickVisible is true.
     */
    public cycleToNextFilter(): void {
        const order = this.getEnabledFilterOrder();
        const idx = order.indexOf(this.activeFilter);
        const nextIdx = idx < 0 ? 0 : (idx + 1) % order.length;
        this.activeFilter = order[nextIdx];

        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
        }
        this.updateTitle();
        this.updateFilterButtons();
        this.applyFilterOnly();
    }

    /**
     * Cycle to the previous filter category.
     * Keybinding: Alt+Shift+Tab (Shift+Tab does not work in VS Code quick pick - see vscode#180862).
     * Keybinding is only active when searchEverywhereQuickPickVisible is true.
     */
    public cycleToPreviousFilter(): void {
        const order = this.getEnabledFilterOrder();
        const idx = order.indexOf(this.activeFilter);
        const prevIdx = idx <= 0 ? order.length - 1 : idx - 1;
        this.activeFilter = order[prevIdx];

        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
        }
        this.updateTitle();
        this.updateFilterButtons();
        this.applyFilterOnly();
    }

    /**
     * Handle button clicks for category filters
     */
    private onDidTriggerButton(button: vscode.QuickInputButton): void {
        // Extract the base tooltip without prefixes
        const tooltip = button.tooltip || '';
        const baseTooltip = tooltip
            .replace(this.ACTIVE_PREFIX, '')
            .replace(this.INACTIVE_PREFIX, '');

        // Find which filter button was clicked
        for (const [category, filterButton] of this.filterButtons.entries()) {
            const buttonBaseTooltip = (filterButton.tooltip || '')
                .replace(this.ACTIVE_PREFIX, '')
                .replace(this.INACTIVE_PREFIX, '');

            if (buttonBaseTooltip === baseTooltip) {
                // Set the active filter
                this.activeFilter = category;

                // Clear search debounce
                if (this.searchDebounce) {
                    clearTimeout(this.searchDebounce);
                }

                // Update title to show active filter
                this.updateTitle();

                // Update buttons to highlight the active one
                this.updateFilterButtons();

                // Re-apply filter to cached results (instant; no search service call)
                this.applyFilterOnly();
                break;
            }
        }
    }

    /**
     * Update the title of the quick pick to reflect the active filter
     */
    private updateTitle(): void {
        const filterName = this.activeFilter.charAt(0).toUpperCase() + this.activeFilter.slice(1);

        if (this.activeFilter === FilterCategory.All) {
            this.quickPick.title = 'Search Everywhere';
        } else {
            // Use special characters for emphasis since codicons don't work in title
            this.quickPick.title = `⟪ ${filterName} ⟫`;
        }
    }

    /**
     * Show the search dialog
     */
    public show(): void {
        // Always reset to "All" filter when opening
        this.activeFilter = FilterCategory.All;

        // Cancel any pending debounced search from a previous session so it can't overwrite our initial results
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = undefined;
        }

        // Clear previous query state
        this.quickPick.value = '';
        this.lastQuery = '';
        this.lastRawResults = [];

        // Refresh configuration
        this.config = getConfiguration();

        // Update buttons to reflect the active filter
        this.updateFilterButtons();

        // Update title
        this.updateTitle();

        // Postpone index updates while the pick is open so the list doesn't change and accept goes to the right place
        this.searchService.setSearchUIActive(true);

        // Ignore filter input until the first result set is displayed (avoids filter text being cleared/races)
        this.initialLoadComplete = false;

        // Show the quick pick (set context so Tab keybinding is active)
        this.quickPick.show();
        void vscode.commands.executeCommand('setContext', 'searchEverywhereQuickPickVisible', true);

        // Defer initial search to next tick: QuickPick may fire onDidChangeValue(previousValue) when it becomes visible.
        // Do not clear quickPick.value here — if the user already typed, we must not overwrite their text.
        setTimeout(() => {
            if (this.searchDebounce) {
                clearTimeout(this.searchDebounce);
                this.searchDebounce = undefined;
            }
            const currentValue = this.quickPick.value;
            this.lastQuery = currentValue;
            this.performSearch(currentValue);
        }, 0);
    }

    /**
     * Handle user typing in the search box
     */
    private onDidChangeValue(value: string): void {
        // Ignore input until the first result set is displayed (avoids filter cleared / wrong results)
        if (!this.initialLoadComplete) {
            return;
        }

        // Clear any scheduled search
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
        }

        // Don't search again if the query hasn't changed
        if (value === this.lastQuery) {
            return;
        }

        this.lastQuery = value;

        // Show "Searching..." when query changes
        this.quickPick.busy = true;

        // Debounce to avoid excessive searches while typing
        this.searchDebounce = setTimeout(() => {
            this.performSearch(value);
        }, 50); // Very short delay for responsiveness
    }

    /**
     * Execute search and update UI
     */
    private async performSearch(query: string): Promise<void> {
        try {
            this.quickPick.busy = true;

            // Perform search
            const results = await this.searchService.search(query);

            // Ignore stale results: if the user changed the query (or filter) while this search was
            // in flight, do not replace the list. Otherwise we can show wrong results and the
            // highlighted row can resolve to the wrong item on accept (especially when indexing
            // is still running and progress is visible).
            if (query !== this.lastQuery) {
                return;
            }

            this.lastRawResults = results;

            // Apply category filter and limit to maxResults
            const maxResults = this.config.performance.maxResults;
            const filteredResults = this.applyCategoryFilter(results, maxResults);
            const items = filteredResults.map(item => this.createQuickPickItem(item));

            // Group items by type
            // mstodo const groupedItems = this.groupItemsByType(items);
            this.quickPick.items = items;

            // Preserve selection by item identity when replacing the list. Otherwise VS Code keeps
            // selection by index, so the highlighted row can become a different item (wrong location on accept).
            const firstSelectable = items.find(
                qi => qi.kind !== vscode.QuickPickItemKind.Separator && qi.originalItem
            );
            if (this.lastActiveOriginalItem) {
                const targetId = this.lastActiveOriginalItem.id;
                const match = items.find(
                    qi => qi.kind !== vscode.QuickPickItemKind.Separator && qi.originalItem?.id === targetId
                );
                if (match) {
                    this.quickPick.activeItems = [match];
                } else if (firstSelectable) {
                    // No match (e.g. item filtered out or not in new results). Do not leave selection
                    // by index or we may run the wrong item's action on accept.
                    this.quickPick.activeItems = [firstSelectable];
                }
            } else if (firstSelectable) {
                this.quickPick.activeItems = [firstSelectable];
            }

        } catch (error) {
            console.error('Error performing search:', error);
            this.quickPick.placeholder = 'Error performing search';
        } finally {
            this.quickPick.busy = false;
            // After first result set is shown, accept filter input and catch up if user typed meanwhile
            if (!this.initialLoadComplete) {
                this.initialLoadComplete = true;
                if (this.quickPick.value !== this.lastQuery) {
                    this.lastQuery = this.quickPick.value;
                    void this.performSearch(this.quickPick.value);
                }
            }
        }
    }

    /**
     * Apply the active category filter to search results and limit to maxResults.
     */
    private applyCategoryFilter(items: SearchItem[], maxResults: number): SearchItem[] {
        let filtered: SearchItem[];
        if (this.activeFilter === FilterCategory.All) {
            filtered = items;
        } else {
            filtered = items.filter(item => {
                switch (this.activeFilter) {
                    case FilterCategory.Classes:
                        return item.type === SearchItemType.Class;

                    case FilterCategory.Files:
                        return item.type === SearchItemType.File;

                    case FilterCategory.Symbols:
                        return item.type === SearchItemType.Symbol;

                    case FilterCategory.Actions:
                        return item.type === SearchItemType.Command;

                    case FilterCategory.Text:
                        return item.type === SearchItemType.TextMatch;

                    default:
                        return true;
                }
            });
        }
        return filtered.slice(0, maxResults);
    }

    /**
     * Re-apply the current category filter to cached results and update the list.
     * Used when switching filters so we don't re-run the search service (instant response).
     */
    private applyFilterOnly(): void {
        const maxResults = this.config.performance.maxResults;
        const filteredResults = this.applyCategoryFilter(this.lastRawResults, maxResults);
        const items = filteredResults.map(item => this.createQuickPickItem(item));

        this.quickPick.items = items;

        const firstSelectable = items.find(
            qi => qi.kind !== vscode.QuickPickItemKind.Separator && qi.originalItem
        );
        if (this.lastActiveOriginalItem) {
            const targetId = this.lastActiveOriginalItem.id;
            const match = items.find(
                qi => qi.kind !== vscode.QuickPickItemKind.Separator && qi.originalItem?.id === targetId
            );
            if (match) {
                this.quickPick.activeItems = [match];
            } else if (firstSelectable) {
                this.quickPick.activeItems = [firstSelectable];
            }
        } else if (firstSelectable) {
            this.quickPick.activeItems = [firstSelectable];
        }
    }

    /**
     * Handle user selecting an item
     * Use the active (highlighted) item so we never run the wrong item's action when the list
     * was recently replaced and selectedItems could be stale or index-based.
     */
    private async onDidAccept(): Promise<void> {
        const toUse = this.quickPick.activeItems.length > 0
            ? this.quickPick.activeItems[0]
            : this.quickPick.selectedItems[0];

        if (toUse) {
            // Close the quick pick
            this.quickPick.hide();

            // Execute the action
            try {
                if (toUse.originalItem) {
                    this.searchService.recordItemUsed(toUse.originalItem);
                    await toUse.originalItem.action();
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('Error executing action:', error);
                if (this.isFileOpenBlockedError(message)) {
                    vscode.window.showErrorMessage(
                        "This file can't be opened in the editor (it may be too large or from a cached index). Try opening it from the file explorer or pick a different result."
                    );
                } else {
                    vscode.window.showErrorMessage(`Could not open: ${message}`);
                }
            }
        }
    }

    /**
     * Handle user closing the dialog
     */
    private onDidHide(): void {
        this.searchService.setSearchUIActive(false);
        Logger.log('executeCommand setContext searchEverywhereQuickPickVisible=false');
        void vscode.commands.executeCommand('setContext', 'searchEverywhereQuickPickVisible', false);

        this.lastActiveOriginalItem = undefined;
        this.lastQuery = '';
        this.initialLoadComplete = true; // Reset so next show() starts with input disabled until ready

        // Clear any scheduled search
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
        }

        // Clear quick pick value and items so reopening shows recent items, not previous search
        this.quickPick.value = '';
        this.quickPick.items = [];

        // Dispose of any preview disposables
        this.disposePreviewDisposables();
    }

    /**
     * Dispose of preview-related disposables
     */
    private disposePreviewDisposables(): void {
        for (const disposable of this.previewDisposables) {
            disposable.dispose();
        }
        this.previewDisposables = [];
    }

    /**
     * Handle selection changes for previewing and active-row indicator
     */
    private onDidChangeActive(items: readonly SearchQuickPickItem[]): void {
        // Always track last active item so we can preserve selection when the list is replaced
        if (items.length > 0) {
            const selectedItem = items[0];
            if (selectedItem.kind !== vscode.QuickPickItemKind.Separator && selectedItem.originalItem) {
                this.lastActiveOriginalItem = selectedItem.originalItem;
            }
        }

        // Skip if preview is disabled or no items are selected
        if (!this.config.preview.enabled || items.length === 0) {
            return;
        }

        // Get the selected item
        const selectedItem = items[0];

        // Skip separators and items without an original item
        if (selectedItem.kind === vscode.QuickPickItemKind.Separator || !selectedItem.originalItem) {
            return;
        }

        // Clear previous preview disposables
        this.disposePreviewDisposables();

        // Handle different types of items
        const item = selectedItem.originalItem;

        // Only preview items that have a URI and can be opened in the editor
        if ('uri' in item && item.uri instanceof vscode.Uri) {
            this.previewItem(item as SearchItem & { uri: vscode.Uri });
        }
    }

    /**
     * Preview a search item in the editor
     */
    private async previewItem(item: SearchItem & { uri: vscode.Uri }): Promise<void> {
        try {
            // Open the document
            const document = await vscode.workspace.openTextDocument(item.uri);

            // Define preview options
            const options: vscode.TextDocumentShowOptions = {
                preserveFocus: true, // Keep focus on the search dialog
                preview: true        // Show in preview tab
            };

            // Add range if available (for symbols)
            if ('range' in item && item.range instanceof vscode.Range) {
                options.selection = item.range;
            }

            // Show the document
            const editor = await vscode.window.showTextDocument(document, options);

            // Highlight the range if available
            if ('range' in item && item.range instanceof vscode.Range) {
                // Create decoration type for highlighting
                const decorationType = vscode.window.createTextEditorDecorationType({
                    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
                    borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder')
                });

                // Apply decoration
                editor.setDecorations(decorationType, [item.range]);

                // Add to disposables to clean up when selection changes
                this.previewDisposables.push(decorationType);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!this.isFileOpenBlockedError(message)) {
                console.error('Error previewing item:', error);
            }
        }
    }

    /**
     * Returns true if the error is due to the file not being openable in the editor
     * (e.g. over 50MB sync limit, or stale/cached path). Used to show a friendly message instead of raw API errors.
     */
    private isFileOpenBlockedError(message: string): boolean {
        const s = message.toLowerCase();
        return (
            s.includes('50mb') ||
            s.includes('cannot be synchronized') ||
            s.includes('synchronized with extensions') ||
            s.includes('cannot open file') ||
            s.includes('codeexpectederror')
        );
    }

    /**
     * Convert a SearchItem to a QuickPickItem
     */
    private createQuickPickItem(item: SearchItem): SearchQuickPickItem {
        // Enhance the label based on the active filter
        let label = item.label;

        // Get relative path for description if item has a URI
        let description = item.description || '';
        let detail = '';

        if ('uri' in item && item.uri instanceof vscode.Uri) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(item.uri);

            if (workspaceFolder) {
                // Get the relative path from the workspace root
                description = vscode.workspace.asRelativePath(item.uri);

                // Add line number for symbols and classes
                if (('range' in item) &&
                    (item.type === SearchItemType.Symbol || item.type === SearchItemType.Class)) {
                    const symbolItem = item as { range: vscode.Range };
                    const lineNumber = symbolItem.range.start.line + 1; // Convert to 1-based line number

                    description = `${description}:${lineNumber}`;
                }

                // Don't show the absolute path in the detail field
                // We'll keep detail empty or use it for other information
            }
        } else {
            // For non-file items, keep the original detail
            detail = item.detail || '';
        }

        return {
            label: label,
            description: description,
            detail: detail,
            iconPath: item.iconPath instanceof vscode.ThemeIcon ? item.iconPath : undefined,
            originalItem: item,
            type: item.type
        };
    }

    /**
     * Group items by type for better organization
     */
    private groupItemsByType(items: SearchQuickPickItem[]): SearchQuickPickItem[] {
        const groupedItems: SearchQuickPickItem[] = [];

        // Group items by type
        const itemsByType = new Map<SearchItemType, SearchQuickPickItem[]>();

        for (const item of items) {
            if (!itemsByType.has(item.type)) {
                itemsByType.set(item.type, []);
            }
            itemsByType.get(item.type)!.push(item);
        }

        // Define the order of types for display
        const typeOrder: SearchItemType[] = [
            SearchItemType.Class,
            SearchItemType.File,
            SearchItemType.Symbol,
            SearchItemType.TextMatch,
            SearchItemType.Command
        ];

        // Add section headers and items in the defined order
        for (const type of typeOrder) {
            const typeItems = itemsByType.get(type);

            // Skip empty sections
            if (!typeItems || typeItems.length === 0) {
                continue;
            }

            // Create a more visually distinct header for the active filter's section
            const typeName = this.getTypeName(type);
            const isActiveFilterSection =
                (this.activeFilter === FilterCategory.Classes && type === SearchItemType.Class) ||
                (this.activeFilter === FilterCategory.Files && type === SearchItemType.File) ||
                (this.activeFilter === FilterCategory.Symbols && type === SearchItemType.Symbol) ||
                (this.activeFilter === FilterCategory.Actions && type === SearchItemType.Command) ||
                (this.activeFilter === FilterCategory.Text && type === SearchItemType.TextMatch);

            const headerPrefix = isActiveFilterSection ? '▶ ' : '';

            // Add section header with enhanced visual distinction for active filter
            groupedItems.push({
                label: `${headerPrefix}${typeName} (${typeItems.length})`,
                kind: vscode.QuickPickItemKind.Separator,
                type: type
            });

            // Add items
            groupedItems.push(...typeItems);
        }

        return groupedItems;
    }

    /**
     * Get a user-friendly name for a search item type
     */
    private getTypeName(type: SearchItemType): string {
        switch (type) {
            case SearchItemType.File:
                return 'Files';

            case SearchItemType.Symbol:
                return 'Symbols';

            case SearchItemType.Class:
                return 'Classes';

            case SearchItemType.Command:
                return 'Actions';

            case SearchItemType.TextMatch:
                return 'Text Matches';

            default:
                return 'Items';
        }
    }
}

/**
 * Extended QuickPickItem with search-specific properties
 */
interface SearchQuickPickItem extends vscode.QuickPickItem {
    originalItem?: SearchItem;
    type: SearchItemType;
}
