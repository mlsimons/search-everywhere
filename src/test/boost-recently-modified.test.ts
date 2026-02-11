import * as assert from 'assert';
import * as vscode from 'vscode';
import { SearchService } from '../core/search-service';
import type { SearchItem, SymbolSearchItem } from '../core/types';
import { SearchItemType } from '../core/types';

const LABELS = [
    'foo', 'bar', 'baz', 'qux', 'doSomething', 'handleClick', 'Component', 'utils',
    'getUser', 'fetchData', 'parseConfig', 'render', 'validate', 'submit', 'cancel',
    'MyClass', 'Helper', 'Service', 'Repository', 'Controller', 'ViewModel', 'Widget',
];
const ID_PREFIX = 'sym-';

function createRandomSearchItem(index: number): SymbolSearchItem {
    const label = LABELS[index % LABELS.length] + String(index);
    const uri = vscode.Uri.file(`/project/src/file${index % 20}.ts`);
    const range = new vscode.Range(0, 0, 1, 0);
    return {
        id: `${ID_PREFIX}${index}`,
        label,
        description: '',
        detail: uri.fsPath,
        type: SearchItemType.Symbol,
        action: async () => {},
        score: 50 + Math.random() * 50,
        priority: 50,
        uri,
        range,
        symbolKind: vscode.SymbolKind.Method,
    };
}

function createRandomSearchItems(count: number): SearchItem[] {
    const items: SearchItem[] = [];
    for (let i = 0; i < count; i++) {
        items.push(createRandomSearchItem(i));
    }
    return items;
}

function createMockExtensionContext(): vscode.ExtensionContext {
    return {
        subscriptions: [],
        workspaceState: {} as vscode.Memento,
        globalState: {} as vscode.Memento,
        extensionUri: vscode.Uri.file('/mock'),
        extensionPath: '/mock',
        globalStorageUri: vscode.Uri.file('/mock-global'),
        storageUri: vscode.Uri.file('/mock-storage'),
        logPath: '/mock-log',
        extension: {} as vscode.Extension<unknown>,
        environmentVariableCollection: {} as vscode.GlobalEnvironmentVariableCollection,
        asAbsolutePath: (p: string) => p,
        storagePath: '/mock-storage',
        globalStoragePath: '/mock-global',
        logUri: vscode.Uri.file('/mock-log'),
        extensionMode: vscode.ExtensionMode.Test,
        secrets: {} as vscode.SecretStorage,
    } as unknown as vscode.ExtensionContext;
}

suite('boostRecentlyModifiedItems', () => {
    test('boosts two randomly chosen items when activityScore is set', () => {
        const items = createRandomSearchItems(200);
        const indices = new Set<number>();
        while (indices.size < 2) {
            indices.add(Math.floor(Math.random() * 200));
        }
        const [idxA, idxB] = Array.from(indices);

        const itemA = items[idxA];
        const itemB = items[idxB];
        const originalScoreA = itemA.score ?? 0;
        const originalScoreB = itemB.score ?? 0;

        // Valid activityScore: timestamp (e.g. now or recent past so recencyScore > 0)
        const now = Date.now();
        const fiveMinutesAgo = now - 5 * 60 * 1000;
        itemA.activityScore = fiveMinutesAgo;
        itemB.activityScore = now - 2 * 60 * 1000; // 2 minutes ago

        const mockContext = createMockExtensionContext();
        const service = new SearchService(mockContext);

        (service as unknown as { boostRecentlyModifiedItems(items: SearchItem[]): void })
            .boostRecentlyModifiedItems(items);

        assert.ok(
            typeof itemA.score === 'number' && itemA.score > originalScoreA,
            `Item at index ${idxA} should have boosted score (was ${originalScoreA}, got ${itemA.score})`
        );
        assert.ok(
            typeof itemB.score === 'number' && itemB.score > originalScoreB,
            `Item at index ${idxB} should have boosted score (was ${originalScoreB}, got ${itemB.score})`
        );
    });
});
