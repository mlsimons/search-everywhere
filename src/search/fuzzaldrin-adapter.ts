import { FuzzySearcher, FuzzySearchOptions, SearchItem } from '../core/types';
import Logger from '../utils/logging';
// @ts-ignore - Import with require to avoid TypeScript issues
const fuzzaldrinPlus = require('fuzzaldrin-plus');

/**
 * Adapter for the fuzzaldrin-plus library
 */
export class FuzzaldrinAdapter implements FuzzySearcher {
    public readonly name = 'fuzzaldrin-plus';

    /**
     * Search items using fuzzaldrin-plus
     */
    public async search(items: SearchItem[], query: string, limit?: number, options?: FuzzySearchOptions): Promise<SearchItem[]> {
        // When limit is not provided, return all matches (display limit is applied in UI only)
        const effectiveLimit = limit ?? Number.MAX_SAFE_INTEGER;

        if (!query.trim()) {
            return items.slice(0, effectiveLimit);
        }

        const startTime = performance.now();

        // Create searchable objects
        const searchableItems = items.map(item => ({
            originalItem: item,
            searchText: `${item.label} ${item.description || ''} ${item.detail || ''}`,
        }));

        const filterOptions: { key: string; maxResults?: number } = { key: 'searchText' };
        if (effectiveLimit !== Number.MAX_SAFE_INTEGER) {
            filterOptions.maxResults = effectiveLimit * 2;
        }

        // Perform the search
        // @ts-ignore - Cast to any to avoid TypeScript issues
        const results = fuzzaldrinPlus.filter(searchableItems, query, filterOptions);

        // Map results back to items and calculate scores
        const foundItems = results.map((result: any) => {
            const item = result.originalItem;
            // @ts-ignore - Cast to any to avoid TypeScript issues
            const score = fuzzaldrinPlus.score(result.searchText, query) / 100;

            item.score = score;

            return item;
        });

        const endTime = performance.now();

        Logger.log(`Fuzzaldrin search took ${endTime - startTime}ms for ${items.length} items`);

        return foundItems.slice(0, effectiveLimit);
    }
}
