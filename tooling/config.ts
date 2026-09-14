import * as nodePath from 'node:path';
import type { FileSystemAdapter } from './file-system.js';

/**
 * Settings of `netsuite-api generate`, read from netsuite-api.config.json at the project root. Every
 * path is relative to the config file; the defaults match the layout create-netsuite-project scaffolds.
 */
export interface ClientGeneratorConfig {
    /** Directory holding the controllers: one `<name>Controller.ts` per script. */
    controllers: string;
    /** The file declaring `app` (and any other id no controller or model owns), copied into the client module verbatim. */
    appFile: string;
    /** The generated client module: every wire shape, every endpoint type, one client per browser-facing controller. */
    outFile: string;
    /** The generated copy of the app file for the client, outside the api folder so pages and components may import it. */
    appOutFile: string;
    /** The generated server-side `scripts` map: what a repository passes to createSuiteletClient. */
    scriptsOutFile: string;
    /** The specifier the client module imports `createApiClient` from. */
    clientModule: string;
    /** The specifier the scripts map imports `ScriptRef` from. */
    wireModule: string;
    /**
     * Type imports a controller may carry into the client module, as the specifier written in the
     * controller mapped to the specifier the client resolves: the generated entity types, typically. A
     * type imported from any other module is an error, because the client could not resolve it.
     */
    typeImports: Record<string, string>;
    /** Files copied into the client as they are, source to destination: the generated entity types the carried imports point at. */
    copyFiles: Record<string, string>;
}

export interface ResolvedClientGeneratorConfig extends ClientGeneratorConfig {
    /** The config file's directory, or the working directory when no config file exists and the defaults apply. */
    rootDirectory: string;
}

export const DEFAULT_CONFIG_FILE_NAME = 'netsuite-api.config.json';

export const defaultClientGeneratorConfig: ClientGeneratorConfig = {
    controllers: 'api/src/controllers',
    appFile: 'netsuite.ts',
    outFile: 'client/src/api/index.gen.ts',
    appOutFile: 'client/src/app.gen.ts',
    scriptsOutFile: 'api/src/scripts.gen.ts',
    clientModule: '@amerilux/netsuite-api/client',
    wireModule: '@amerilux/netsuite-api',
    typeImports: { '../types/models.gen': './models.gen' },
    copyFiles: { 'api/src/types/models.gen.ts': 'client/src/api/models.gen.ts' },
};

export class ClientGeneratorConfigError extends Error {
    constructor(readonly configPath: string, readonly problems: string[]) {
        super(`Config '${configPath}' is invalid:\n - ${problems.join('\n - ')}`);
        this.name = 'ClientGeneratorConfigError';
    }
}

const stringSettings = ['controllers', 'appFile', 'outFile', 'appOutFile', 'scriptsOutFile', 'clientModule', 'wireModule'] as const;
const mapSettings = ['typeImports', 'copyFiles'] as const;

function isStringMap(value: unknown): value is Record<string, string> {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string' && entry !== '');
}

function validateClientGeneratorConfig(raw: Record<string, unknown>, configPath: string): ClientGeneratorConfig {
    const problems: string[] = [];
    const config: ClientGeneratorConfig = { ...defaultClientGeneratorConfig, typeImports: { ...defaultClientGeneratorConfig.typeImports }, copyFiles: { ...defaultClientGeneratorConfig.copyFiles } };

    for (const setting of stringSettings) {
        const value = raw[setting];
        if (value === undefined) continue;
        if (typeof value === 'string' && value.trim() !== '') config[setting] = value;
        else problems.push(`'${setting}' must be a non-empty string.`);
    }
    for (const setting of mapSettings) {
        const value = raw[setting];
        if (value === undefined) continue;
        if (isStringMap(value)) config[setting] = value;
        else problems.push(`'${setting}' must be an object of strings.`);
    }
    const known = new Set<string>([...stringSettings, ...mapSettings]);
    for (const key of Object.keys(raw)) {
        if (!known.has(key)) problems.push(`'${key}' is not a setting.`);
    }
    if (problems.length > 0) throw new ClientGeneratorConfigError(configPath, problems);
    return config;
}

/** Loads the config in the working directory (or the one named), applying the defaults for what it omits. */
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
