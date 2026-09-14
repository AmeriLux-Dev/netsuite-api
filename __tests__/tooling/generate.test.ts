import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultClientGeneratorConfig, loadClientGeneratorConfig } from '../../tooling/config.js';
import { createInMemoryFileSystemAdapter } from '../../tooling/file-system.js';
import { checkClientGeneration, planClientGeneration, runClientGeneration } from '../../tooling/generate.js';
import { runCli } from '../../tooling/cli/main.js';
import { appSource, expectedAppModule, expectedClientModule, expectedScriptsModule, modelsSource, userControllerSource, userRolesControllerSource } from './fixtures.js';

const projectRoot = nodePath.resolve('/project');
const clientModuleFile = nodePath.join(projectRoot, 'client', 'src', 'api', 'index.gen.ts');
const appModuleFile = nodePath.join(projectRoot, 'client', 'src', 'app.gen.ts');
const scriptsModuleFile = nodePath.join(projectRoot, 'api', 'src', 'scripts.gen.ts');
const modelsCopyFile = nodePath.join(projectRoot, 'client', 'src', 'api', 'models.gen.ts');
const controllersDirectory = nodePath.join(projectRoot, 'api', 'src', 'controllers');

function projectFiles(overrides: Record<string, string | undefined> = {}) {
    const files: Record<string, string | undefined> = {
        [nodePath.join(projectRoot, 'netsuite.ts')]: appSource,
        [nodePath.join(projectRoot, 'api', 'src', 'types', 'models.gen.ts')]: modelsSource,
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

describe('planClientGeneration', () => {
    it('plans the client module, the app module, the scripts module and the copied model types', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));
        expect(plan.problems).toEqual([]);
        expect(plan.controllers).toEqual([
            { name: 'user', filePath: 'api/src/controllers/userController.ts', kind: 'restlet', browser: true, endpointCount: 1 },
            { name: 'userRoles', filePath: 'api/src/controllers/userRolesController.ts', kind: 'suitelet', browser: false, endpointCount: 1 },
        ]);
        expect(plan.files.map((file) => file.path)).toEqual([clientModuleFile, appModuleFile, scriptsModuleFile, modelsCopyFile]);
        expect(plan.files[0].content).toBe(expectedClientModule);
        expect(plan.files[1].content).toBe(expectedAppModule);
        expect(plan.files[2].content).toBe(expectedScriptsModule);
        expect(plan.files[3].content).toBe(modelsSource);
    });

    it('leaves out the client import when no controller faces the browser', () => {
        const fileSystem = projectFiles({
            [nodePath.join(controllersDirectory, 'userController.ts')]: userControllerSource.replace("deployId: 'customdeploy_demo_user',", "deployId: 'customdeploy_demo_user',\n    browser: false,"),
        });
        const plan = planClientGeneration(optionsFor(fileSystem));
        expect(plan.problems).toEqual([]);
        expect(plan.files[0].content).not.toContain('createApiClient');
        expect(plan.files[0].content).toContain('export type UserEndpoints = {');
        expect(plan.files[2].content).toContain("user: { kind: 'restlet', scriptId: 'customscript_demo_user', deployId: 'customdeploy_demo_user', browser: false },");
    });

    it('lists the raw endpoints on the client and imports RawResponse from the client entry', () => {
        const documentsController = `/**
 * @NScriptType Suitelet
 */
import type { RawResponse } from '@amerilux/netsuite-api/server';
import { defineEndpoints, defineSuitelet, rawResponse } from '@amerilux/netsuite-api/server';
export const documentsEndpoints = defineEndpoints({
    csv: (request: { month: string }): RawResponse => rawResponse({ contentType: 'text/csv', body: request.month }),
    months: (): string[] => [],
});
export type DocumentsEndpoints = typeof documentsEndpoints;
export const onRequest = defineSuitelet({ name: 'documents', scriptId: 'customscript_demo_documents', deployId: 'customdeploy_demo_documents' }, documentsEndpoints);
`;
        const plan = planClientGeneration(optionsFor(projectFiles({ [nodePath.join(controllersDirectory, 'documentsController.ts')]: documentsController })));
        expect(plan.problems).toEqual([]);
        expect(plan.files[0].content).toContain("import type { RawResponse } from '@amerilux/netsuite-api/client';");
        expect(plan.files[0].content).toContain('    csv: (request: { month: string }) => RawResponse;');
        expect(plan.files[0].content).toContain("export const documentsApi = createApiClient<DocumentsEndpoints>({ kind: 'suitelet', scriptId: 'customscript_demo_documents', deployId: 'customdeploy_demo_documents' }, { rawEndpoints: ['csv'] });");
    });

    it('reports a missing app file, a missing models file and an empty controllers folder', () => {
        const problems = planClientGeneration(optionsFor(projectFiles({
            [nodePath.join(projectRoot, 'netsuite.ts')]: undefined,
            [nodePath.join(projectRoot, 'api', 'src', 'types', 'models.gen.ts')]: undefined,
            [nodePath.join(controllersDirectory, 'userController.ts')]: undefined,
            [nodePath.join(controllersDirectory, 'userRolesController.ts')]: undefined,
        }))).problems;
        expect(problems).toEqual([
            { filePath: 'api/src/controllers', message: 'holds no <name>Controller.ts file.' },
            { filePath: 'netsuite.ts', message: 'the app file does not exist.' },
            { filePath: 'api/src/types/models.gen.ts', message: 'the file to copy into the client does not exist; run the model generator first.' },
        ]);
    });

    it('reports a type name or a script id two controllers both declare', () => {
        const duplicate = projectFiles({
            [nodePath.join(controllersDirectory, 'userController.ts')]: userControllerSource
                .replace("import type { RoleSummary } from './userRolesController';", 'export interface RoleSummary { roleId: number }')
                .replace("scriptId: 'customscript_demo_user'", "scriptId: 'customscript_demo_user_roles'"),
        });
        const plan = planClientGeneration(optionsFor(duplicate));
        expect(plan.problems).toEqual([
            { filePath: 'api/src/controllers/userRolesController.ts', message: "type 'RoleSummary' is also declared by api/src/controllers/userController.ts; the generated module holds every controller, so names are unique across them." },
            { filePath: 'api/src/controllers/userRolesController.ts', message: "scriptId 'customscript_demo_user_roles' is also declared by api/src/controllers/userController.ts; every controller is its own script." },
        ]);
        expect(plan.files).toEqual([]);
    });
});

describe('runClientGeneration and checkClientGeneration', () => {
    it('writes the files once and reports them current afterwards', () => {
        const fileSystem = projectFiles();
        const options = optionsFor(fileSystem);
        expect(checkClientGeneration(options).missingFiles).toEqual([clientModuleFile, appModuleFile, scriptsModuleFile, modelsCopyFile]);
        const first = runClientGeneration(options);
        expect(first.writtenFiles).toEqual([clientModuleFile, appModuleFile, scriptsModuleFile, modelsCopyFile]);
        expect(fileSystem.readTextFile(clientModuleFile)).toBe(expectedClientModule);
        expect(fileSystem.readTextFile(appModuleFile)).toBe(expectedAppModule);
        expect(fileSystem.readTextFile(scriptsModuleFile)).toBe(expectedScriptsModule);
        const second = runClientGeneration(options);
        expect(second.writtenFiles).toEqual([]);
        expect(second.unchangedFiles).toHaveLength(4);
        expect(checkClientGeneration(options)).toMatchObject({ missingFiles: [], staleFiles: [] });
        fileSystem.writeTextFile(scriptsModuleFile, '// edited by hand');
        expect(checkClientGeneration(options).staleFiles).toEqual([scriptsModuleFile]);
    });

    it('writes nothing when there are problems', () => {
        const fileSystem = projectFiles({ [nodePath.join(controllersDirectory, 'brokenController.ts')]: 'export interface A { a: 1 }' });
        const result = runClientGeneration(optionsFor(fileSystem));
        expect(result.writtenFiles).toEqual([]);
        expect(fileSystem.fileExists(clientModuleFile)).toBe(false);
    });
});

describe('loadClientGeneratorConfig', () => {
    it('applies the defaults without a config file and merges a config file over them', () => {
        const withoutConfig = loadClientGeneratorConfig(createInMemoryFileSystemAdapter(), projectRoot);
        expect(withoutConfig).toEqual({ ...defaultClientGeneratorConfig, rootDirectory: projectRoot });

        const configPath = nodePath.join(projectRoot, 'netsuite-api.config.json');
        const fileSystem = createInMemoryFileSystemAdapter({ [configPath]: JSON.stringify({ outFile: 'client/src/generated/api.ts', typeImports: { '@shared/types': '@shared/types' } }) });
        expect(loadClientGeneratorConfig(fileSystem, projectRoot)).toEqual({
            ...defaultClientGeneratorConfig,
            outFile: 'client/src/generated/api.ts',
            typeImports: { '@shared/types': '@shared/types' },
            rootDirectory: projectRoot,
        });
    });

    it('rejects a bad setting, an unknown setting and a named config that does not exist', () => {
        const configPath = nodePath.join(projectRoot, 'netsuite-api.config.json');
        const fileSystem = createInMemoryFileSystemAdapter({ [configPath]: JSON.stringify({ outFile: '', copyFiles: ['x'], extra: 1 }) });
        expect(() => loadClientGeneratorConfig(fileSystem, projectRoot)).toThrow(/'outFile' must be a non-empty string\.\n - 'copyFiles' must be an object of strings\.\n - 'extra' is not a setting\./);
        expect(() => loadClientGeneratorConfig(fileSystem, projectRoot, 'other.json')).toThrow(/does not exist/);
    });
});

describe('runCli', () => {
    function environment(fileSystem: ReturnType<typeof projectFiles>) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        return { environment: { cwd: projectRoot, fileSystem, stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message) }, stdout, stderr };
    }

    it('generates, then reports the files current', () => {
        const fileSystem = projectFiles();
        const first = environment(fileSystem);
        expect(runCli(['generate'], first.environment)).toBe(0);
        expect(first.stdout.join('\n')).toBe([
            'netsuite-api: 2 controller(s), 4 file(s) written, 0 unchanged.',
            ' - user (restlet): 1 endpoint(s)',
            ' - userRoles (suitelet): 1 endpoint(s), types only',
            ' - wrote client/src/api/index.gen.ts',
            ' - wrote client/src/app.gen.ts',
            ' - wrote api/src/scripts.gen.ts',
            ' - wrote client/src/api/models.gen.ts',
        ].join('\n'));
        const second = environment(fileSystem);
        expect(runCli(['check'], second.environment)).toBe(0);
        expect(second.stdout[0]).toMatch(/^Generated files are up to date \(4 file\(s\)\)\./);
    });

    it('prints the client module with --dry-run and writes nothing', () => {
        const fileSystem = projectFiles();
        const { environment: cliEnvironment, stdout } = environment(fileSystem);
        expect(runCli(['generate', '--dry-run'], cliEnvironment)).toBe(0);
        expect(stdout[0]).toBe(expectedClientModule);
        expect(fileSystem.fileExists(clientModuleFile)).toBe(false);
    });

    it('lists the problems and exits 1 when a controller cannot be read, and 1 when a file is missing', () => {
        const broken = environment(projectFiles({ [nodePath.join(controllersDirectory, 'brokenController.ts')]: 'export interface A { a: 1 }' }));
        expect(runCli(['generate'], broken.environment)).toBe(1);
        expect(broken.stderr[0]).toContain("api/src/controllers/brokenController.ts: must declare 'export const brokenEndpoints = defineEndpoints({ ... })'.");

        const missing = environment(projectFiles());
        expect(runCli(['check'], missing.environment)).toBe(1);
        expect(missing.stderr[0]).toBe([
            'The generated files are not up to date. Run `netsuite-api generate`.',
            ' - missing: client/src/api/index.gen.ts',
            ' - missing: client/src/app.gen.ts',
            ' - missing: api/src/scripts.gen.ts',
            ' - missing: client/src/api/models.gen.ts',
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
