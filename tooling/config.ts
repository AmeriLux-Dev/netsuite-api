import * as nodePath from 'node:path';
import type { FileSystemAdapter } from './file-system.js';

/** Settings of `netsuite-api generate`, read from netsuite-api.config.json in the client workspace. */
export interface ClientGeneratorConfig {
    /** Directory (relative to the config file) holding the controllers: one `<name>Controller.ts` per script. */
    controllers: string;
    /** The file (relative to the config file) declaring `export const scripts = { ... }`. */
    scriptsFile: string;
    /** The specifier the generated module imports `scripts` from, as the client resolves it. */
    scriptsModule: string;
    /** The generated client module (relative to the config file). */
    outFile: string;
    /** The specifier the generated module imports `createApiClient` from. */
    clientModule: string;
    /**
     * Module specifier prefixes whose type imports a controller may carry into the generated module verbatim:
     * the generated entity types, typically. A type imported from anywhere else is an error, because the
     * client could not resolve it.
     */
    carriedTypeImports: string[];
}

export interface ResolvedClientGeneratorConfig extends ClientGeneratorConfig {
    /** The config file's directory, or the working directory when no config file exists and the defaults apply. */
    rootDirectory: string;
}

export const DEFAULT_CONFIG_FILE_NAME = 'netsuite-api.config.json';

export const defaultClientGeneratorConfig: ClientGeneratorConfig = {
    controllers: '../api/src/controllers',
    scriptsFile: '../common/netsuite.ts',
    scriptsModule: 'common/netsuite',
    outFile: 'src/api/index.gen.ts',
    clientModule: '@amerilux/netsuite-api/client',
    carriedTypeImports: ['common/'],
};

export class ClientGeneratorConfigError extends Error {
    constructor(readonly configPath: string, readonly problems: string[]) {
        super(`Config '${configPath}' is invalid:\n - ${problems.join('\n - ')}`);
        this.name = 'ClientGeneratorConfigError';
    }
}

const stringSettings = ['controllers', 'scriptsFile', 'scriptsModule', 'outFile', 'clientModule'] as const;

function validateClientGeneratorConfig(raw: Record<string, unknown>, configPath: string): ClientGeneratorConfig {
    const problems: string[] = [];
    const config: ClientGeneratorConfig = { ...defaultClientGeneratorConfig, carriedTypeImports: [...defaultClientGeneratorConfig.carriedTypeImports] };

    for (const setting of stringSettings) {
        const value = raw[setting];
        if (value === undefined) continue;
        if (typeof value === 'string' && value.trim() !== '') config[setting] = value;
        else problems.push(`'${setting}' must be a non-empty string.`);
    }
    if (raw.carriedTypeImports !== undefined) {
        if (Array.isArray(raw.carriedTypeImports) && raw.carriedTypeImports.every((entry) => typeof entry === 'string' && entry !== '')) {
            config.carriedTypeImports = raw.carriedTypeImports as string[];
        } else {
            problems.push("'carriedTypeImports' must be an array of module specifier prefixes.");
        }
    }
    const known = new Set<string>([...stringSettings, 'carriedTypeImports']);
    for (const key of Object.keys(raw)) {
        if (!known.has(key)) problems.push(`'${key}' is not a setting.`);
    }
    if (problems.length > 0) throw new ClientGeneratorConfigError(configPath, problems);
    return config;
}

/** Loads the config next to the working directory (or the one named), applying the defaults for what it omits. */
export function loadClientGeneratorConfig(fileSystem: FileSystemAdapter, cwd: string, configPath?: string): ResolvedClientGeneratorConfig {
    const resolvedConfigPath = nodePath.resolve(cwd, configPath ?? DEFAULT_CONFIG_FILE_NAME);
    if (!fileSystem.fileExists(resolvedConfigPath)) {
        if (configPath !== undefined) throw new ClientGeneratorConfigError(resolvedConfigPath, ['the file does not exist.']);
        return { ...defaultClientGeneratorConfig, rootDirectory: cwd };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(fileSystem.readTextFile(resolvedConfigPath));
    } catch (error) {
        throw new ClientGeneratorConfigError(resolvedConfigPath, [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ClientGeneratorConfigError(resolvedConfigPath, ['must be a JSON object.']);
    return { ...validateClientGeneratorConfig(raw as Record<string, unknown>, resolvedConfigPath), rootDirectory: nodePath.dirname(resolvedConfigPath) };
}
