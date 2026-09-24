import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultClientGeneratorConfig, loadClientGeneratorConfig } from '../../tooling/config.js';
import { createInMemoryFileSystemAdapter } from '../../tooling/file-system.js';
import { checkClientGeneration, planClientGeneration, runClientGeneration } from '../../tooling/generate.js';
import { runCli } from '../../tooling/cli/main.js';
import {
    expectedIndexModule,
    expectedScriptsModule,
    expectedUserModule,
    expectedUserRolesModule,
    modelsSource,
    userControllerSource,
    userRolesControllerSource,
    userRolesServiceSource,
} from './fixtures.js';

const projectRoot = nodePath.resolve('/project');
const clientDirectory = nodePath.join(projectRoot, 'client', 'src', 'api');
const userModuleFile = nodePath.join(clientDirectory, 'user.gen.ts');
const userRolesModuleFile = nodePath.join(clientDirectory, 'userRoles.gen.ts');
const indexModuleFile = nodePath.join(clientDirectory, 'index.gen.ts');
const scriptsModuleFile = nodePath.join(projectRoot, 'api', 'src', 'scripts.gen.ts');
const modelsFile = nodePath.join(projectRoot, 'api', 'src', 'types', 'models.gen.ts');
const controllersDirectory = nodePath.join(projectRoot, 'api', 'src', 'controllers');
const servicesDirectory = nodePath.join(projectRoot, 'api', 'src', 'services');
const allGeneratedFiles = [userModuleFile, userRolesModuleFile, indexModuleFile, scriptsModuleFile];

function projectFiles(overrides: Record<string, string | undefined> = {}) {
    const files: Record<string, string | undefined> = {
        [modelsFile]: modelsSource,
        [nodePath.join(servicesDirectory, 'userRolesService.ts')]: userRolesServiceSource,
        [nodePath.join(controllersDirectory, 'userController.ts')]: userControllerSource,
        [nodePath.join(controllersDirectory, 'userRolesController.ts')]: userRolesControllerSource,
        [nodePath.join(controllersDirectory, 'notes.md')]: 'not a controller',
        ...overrides,
    };
    return createInMemoryFileSystemAdapter(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined)));
}

function optionsFor(fileSystem: ReturnType<typeof projectFiles>) {
    return { config: { ...defaultClientGeneratorConfig, rootDirectory: projectRoot }, fileSystem };
}

/** A minimal Restlet controller with the given body, at api/src/controllers/<name>Controller.ts. */
function restletController(name: string, body: string): string {
    return `/**
 * @NScriptType Restlet
 */
import { defineEndpoints, defineRestlet } from '@amerilux/netsuite-api/server';
${body}
export const post = defineRestlet({ name: '${name}', scriptId: 'customscript_demo_${name}', deployId: 'customdeploy_demo_${name}' }, ${name}Endpoints);
`;
}

describe('planClientGeneration', () => {
    it('plans a module per controller, the client index and the scripts module', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));
        expect(plan.problems).toEqual([]);
        expect(plan.controllers).toEqual([
            { name: 'user', filePath: 'api/src/controllers/userController.ts', kind: 'restlet', browser: true, endpointCount: 1 },
            { name: 'userRoles', filePath: 'api/src/controllers/userRolesController.ts', kind: 'suitelet', browser: false, endpointCount: 1 },
        ]);
        expect(plan.files.map((file) => file.path)).toEqual(allGeneratedFiles);
        expect(plan.files[0].content).toBe(expectedUserModule);
        expect(plan.files[1].content).toBe(expectedUserRolesModule);
        expect(plan.files[2].content).toBe(expectedIndexModule);
        expect(plan.files[3].content).toBe(expectedScriptsModule);
        expect(plan.leftoverFiles).toEqual([]);
    });

    it('leaves out the client import when the controller does not face the browser', () => {
        const fileSystem = projectFiles({
            [nodePath.join(controllersDirectory, 'userController.ts')]: userControllerSource.replace("deployId: 'customdeploy_demo_user',", "deployId: 'customdeploy_demo_user',\n    browser: false,"),
        });
        const plan = planClientGeneration(optionsFor(fileSystem));
        expect(plan.problems).toEqual([]);
        expect(plan.files[0].content).not.toContain('@amerilux/netsuite-api/client');
        expect(plan.files[0].content).not.toContain('export const api');
        expect(plan.files[0].content).toContain('// Called by server code only: its types, and no client.');
        expect(plan.files[0].content).toContain('export interface RolesResponse {');
        expect(plan.files[2].content).toContain('/** The user controller: its request and response types only; server code calls it, the browser does not. */');
        expect(plan.files[3].content).toContain("user: { kind: 'restlet', scriptId: 'customscript_demo_user', deployId: 'customdeploy_demo_user', browser: false },");
    });

    it('calls a raw endpoint through callRawEndpoint, resolving to a Blob, and leaves RawResponse unimported', () => {
        const documentsController = `/**
 * @NScriptType Suitelet
 */
import type { RawResponse } from '@amerilux/netsuite-api/server';
import { defineEndpoints, defineSuitelet, rawResponse } from '@amerilux/netsuite-api/server';
export const documentsEndpoints = defineEndpoints({
    /** The month as a CSV download; its return type is written exactly \`RawResponse\`. */
    csv: (request: { month: string }): RawResponse => rawResponse({ contentType: 'text/csv', body: request.month }),
    months: (): string[] => [],
});
export type DocumentsEndpoints = typeof documentsEndpoints;
export const onRequest = defineSuitelet({ name: 'documents', scriptId: 'customscript_demo_documents', deployId: 'customdeploy_demo_documents' }, documentsEndpoints);
`;
        const plan = planClientGeneration(optionsFor(projectFiles({ [nodePath.join(controllersDirectory, 'documentsController.ts')]: documentsController })));
        expect(plan.problems).toEqual([]);
        const documentsModule = plan.files[0];
        expect(documentsModule.path).toBe(nodePath.join(clientDirectory, 'documents.gen.ts'));
        expect(documentsModule.content).toContain("import { callEndpoint, callRawEndpoint } from '@amerilux/netsuite-api/client';");
        expect(documentsModule.content).toContain("import type { ApiCallOptions, ScriptRef } from '@amerilux/netsuite-api/client';");
        // The JSDoc still names RawResponse; a mention in a comment is not a use, so the import is left out.
        expect(documentsModule.content).toContain('its return type is written exactly `RawResponse`');
        expect(documentsModule.content).not.toMatch(/import type {[^}]*RawResponse/);
        expect(documentsModule.content).toContain("const documentsScriptRef: ScriptRef = { kind: 'suitelet', scriptId: 'customscript_demo_documents', deployId: 'customdeploy_demo_documents' };");
        expect(documentsModule.content).toContain("    csv: (request: { month: string }, options?: ApiCallOptions): Promise<Blob> => callRawEndpoint(documentsScriptRef, 'csv', request, options),");
        expect(documentsModule.content).toContain("    months: (options?: ApiCallOptions): Promise<string[]> => callEndpoint<string[]>(documentsScriptRef, 'months', {}, options),");
    });

    it('passes an optional request through as it came, and a missing one as an empty body', () => {
        const searchController = restletController('search', `
export const searchEndpoints = defineEndpoints({
    /** Every match, or everything when there is no text. */
    find: (request?: { text: string }): string[] => [],
});`);
        const plan = planClientGeneration(optionsFor(projectFiles({ [nodePath.join(controllersDirectory, 'searchController.ts')]: searchController })));
        expect(plan.problems).toEqual([]);
        expect(plan.files[0].content).toContain(
            [
                '/** One function per endpoint of the search controller: `search.api.find(...)`. */',
                'export const api = {',
                '    /** Every match, or everything when there is no text. */',
                "    find: (request?: { text: string }, options?: ApiCallOptions): Promise<string[]> => callEndpoint<string[]>(searchScriptRef, 'find', request, options),",
                '};',
            ].join('\n'),
        );
    });

    it('copies the entity types a controller names, what they refer to, and an alias for a renamed import', () => {
        const employeeController = restletController('employee', `
import type { Employee as EmployeeRecord } from '../types/models.gen';
export const employeeEndpoints = defineEndpoints({ me: (): EmployeeRecord => ({} as EmployeeRecord) });`);
        const plan = planClientGeneration(optionsFor(projectFiles({ [nodePath.join(controllersDirectory, 'employeeController.ts')]: employeeController })));
        expect(plan.problems).toEqual([]);
        const employeeModule = plan.files[0].content;
        expect(employeeModule).toContain(
            [
                '// Types from api/src/types/models.gen.ts, copied so this module stands on its own.',
                '',
                'export interface Department {',
                '    id: number;',
                '    name: string;',
                '}',
                '',
                'export interface Employee {',
                '    id: number;',
                '    name: string;',
                '    department: Department;',
                '    supervisor?: Employee;',
                '}',
                '',
                'export type EmployeeRecord = Employee;',
                '',
                '/** The script the employee controller declares: every call below posts to it. */',
            ].join('\n'),
        );
        expect(employeeModule).toContain("    me: (options?: ApiCallOptions): Promise<EmployeeRecord> => callEndpoint<EmployeeRecord>(employeeScriptRef, 'me', {}, options),");
        expect(employeeModule).not.toContain('EmployeeRole');
        expect(employeeModule).not.toContain('EmployeeCreate');
    });

    it('reports a service that does not exist, and a service type built on something the client cannot carry', () => {
        const ordersController = restletController('orders', `
import type { OrderSummary } from '../services/orderService';
import type { Total } from '../services/totalsService';
export const ordersEndpoints = defineEndpoints({ list: (): OrderSummary[] => [], total: (): Total => 0 as Total });`);
        const totalsService = `
import type { Money } from '@amerilux/money';
export type Total = Money;
`;
        const plan = planClientGeneration(optionsFor(projectFiles({
            [nodePath.join(controllersDirectory, 'ordersController.ts')]: ordersController,
            [nodePath.join(servicesDirectory, 'totalsService.ts')]: totalsService,
        })));
        expect(plan.problems).toEqual([
            { filePath: 'api/src/services/orderService.ts', message: "the file to copy types from does not exist; '../services/orderService' names it." },
            {
                filePath: 'api/src/controllers/ordersController.ts',
                about: 'Total',
                message: "type 'Total' (api/src/services/totalsService.ts) is built on Money from '@amerilux/money', which the client cannot carry; write the wire shape out in the controller instead.",
            },
        ]);
        expect(plan.files).toEqual([]);
    });

    it('writes a Date in a response shape as string in the client module, and rejects a Date reached from a request shape', () => {
        const shiftsService = `
export interface ShiftWindow {
    from: Date;
    to: Date | null;
}
`;
        const shiftsController = restletController('shifts', `
import type { ShiftWindow } from '../services/shiftsService';
export interface Shift { id: number; startsAt: Date; window: ShiftWindow }
export const shiftsEndpoints = defineEndpoints({
    list: (): Shift[] => [],
    latest: (): Date | undefined => undefined,
});`);
        const plan = planClientGeneration(optionsFor(projectFiles({
            [nodePath.join(servicesDirectory, 'shiftsService.ts')]: shiftsService,
            [nodePath.join(controllersDirectory, 'shiftsController.ts')]: shiftsController,
        })));
        expect(plan.problems).toEqual([]);
        const shiftsModule = plan.files[0].content;
        expect(shiftsModule).toContain('export interface ShiftWindow {\n    from: string;\n    to: string | null;\n}');
        expect(shiftsModule).toContain('export interface Shift { id: number; startsAt: string; window: ShiftWindow }');
        expect(shiftsModule).toContain("    latest: (options?: ApiCallOptions): Promise<string | undefined> => callEndpoint<string | undefined>(shiftsScriptRef, 'latest', {}, options),");
        expect(shiftsModule).not.toContain('Date');

        const requestsController = restletController('shifts', `
import type { ShiftWindow } from '../services/shiftsService';
export interface WindowRequest { window: ShiftWindow }
export const shiftsEndpoints = defineEndpoints({
    within: (request: WindowRequest): number => 0,
    since: (request: { from: Date }): number => 0,
    byId: (request: { id: number }): number => 0,
});`);
        const rejected = planClientGeneration(optionsFor(projectFiles({
            [nodePath.join(servicesDirectory, 'shiftsService.ts')]: shiftsService,
            [nodePath.join(controllersDirectory, 'shiftsController.ts')]: requestsController,
        })));
        expect(rejected.problems).toEqual([
            { filePath: 'api/src/controllers/shiftsController.ts', message: "endpoint 'within' takes a Date in its request (through ShiftWindow); JSON carries dates as ISO 8601 strings, so take a string and parse it in the handler." },
            { filePath: 'api/src/controllers/shiftsController.ts', message: "endpoint 'since' takes a Date in its request (through { from: Date }); JSON carries dates as ISO 8601 strings, so take a string and parse it in the handler." },
        ]);
    });

    it('reports an entity type built on the repository package, one the models file lacks, and a sibling controller that does not exist', () => {
        const employeeController = restletController('employee', `
import type { EmployeeCreate, Missing } from '../types/models.gen';
import type { OrderSummary } from './ordersController';
export const employeeEndpoints = defineEndpoints({ create: (request: EmployeeCreate): Missing => ({} as Missing), orders: (): OrderSummary[] => [] });`);
        const plan = planClientGeneration(optionsFor(projectFiles({ [nodePath.join(controllersDirectory, 'employeeController.ts')]: employeeController })));
        expect(plan.problems).toEqual([
            { filePath: 'api/src/controllers/employeeController.ts', message: "imports types from './ordersController', which is not a controller in api/src/controllers." },
            { filePath: 'api/src/controllers/employeeController.ts', about: 'Missing', message: "type 'Missing' is not declared in api/src/types/models.gen.ts." },
            {
                filePath: 'api/src/controllers/employeeController.ts',
                about: 'EmployeeCreate',
                message: "type 'EmployeeCreate' (api/src/types/models.gen.ts) is built on EntityCreate from '@amerilux/netsuite-repository', which the client cannot carry; write the wire shape out in the controller instead.",
            },
        ]);
        expect(plan.files).toEqual([]);
    });

    it('plans an empty index and scripts map for a project with no controller yet', () => {
        const plan = planClientGeneration(optionsFor(projectFiles({
            [modelsFile]: undefined,
            [nodePath.join(controllersDirectory, 'userController.ts')]: undefined,
            [nodePath.join(controllersDirectory, 'userRolesController.ts')]: undefined,
        })));
        expect(plan.problems).toEqual([]);
        expect(plan.files.map((file) => file.path)).toEqual([indexModuleFile, scriptsModuleFile]);
        const indexModule = plan.files.find((file) => file.path === indexModuleFile)?.content ?? '';
        expect(indexModule.endsWith('export {};\n')).toBe(true);
        expect(indexModule.includes('export * as')).toBe(false);
        const scriptsModule = plan.files.find((file) => file.path === scriptsModuleFile)?.content ?? '';
        expect(scriptsModule.includes('export const scripts = {\n} as const satisfies Record<string, ScriptRef>;')).toBe(true);
    });

    it('reports a missing models file when a controller names it', () => {
        expect(planClientGeneration(optionsFor(projectFiles({ [modelsFile]: undefined }))).problems).toEqual([
            { filePath: 'api/src/types/models.gen.ts', message: 'the file to copy types from does not exist; run the model generator first.' },
        ]);
    });

    it('reports a script id two controllers both declare, a controller that would take the index, and a wire shape named after a type the client imports', () => {
        const plan = planClientGeneration(optionsFor(projectFiles({
            [nodePath.join(controllersDirectory, 'userController.ts')]: userControllerSource.replace("scriptId: 'customscript_demo_user'", "scriptId: 'customscript_demo_user_roles'"),
            [nodePath.join(controllersDirectory, 'indexController.ts')]: restletController('index', `
export interface ApiCallOptions { a: number }
export const indexEndpoints = defineEndpoints({ list: (): string[] => [] });`),
        })));
        expect(plan.problems).toEqual([
            { filePath: 'api/src/controllers/indexController.ts', message: "type 'ApiCallOptions' is a name the generated module imports for its client; call the wire shape something else." },
            { filePath: 'api/src/controllers/userRolesController.ts', message: "scriptId 'customscript_demo_user_roles' is also declared by api/src/controllers/userController.ts; every controller is its own script." },
        ]);
        const namedIndex = planClientGeneration(optionsFor(projectFiles({
            [nodePath.join(controllersDirectory, 'indexController.ts')]: restletController('index', 'export const indexEndpoints = defineEndpoints({ list: (): string[] => [] });'),
        })));
        expect(namedIndex.problems).toEqual([{ filePath: 'api/src/controllers/indexController.ts', message: "a controller named 'index' would take the client's index.gen.ts; name it something else." }]);
    });

    it('lists a generated file in the client directory that no controller owns', () => {
        const leftover = nodePath.join(clientDirectory, 'orders.gen.ts');
        const oldCopy = nodePath.join(clientDirectory, 'models.gen.ts');
        const plan = planClientGeneration(optionsFor(projectFiles({ [leftover]: '// old', [oldCopy]: modelsSource, [nodePath.join(clientDirectory, 'helpers.ts')]: '// not generated' })));
        expect(plan.problems).toEqual([]);
        expect(plan.leftoverFiles.map((filePath) => nodePath.basename(filePath))).toEqual(['models.gen.ts', 'orders.gen.ts']);
    });
});

describe('runClientGeneration and checkClientGeneration', () => {
    it('writes the files once and reports them current afterwards', () => {
        const fileSystem = projectFiles();
        const options = optionsFor(fileSystem);
        expect(checkClientGeneration(options).missingFiles).toEqual(allGeneratedFiles);
        const first = runClientGeneration(options);
        expect(first.writtenFiles).toEqual(allGeneratedFiles);
        expect(fileSystem.readTextFile(userModuleFile)).toBe(expectedUserModule);
        expect(fileSystem.readTextFile(userRolesModuleFile)).toBe(expectedUserRolesModule);
        expect(fileSystem.readTextFile(indexModuleFile)).toBe(expectedIndexModule);
        expect(fileSystem.readTextFile(scriptsModuleFile)).toBe(expectedScriptsModule);
        const second = runClientGeneration(options);
        expect(second.writtenFiles).toEqual([]);
        expect(second.unchangedFiles).toHaveLength(4);
        expect(checkClientGeneration(options)).toMatchObject({ missingFiles: [], staleFiles: [], leftoverFiles: [] });
        fileSystem.writeTextFile(scriptsModuleFile, '// edited by hand');
        expect(checkClientGeneration(options).staleFiles).toEqual([scriptsModuleFile]);
    });

    it('deletes the module of a removed controller and the old copy of the entity types', () => {
        const fileSystem = projectFiles();
        const options = optionsFor(fileSystem);
        runClientGeneration(options);
        const oldCopy = nodePath.join(clientDirectory, 'models.gen.ts');
        fileSystem.writeTextFile(oldCopy, modelsSource);
        fileSystem.deleteFile(nodePath.join(controllersDirectory, 'userRolesController.ts'));
        fileSystem.writeTextFile(nodePath.join(controllersDirectory, 'userController.ts'), userControllerSource.replace("import type { RoleSummary } from '../services/userRolesService';", 'export interface RoleSummary { roleId: number }'));
        expect(checkClientGeneration(options).leftoverFiles.map((filePath) => nodePath.basename(filePath))).toEqual(['models.gen.ts', 'userRoles.gen.ts']);
        const result = runClientGeneration(options);
        expect(result.deletedFiles.map((filePath) => nodePath.basename(filePath))).toEqual(['models.gen.ts', 'userRoles.gen.ts']);
        expect(fileSystem.fileExists(userRolesModuleFile)).toBe(false);
        expect(fileSystem.fileExists(oldCopy)).toBe(false);
        expect(checkClientGeneration(options)).toMatchObject({ missingFiles: [], staleFiles: [], leftoverFiles: [] });
    });

    it('writes nothing when there are problems', () => {
        const fileSystem = projectFiles({ [nodePath.join(controllersDirectory, 'brokenController.ts')]: 'export interface A { a: 1 }' });
        const result = runClientGeneration(optionsFor(fileSystem));
        expect(result.writtenFiles).toEqual([]);
        expect(fileSystem.fileExists(userModuleFile)).toBe(false);
    });
});

describe('loadClientGeneratorConfig', () => {
    it('applies the defaults without a config file and merges a config file over them', () => {
        const withoutConfig = loadClientGeneratorConfig(createInMemoryFileSystemAdapter(), projectRoot);
        expect(withoutConfig).toEqual({ ...defaultClientGeneratorConfig, rootDirectory: projectRoot });

        const configPath = nodePath.join(projectRoot, 'netsuite-api.config.json');
        const fileSystem = createInMemoryFileSystemAdapter({ [configPath]: JSON.stringify({ outDir: 'client/src/generated', typeImports: { '@shared/types': '@shared/types' } }) });
        expect(loadClientGeneratorConfig(fileSystem, projectRoot)).toEqual({
            ...defaultClientGeneratorConfig,
            outDir: 'client/src/generated',
            typeImports: { '@shared/types': '@shared/types' },
            rootDirectory: projectRoot,
        });
    });

    it('rejects a bad setting, an unknown setting and a named config that does not exist', () => {
        const configPath = nodePath.join(projectRoot, 'netsuite-api.config.json');
        const fileSystem = createInMemoryFileSystemAdapter({ [configPath]: JSON.stringify({ outDir: '', inlineTypes: ['x'], outFile: 'client/src/api/index.gen.ts' }) });
        expect(() => loadClientGeneratorConfig(fileSystem, projectRoot)).toThrow(/'outDir' must be a non-empty string\.\n - 'inlineTypes' must be an object of strings\.\n - 'outFile' is not a setting\./);
        expect(() => loadClientGeneratorConfig(fileSystem, projectRoot, 'other.json')).toThrow(/does not exist/);
    });

    it('rejects an inlineTypes entry whose key and file disagree about the wildcard', () => {
        const configPath = nodePath.join(projectRoot, 'netsuite-api.config.json');
        const fileSystem = createInMemoryFileSystemAdapter({
            [configPath]: JSON.stringify({ inlineTypes: { '../services/*': 'api/src/services/index.ts', '../shared': 'api/src/shared/*.ts', '../*/*': 'api/src/*/*.ts' } }),
        });
        expect(() => loadClientGeneratorConfig(fileSystem, projectRoot)).toThrow(
            /'inlineTypes' key '\.\.\/services\/\*' has a '\*' but its file 'api\/src\/services\/index\.ts' has none to put the name in\.\n - 'inlineTypes' file 'api\/src\/shared\/\*\.ts' has a '\*' but its key '\.\.\/shared' has none to take the name from\.\n - 'inlineTypes' key '\.\.\/\*\/\*' has more than one '\*'; one stands for the file name\./,
        );
    });
});

describe('runCli', () => {
    function environment(fileSystem: ReturnType<typeof projectFiles>) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        return { environment: { cwd: projectRoot, fileSystem, stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message) }, stdout, stderr };
    }

    it('generates, then reports the files current', () => {
        const fileSystem = projectFiles({ [nodePath.join(clientDirectory, 'models.gen.ts')]: modelsSource });
        const first = environment(fileSystem);
        expect(runCli(['generate'], first.environment)).toBe(0);
        expect(first.stdout.join('\n')).toBe([
            'netsuite-api: 2 controller(s), 4 file(s) written, 0 unchanged, 1 deleted.',
            ' - user (restlet): 1 endpoint(s)',
            ' - userRoles (suitelet): 1 endpoint(s), types only',
            ' - wrote client/src/api/user.gen.ts',
            ' - wrote client/src/api/userRoles.gen.ts',
            ' - wrote client/src/api/index.gen.ts',
            ' - wrote api/src/scripts.gen.ts',
            ' - deleted client/src/api/models.gen.ts',
        ].join('\n'));
        const second = environment(fileSystem);
        expect(runCli(['check'], second.environment)).toBe(0);
        expect(second.stdout[0]).toMatch(/^Generated files are up to date \(4 file\(s\)\)\./);
    });

    it('prints every file with --dry-run and writes nothing', () => {
        const fileSystem = projectFiles();
        const { environment: cliEnvironment, stdout } = environment(fileSystem);
        expect(runCli(['generate', '--dry-run'], cliEnvironment)).toBe(0);
        expect(stdout[0].startsWith(`// ---- client/src/api/user.gen.ts\n${expectedUserModule}\n// ---- client/src/api/userRoles.gen.ts\n${expectedUserRolesModule}`)).toBe(true);
        expect(stdout[0]).toContain('// ---- api/src/scripts.gen.ts\n');
        expect(fileSystem.fileExists(userModuleFile)).toBe(false);
    });

    it('lists the problems and exits 1 when a controller cannot be read, and 1 when a file is missing or left over', () => {
        const broken = environment(projectFiles({ [nodePath.join(controllersDirectory, 'brokenController.ts')]: 'export interface A { a: 1 }' }));
        expect(runCli(['generate'], broken.environment)).toBe(1);
        expect(broken.stderr[0]).toContain("api/src/controllers/brokenController.ts: must declare 'export const brokenEndpoints = defineEndpoints({ ... })'.");

        const missing = environment(projectFiles({ [nodePath.join(clientDirectory, 'orders.gen.ts')]: '// old' }));
        expect(runCli(['check'], missing.environment)).toBe(1);
        expect(missing.stderr[0]).toBe([
            'The generated files are not up to date. Run `netsuite-api generate`.',
            ' - missing: client/src/api/user.gen.ts',
            ' - missing: client/src/api/userRoles.gen.ts',
            ' - missing: client/src/api/index.gen.ts',
            ' - missing: api/src/scripts.gen.ts',
            ' - left over: client/src/api/orders.gen.ts',
        ].join('\n'));
    });

    it('shows usage for help and an unknown command, and exits 2 for a bad config', () => {
        const help = environment(projectFiles());
        expect(runCli([], help.environment)).toBe(0);
        expect(help.stdout[0]).toMatch(/^Usage: netsuite-api/);
        const unknown = environment(projectFiles());
        expect(runCli(['frobnicate'], unknown.environment)).toBe(2);
        const badConfig = environment(projectFiles({ [nodePath.join(projectRoot, 'netsuite-api.config.json')]: '{ not json' }));
        expect(runCli(['generate'], badConfig.environment)).toBe(2);
        expect(badConfig.stderr[0]).toMatch(/not valid JSON/);
    });
});
