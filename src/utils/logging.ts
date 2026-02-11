import * as vscode from 'vscode';

/** Output channel name; select this in View > Output dropdown to see extension logs */
const OUTPUT_CHANNEL_NAME = 'Search Everywhere';

class Logger {
    private static outputChannel: vscode.OutputChannel;

    public static initialize() {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
            this.outputChannel.show();
        }
    }

    public static log(message: string) {
        try {
            this.ensureInitialized();
            const timestamp = new Date().toISOString();
            this.outputChannel.appendLine(`[${timestamp}] ${message}`);
        } catch (e) {
            console.log(`[Search Everywhere] ${message}`, e);
        }
    }

    public static debug(message: string) {
        const config = vscode.workspace.getConfiguration('searchEverywhere');

        if (config.get<boolean>('debug', false)) {
            this.log(`[DEBUG] ${message}`);
        }
    }

    private static ensureInitialized() {
        if (!this.outputChannel) {
            this.initialize();
        }
    }

    public static show() {
        try {
            this.ensureInitialized();
            this.outputChannel.show();
        } catch (e) {
            console.log('[Search Everywhere] Logger.show failed', e);
        }
    }
}

export default Logger;
