import * as nodePath from 'node:path';
import type { FileSystemAdapter } from './file-system.js';

/**
 * Settings of `netsuite-api generate`, read from netsuite-api.config.json at the project root. Every
 * path is relative to the config file; the defaults match the layout create-netsuite-project scaffolds.
 */
export interface ClientGeneratorConfig {
    /** Directory holding the controllers: one `<name>Controller.ts` per script. */
    controllers: string;
    /** The client's generated directory: one `<name>.gen.ts` per controller (its wire shapes, its endpoint type, its client) and `index.gen.ts` re-exporting each under the controller's name. Nothing else lives there. */
    outDir: string;
    /** The generated server-side `scripts` map: what a repository passes to createSuiteletClient. */
    scriptsOutFile: string;
    /** The specifier the controller modules import `createApiClient` from. */
    clientModule: string;
    /** The specifier the scripts map imports `ScriptRef` from. */
    wireModule: string;
    /**
     * Type imports a controller may carry into its generated module as imports, as the specifier
     * written in the controller mapped to the specifier the client resolves: the package's server
     * entry mapped to its client entry (for `RawResponse`). A type imported from any module listed
     * in neither this nor `inlineTypes` is an error, because the client could not resolve it.
     */
    typeImports: Record<string, string>;
    /**
     * Files whose type declarations are copied into the generated module of every controller that
     * imports types from them, as the specifier written in the controller mapped to the file: the
     * generated entity types, and the services (a key with one `*` stands for a file name:
     * `../services/*` mapped to `api/src/services/*.ts`). A controller module carries the types it
     * names and what those refer to, following an import from one listed file into another, so the
     * client needs no copy of any of them. Only the type declarations of a file are read; a service's
     * functions are not.
     */
    inlineTypes: Record<string, string>;
}

export interface ResolvedClientGeneratorConfig extends ClientGeneratorConfig {
    /** The config file's directory, or the working directory when no config file exists and the defaults apply. */
    rootDirectory: string;
}

export const DEFAULT_CONFIG_FILE_NAME = 'netsuite-api.config.json';

export const defaultClientGeneratorConfig: ClientGeneratorConfig = {
    controllers: 'api/src/controllers',
    outDir: 'client/src/api',
    scriptsOutFile: 'api/src/scripts.gen.ts',
    clientModule: '@amerilux/netsuite-api/client',
    wireModule: '@amerilux/netsuite-api',
    typeImports: { '@amerilux/netsuite-api/server': '@amerilux/netsuite-api/client' },
    inlineTypes: { '../types/models.gen': 'api/src/types/models.gen.ts', '../services/*': 'api/src/services/*.ts' },
};

const wildcardInlineTypesKeyPattern = /^([^*]*)\*([^*]*)$/;
const wildcardSegmentPattern = /^[A-Za-z0-9_-]+$/;

/**
 * The file an inlineTypes entry names for a specifier: the exact key, or a key with one `*` standing
 * for a single path segment, substituted into the value. Undefined when no entry matches.
 */
export function resolveInlineTypesFile(inlineTypes: Record<string, string>, specifier: string): string | undefined {
    const exact = inlineTypes[specifier];
    if (exact !== undefined) return exact;
    for (const [key, filePattern] of Object.entries(inlineTypes)) {
        const wildcard = wildcardInlineTypesKeyPattern.exec(key);
        if (!wildcard) continue;
        const [, prefix, suffix] = wildcard;
        if (specifier.length <= prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
        const segment = specifier.slice(prefix.length, specifier.length - suffix.length);
        if (wildcardSegmentPattern.test(segment)) return filePattern.replace('*', segment);
    }
    return undefined;
}

export class ClientGeneratorConfigError extends Error {
    constructor(readonly configPath: string, readonly problems: string[]) {
        super(`Config '${configPath}' is invalid:\n - ${problems.join('\n - ')}`);
        this.name = 'ClientGeneratorConfigError';
    }
}

const stringSettings = ['controllers', 'outDir', 'scriptsOutFile', 'clientModule', 'wireModule'] as const;
const mapSettings = ['typeImports', 'inlineTypes'] as const;

function isStringMap(value: unknown): value is Record<string, string> {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string' && entry !== '');
}

function validateClientGeneratorConfig(raw: Record<string, unknown>, configPath: string): ClientGeneratorConfig {
    const problems: string[] = [];
    const config: ClientGeneratorConfig = { ...defaultClientGeneratorConfig, typeImports: { ...defaultClientGeneratorConfig.typeImports }, inlineTypes: { ...defaultClientGeneratorConfig.inlineTypes } };

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
    for (const [key, filePattern] of Object.entries(config.inlineTypes)) {
        const stars = (key.match(/\*/g) ?? []).length;
        if (stars > 1) problems.push(`'inlineTypes' key '${key}' has more than one '*'; one stands for the file name.`);
        else if (stars === 1 && !filePattern.includes('*')) problems.push(`'inlineTypes' key '${key}' has a '*' but its file '${filePattern}' has none to put the name in.`);
        else if (stars === 0 && filePattern.includes('*')) problems.push(`'inlineTypes' file '${filePattern}' has a '*' but its key '${key}' has none to take the name from.`);
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
