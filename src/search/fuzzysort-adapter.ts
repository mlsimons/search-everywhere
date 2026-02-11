import { FuzzySearcher, FuzzySearchOptions, SearchItem } from '../core/types';
import Logger from '../utils/logging';
// @ts-ignore - Import with require to avoid TypeScript issues
const fuzzysort = require('fuzzysort');

/**
 * Adapter for the fuzzysort library
 */
export class FuzzysortAdapter implements FuzzySearcher {
    public readonly name = 'fuzzysort';

    /**
     * Search items using fuzzysort
     */
    public async search(items: SearchItem[], query: string, limit?: number, options?: FuzzySearchOptions): Promise<SearchItem[]> {
        // When limit is not provided, return all matches (display limit is applied in UI only)
        const effectiveLimit = limit ?? Number.MAX_SAFE_INTEGER;

        if (!query.trim()) {
            return items.slice(0, effectiveLimit);
        }

        const startTime = performance.now();

        // We'll create a simpler version that works with any objects
        const targets = items.map(item => {
            // Create concatenated search text
            const searchText = `${item.label} ${item.description || ''} ${item.detail || ''}`;

            return {
                searchText,
                originalItem: item
            };
        });

        const goLimit = effectiveLimit === Number.MAX_SAFE_INTEGER ? undefined : effectiveLimit * 2;

        // @ts-ignore - We're using the library in a way that TypeScript can't validate
        const results = fuzzysort.go(query, targets, {
            key: 'searchText',
            ...(goLimit !== undefined && { limit: goLimit })
        });

        // Map results back to items
        const foundItems = results.map((result: any) => {
            const item = result.obj.originalItem;
            const normalizedScore = Math.max(0, 1000 + result.score) / 1000;

            item.score = normalizedScore;

            return item;
        });

        const endTime = performance.now();

        Logger.log(`Fuzzysort search took ${endTime - startTime}ms for ${items.length} items`);

        return foundItems.slice(0, effectiveLimit);
    }
}
