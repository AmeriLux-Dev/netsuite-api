import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultClientGeneratorConfig, loadClientGeneratorConfig } from '../../tooling/config.js';
import { createInMemoryFileSystemAdapter } from '../../tooling/file-system.js';
import { checkClientGeneration, planClientGeneration, runClientGeneration } from '../../tooling/generate.js';
import { runCli } from '../../tooling/cli/main.js';
import { expectedClientModule, scriptsSource, userControllerSource, userRolesControllerSource } from './fixtures.js';

const projectRoot = nodePath.resolve('/project');
const clientDirectory = nodePath.join(projectRoot, 'client');
const outFile = nodePath.join(clientDirectory, 'src', 'api', 'index.gen.ts');

function projectFiles(overrides: Record<string, string> = {}) {
    return createInMemoryFileSystemAdapter({
        [nodePath.join(projectRoot, 'common', 'netsuite.ts')]: scriptsSource,
        [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'userController.ts')]: userControllerSource,
        [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'userRolesController.ts')]: userRolesControllerSource,
        [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'notes.md')]: 'not a controller',
        ...overrides,
    });
}

function optionsFor(fileSystem: ReturnType<typeof projectFiles>) {
    return { config: { ...defaultClientGeneratorConfig, rootDirectory: clientDirectory }, fileSystem };
}

describe('planClientGeneration', () => {
    it('writes every controller into one module: types for all, a client for the browser-facing ones', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));
        expect(plan.problems).toEqual([]);
        expect(plan.outFile).toBe(outFile);
        expect(plan.controllers).toEqual([
            { name: 'user', filePath: 'api/src/controllers/userController.ts', browser: true, endpointCount: 1 },
            { name: 'userRoles', filePath: 'api/src/controllers/userRolesController.ts', browser: false, endpointCount: 1 },
        ]);
        expect(plan.content).toBe(expectedClientModule);
    });

    it('leaves out the client imports when no controller faces the browser', () => {
        const fileSystem = projectFiles({
            [nodePath.join(projectRoot, 'common', 'netsuite.ts')]: scriptsSource.replace("deployId: 'customdeploy_demo_user' }", "deployId: 'customdeploy_demo_user', browser: false }"),
        });
        const plan = planClientGeneration(optionsFor(fileSystem));
        expect(plan.problems).toEqual([]);
        expect(plan.content).not.toContain('createApiClient');
        expect(plan.content).not.toContain("from 'common/netsuite'");
        expect(plan.content).toContain('export type UserEndpoints = {');
    });

    it('reports a controller without a scripts entry, a missing scripts file and an empty controllers folder', () => {
        const orphan = projectFiles({ [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'orderController.ts')]: userControllerSource.replace(/user/g, 'order').replace(/User/g, 'Order') });
        expect(planClientGeneration(optionsFor(orphan)).problems).toEqual([
            { filePath: 'api/src/controllers/orderController.ts', message: 'has no scripts.order entry in common/netsuite.ts.' },
        ]);

        const noScripts = createInMemoryFileSystemAdapter({ [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'userController.ts')]: userControllerSource });
        expect(planClientGeneration(optionsFor(noScripts)).problems.map((problem) => problem.message)).toEqual(['the scripts file does not exist.']);

        const noControllers = createInMemoryFileSystemAdapter({ [nodePath.join(projectRoot, 'common', 'netsuite.ts')]: scriptsSource });
        expect(planClientGeneration(optionsFor(noControllers)).problems).toEqual([{ filePath: 'api/src/controllers', message: 'holds no <name>Controller.ts file.' }]);
    });

    it('reports a type name two controllers both declare', () => {
        const duplicate = projectFiles({
            [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'userController.ts')]: userControllerSource.replace('import type { RoleSummary } from \'./userRolesController\';', 'export interface RoleSummary { roleId: number }'),
        });
        const plan = planClientGeneration(optionsFor(duplicate));
        expect(plan.problems).toEqual([
            { filePath: 'api/src/controllers/userRolesController.ts', message: "type 'RoleSummary' is also declared by api/src/controllers/userController.ts; the generated module holds every controller, so names are unique across them." },
        ]);
        expect(plan.content).toBe('');
    });
});

describe('runClientGeneration and checkClientGeneration', () => {
    it('writes the module once and reports it current afterwards', () => {
        const fileSystem = projectFiles();
        const options = optionsFor(fileSystem);
        expect(checkClientGeneration(options).status).toBe('missing');
        expect(runClientGeneration(options).written).toBe(true);
        expect(fileSystem.readTextFile(outFile)).toBe(expectedClientModule);
        expect(runClientGeneration(options).written).toBe(false);
        expect(checkClientGeneration(options).status).toBe('current');
        fileSystem.writeTextFile(outFile, '// edited by hand');
        expect(checkClientGeneration(options).status).toBe('stale');
    });

    it('writes nothing when there are problems', () => {
        const fileSystem = projectFiles({ [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'brokenController.ts')]: 'export interface A { a: 1 }' });
        const result = runClientGeneration(optionsFor(fileSystem));
        expect(result.written).toBe(false);
        expect(fileSystem.fileExists(outFile)).toBe(false);
    });
});

describe('loadClientGeneratorConfig', () => {
    it('applies the defaults without a config file and merges a config file over them', () => {
        const withoutConfig = loadClientGeneratorConfig(createInMemoryFileSystemAdapter(), clientDirectory);
        expect(withoutConfig).toEqual({ ...defaultClientGeneratorConfig, rootDirectory: clientDirectory });

        const configPath = nodePath.join(clientDirectory, 'netsuite-api.config.json');
        const fileSystem = createInMemoryFileSystemAdapter({ [configPath]: JSON.stringify({ outFile: 'src/generated/api.ts', carriedTypeImports: ['common/', '@shared/'] }) });
        expect(loadClientGeneratorConfig(fileSystem, clientDirectory)).toEqual({
            ...defaultClientGeneratorConfig,
            outFile: 'src/generated/api.ts',
            carriedTypeImports: ['common/', '@shared/'],
            rootDirectory: clientDirectory,
        });
    });

    it('rejects a bad setting, an unknown setting and a named config that does not exist', () => {
        const configPath = nodePath.join(clientDirectory, 'netsuite-api.config.json');
        const fileSystem = createInMemoryFileSystemAdapter({ [configPath]: JSON.stringify({ outFile: '', extra: 1 }) });
        expect(() => loadClientGeneratorConfig(fileSystem, clientDirectory)).toThrow(/'outFile' must be a non-empty string\.\n - 'extra' is not a setting\./);
        expect(() => loadClientGeneratorConfig(fileSystem, clientDirectory, 'other.json')).toThrow(/does not exist/);
    });
});

describe('runCli', () => {
    function environment(fileSystem: ReturnType<typeof projectFiles>) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        return { environment: { cwd: clientDirectory, fileSystem, stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message) }, stdout, stderr };
    }

    it('generates, then reports the module current', () => {
        const fileSystem = projectFiles();
        const first = environment(fileSystem);
        expect(runCli(['generate'], first.environment)).toBe(0);
        expect(first.stdout.join('\n')).toBe('Wrote src/api/index.gen.ts: 2 controller(s)\n - user: 1 endpoint(s)\n - userRoles: 1 endpoint(s), types only');
        const second = environment(fileSystem);
        expect(runCli(['check'], second.environment)).toBe(0);
        expect(second.stdout[0]).toMatch(/^Up to date: src\/api\/index\.gen\.ts/);
    });

    it('prints the module with --dry-run and writes nothing', () => {
        const fileSystem = projectFiles();
        const { environment: cliEnvironment, stdout } = environment(fileSystem);
        expect(runCli(['generate', '--dry-run'], cliEnvironment)).toBe(0);
        expect(stdout[0]).toBe(expectedClientModule);
        expect(fileSystem.fileExists(outFile)).toBe(false);
    });

    it('lists the problems and exits 1 when a controller cannot be read, and 1 when the module is missing', () => {
        const broken = environment(projectFiles({ [nodePath.join(projectRoot, 'api', 'src', 'controllers', 'brokenController.ts')]: 'export interface A { a: 1 }' }));
        expect(runCli(['generate'], broken.environment)).toBe(1);
        expect(broken.stderr[0]).toContain("api/src/controllers/brokenController.ts: must declare 'export const brokenEndpoints = defineEndpoints({ ... })'.");

        const missing = environment(projectFiles());
        expect(runCli(['check'], missing.environment)).toBe(1);
        expect(missing.stderr[0]).toBe('The client module is missing. Run `netsuite-api generate`.');
    });

    it('shows usage for help and an unknown command, and exits 2 for a bad config', () => {
        const help = environment(projectFiles());
        expect(runCli([], help.environment)).toBe(0);
        expect(help.stdout[0]).toMatch(/^Usage: netsuite-api/);
        const unknown = environment(projectFiles());
        expect(runCli(['frobnicate'], unknown.environment)).toBe(2);
        const badConfig = environment(projectFiles({ [nodePath.join(clientDirectory, 'netsuite-api.config.json')]: '{ not json' }));
        expect(runCli(['generate'], badConfig.environment)).toBe(2);
        expect(badConfig.stderr[0]).toMatch(/not valid JSON/);
    });
});
