import * as nodePath from 'node:path';
import type { FileSystemAdapter } from './file-system.js';

/**
 * Settings of `netsuite-api generate`, read from netsuite-api.config.json at the project root. Every
 * path is relative to the config file; the defaults match the layout create-netsuite-project scaffolds.
 */
/** A field of the run record, by the name the package's code uses for it. */
export type JobRunFieldName =
    | 'job'
    | 'status'
    | 'stage'
    | 'percentComplete'
    | 'input'
    | 'result'
    | 'errors'
    | 'taskId'
    | 'deployment'
    | 'startedBy'
    | 'startedAt'
    | 'finishedAt';

/**
 * What each run field's id ends in, under the configured prefix: `custrecord_<prefix>_jr` plus
 * `_status` is the status field. Short on purpose, because NetSuite caps a field id at 40 characters.
 */
export const JOB_RUN_FIELD_SUFFIXES: Record<JobRunFieldName, string> = {
    job: '_job',
    status: '_status',
    stage: '_stage',
    percentComplete: '_percent',
    input: '_input',
    result: '_result',
    errors: '_errors',
    taskId: '_task',
    deployment: '_deploy',
    startedBy: '_by',
    startedAt: '_start',
    finishedAt: '_end',
};

export const netsuiteValueTypeNames = ['text', 'integer', 'decimal', 'checkbox', 'date', 'select'] as const;
export type NetsuiteValueTypeName = (typeof netsuiteValueTypeNames)[number];

/**
 * The run record as this application deployed it. The shape is the package's and the ids are the
 * application's: `npm run add:jobs` writes the record with the application's prefix and puts the same
 * ids here, and the generator copies them into the scripts map for the jobs and the run store to read.
 */
export interface JobRunsSettings {
    /** The record type's id: `customrecord_<prefix>_job_run`. */
    recordType: string;
    /** What every field id starts with: `custrecord_<prefix>_jr`. */
    fieldPrefix: string;
    /** The id of a single field whose name in the account differs from prefix plus suffix. */
    fields?: Partial<Record<JobRunFieldName, string>>;
    /** Fields this application added to the record, by the name its code uses: what startJob may set and a run reports back. */
    extraFields?: Record<string, { id: string; type: NetsuiteValueTypeName }>;
}

export interface ClientGeneratorConfig {
    /** Directory holding the controllers: one `<name>Controller.ts` per script. */
    controllers: string;
    /** Directory holding the jobs: one `<name>.ts` per Map/Reduce script. A project with no such directory has no jobs. */
    jobs: string;
    /** The run record the jobs' runs live in. Left out until the project has jobs (`npm run add:jobs` adds it). */
    jobRuns?: JobRunsSettings;
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
    jobs: 'api/src/jobs',
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

const stringSettings = ['controllers', 'jobs', 'outDir', 'scriptsOutFile', 'clientModule', 'wireModule'] as const;
const mapSettings = ['typeImports', 'inlineTypes'] as const;

function isStringMap(value: unknown): value is Record<string, string> {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string' && entry !== '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The run record block: the record's own ids, and the fields the application added to it. */
function validateJobRunsSettings(raw: unknown, problems: string[]): JobRunsSettings | undefined {
    if (!isPlainObject(raw)) {
        problems.push("'jobRuns' must be an object with 'recordType' and 'fieldPrefix'.");
        return undefined;
    }
    const recordType = raw.recordType;
    const fieldPrefix = raw.fieldPrefix;
    if (typeof recordType !== 'string' || recordType.trim() === '') problems.push("'jobRuns.recordType' must be the run record's id, such as 'customrecord_app_job_run'.");
    if (typeof fieldPrefix !== 'string' || fieldPrefix.trim() === '') problems.push("'jobRuns.fieldPrefix' must be what the run record's field ids start with, such as 'custrecord_app_jr'.");
    const settings: JobRunsSettings = { recordType: String(recordType ?? ''), fieldPrefix: String(fieldPrefix ?? '') };

    if (raw.fields !== undefined) {
        if (!isStringMap(raw.fields)) problems.push("'jobRuns.fields' must be an object of strings: the fields whose ids differ from the prefix plus the usual suffix.");
        else {
            for (const name of Object.keys(raw.fields)) {
                if (!(name in JOB_RUN_FIELD_SUFFIXES)) problems.push(`'jobRuns.fields.${name}' is not a run field; the fields are ${Object.keys(JOB_RUN_FIELD_SUFFIXES).join(', ')}.`);
            }
            settings.fields = raw.fields as JobRunsSettings['fields'];
        }
    }
    if (raw.extraFields !== undefined) {
        if (!isPlainObject(raw.extraFields)) problems.push("'jobRuns.extraFields' must be an object of { id, type } by field name.");
        else {
            const extraFields: Record<string, { id: string; type: NetsuiteValueTypeName }> = {};
            for (const [name, field] of Object.entries(raw.extraFields)) {
                if (!isPlainObject(field) || typeof field.id !== 'string' || field.id === '') {
                    problems.push(`'jobRuns.extraFields.${name}' needs 'id', the field's id in NetSuite.`);
                    continue;
                }
                if (typeof field.type !== 'string' || !netsuiteValueTypeNames.includes(field.type as NetsuiteValueTypeName)) {
                    problems.push(`'jobRuns.extraFields.${name}.type' must be one of ${netsuiteValueTypeNames.map((value) => `'${value}'`).join(', ')}.`);
                    continue;
                }
                extraFields[name] = { id: field.id, type: field.type as NetsuiteValueTypeName };
            }
            settings.extraFields = extraFields;
        }
    }
    for (const key of Object.keys(raw)) {
        if (!['recordType', 'fieldPrefix', 'fields', 'extraFields'].includes(key)) problems.push(`'jobRuns.${key}' is not a setting.`);
    }
    return settings;
}

/** Every run field's id: the prefix plus its suffix, or the override the config gives it. */
export function resolveJobRunFieldIds(settings: JobRunsSettings): Record<JobRunFieldName, string> {
    const ids = {} as Record<JobRunFieldName, string>;
    for (const [name, suffix] of Object.entries(JOB_RUN_FIELD_SUFFIXES) as [JobRunFieldName, string][]) {
        ids[name] = settings.fields?.[name] ?? `${settings.fieldPrefix}${suffix}`;
    }
    return ids;
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
    if (raw.jobRuns !== undefined) config.jobRuns = validateJobRunsSettings(raw.jobRuns, problems);
    const known = new Set<string>([...stringSettings, ...mapSettings, 'jobRuns']);
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
