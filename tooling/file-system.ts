import * as nodeFileSystem from 'node:fs';
import * as nodePath from 'node:path';

/** The file system surface the generator uses, so tests run fully in memory. */
export interface FileSystemAdapter {
    readTextFile(filePath: string): string;
    writeTextFile(filePath: string, content: string): void;
    fileExists(filePath: string): boolean;
    ensureDirectory(directoryPath: string): void;
    /** Lists the absolute paths of the files directly inside a directory. Returns [] when it does not exist. */
    listFiles(directoryPath: string): string[];
}

export function toPosixPath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

export function createNodeFileSystemAdapter(): FileSystemAdapter {
    return {
        readTextFile: (filePath) => nodeFileSystem.readFileSync(filePath, 'utf8'),
        writeTextFile: (filePath, content) => nodeFileSystem.writeFileSync(filePath, content, 'utf8'),
        fileExists: (filePath) => nodeFileSystem.existsSync(filePath),
        ensureDirectory: (directoryPath) => nodeFileSystem.mkdirSync(directoryPath, { recursive: true }),
        listFiles: (directoryPath) => {
            if (!nodeFileSystem.existsSync(directoryPath) || !nodeFileSystem.statSync(directoryPath).isDirectory()) return [];
            return nodeFileSystem
                .readdirSync(directoryPath, { withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) => nodePath.join(directoryPath, entry.name))
                .sort();
        },
    };
}

export interface InMemoryFileSystemAdapter extends FileSystemAdapter {
    readonly files: Map<string, string>;
}

function normalizeKey(filePath: string): string {
    return toPosixPath(nodePath.resolve(filePath));
}

export function createInMemoryFileSystemAdapter(initialFiles: Record<string, string> = {}): InMemoryFileSystemAdapter {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    for (const [filePath, content] of Object.entries(initialFiles)) files.set(normalizeKey(filePath), content);

    return {
        files,
        readTextFile: (filePath) => {
            const content = files.get(normalizeKey(filePath));
            if (content === undefined) throw new Error(`File not found: ${filePath}`);
            return content;
        },
        writeTextFile: (filePath, content) => {
            files.set(normalizeKey(filePath), content);
        },
        fileExists: (filePath) => files.has(normalizeKey(filePath)) || directories.has(normalizeKey(filePath)),
        ensureDirectory: (directoryPath) => {
            directories.add(normalizeKey(directoryPath));
        },
        listFiles: (directoryPath) => {
            const prefix = `${normalizeKey(directoryPath)}/`;
            return Array.from(files.keys())
                .filter((filePath) => filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes('/'))
                .sort();
        },
    };
}
