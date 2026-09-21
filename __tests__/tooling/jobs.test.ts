import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultClientGeneratorConfig } from '../../tooling/config.js';
import type { JobRunsSettings } from '../../tooling/config.js';
import { createInMemoryFileSystemAdapter } from '../../tooling/file-system.js';
import { planClientGeneration } from '../../tooling/generate.js';
import { readJobContract } from '../../tooling/jobReader.js';
import { closeStaleOrdersJobFiles, modelsSource, staleOrderServiceSource, userControllerSource, userRolesControllerSource, userRolesServiceSource } from './fixtures.js';

const projectRoot = nodePath.resolve('/project');
const apiDirectory = nodePath.join(projectRoot, 'api', 'src');
const clientDirectory = nodePath.join(projectRoot, 'client', 'src', 'api');
const jobsDirectory = nodePath.join(apiDirectory, 'jobs');
/** A job is a folder of its own name: api/src/jobs/<name>/<name>.ts is what NetSuite loads, its stage files sit beside it. */
const jobFile = (jobName: string, fileName = `${jobName}.ts`) => nodePath.join(jobsDirectory, jobName, fileName);
const closeStaleOrdersLabel = 'api/src/jobs/closeStaleOrders/closeStaleOrders.ts';
const jobModuleFile = nodePath.join(clientDirectory, 'closeStaleOrdersJob.gen.ts');
const jobsIndexFile = nodePath.join(clientDirectory, 'jobs.gen.ts');
const indexModuleFile = nodePath.join(clientDirectory, 'index.gen.ts');
const scriptsModuleFile = nodePath.join(apiDirectory, 'scripts.gen.ts');

const jobRuns: JobRunsSettings = {
    recordType: 'customrecord_demo_job_run',
    fieldPrefix: 'custrecord_demo_jr',
    extraFields: { customerId: { id: 'custrecord_demo_jr_customer', type: 'integer' } },
};

const readerOptions = { typeImports: defaultClientGeneratorConfig.typeImports, inlineTypes: defaultClientGeneratorConfig.inlineTypes };

/** The job's folder, with the given files replaced or (when undefined) taken away. */
function jobFolder(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const files: Record<string, string | undefined> = {};
    for (const [fileName, source] of Object.entries(closeStaleOrdersJobFiles)) files[jobFile('closeStaleOrders', fileName)] = source;
    for (const [fileName, source] of Object.entries(overrides)) files[jobFile('closeStaleOrders', fileName)] = source;
    return files;
}

function projectFiles(overrides: Record<string, string | undefined> = {}) {
    const files: Record<string, string | undefined> = {
        [nodePath.join(apiDirectory, 'types', 'models.gen.ts')]: modelsSource,
        [nodePath.join(apiDirectory, 'services', 'userRolesService.ts')]: userRolesServiceSource,
        [nodePath.join(apiDirectory, 'services', 'staleOrderService.ts')]: staleOrderServiceSource,
        [nodePath.join(apiDirectory, 'controllers', 'userController.ts')]: userControllerSource,
        [nodePath.join(apiDirectory, 'controllers', 'userRolesController.ts')]: userRolesControllerSource,
        ...jobFolder(),
        ...overrides,
    };
    return createInMemoryFileSystemAdapter(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined)));
}

function optionsFor(fileSystem: ReturnType<typeof projectFiles>, configOverrides: Partial<typeof defaultClientGeneratorConfig> = {}) {
    return { config: { ...defaultClientGeneratorConfig, jobRuns, ...configOverrides, rootDirectory: projectRoot }, fileSystem };
}

/** Reads the job the way the generator does, from a folder whose files the test can change one at a time. */
function readJob(overrides: Record<string, string | undefined> = {}) {
    const folder: Record<string, string | undefined> = { ...closeStaleOrdersJobFiles, ...overrides };
    return readJobContract(closeStaleOrdersLabel, folder['closeStaleOrders.ts'] ?? '', {
        ...readerOptions,
        readStageFile: (specifier) => {
            const fileName = `${specifier.replace('./', '')}.ts`;
            const source = folder[fileName];
            return source === undefined ? undefined : { filePath: `api/src/jobs/closeStaleOrders/${fileName}`, source };
        },
    });
}

function problemsOf(overrides: Record<string, string | undefined> = {}): string[] {
    return readJob(overrides).problems.map((problem) => problem.message);
}

describe('readJobContract', () => {
    it('reads the stages the script hands NetSuite and the shapes on either end of a run', () => {
        const result = readJob();

        expect(result.problems).toEqual([]);
        expect(result.contract).toMatchObject({
            name: 'closeStaleOrders',
            inputType: 'CloseStaleRequest',
            resultType: 'CloseStaleResult',
            stages: ['getInputData', 'map', 'reduce', 'summarize'],
        });
        expect(result.contract?.folderFiles.map((folderFile) => folderFile.filePath)).toEqual([
            'api/src/jobs/closeStaleOrders/getInputData.ts',
            'api/src/jobs/closeStaleOrders/map.ts',
            'api/src/jobs/closeStaleOrders/reduce.ts',
            'api/src/jobs/closeStaleOrders/summarize.ts',
        ]);
    });

    it('wants the script type in the leading JSDoc', () => {
        expect(problemsOf({ 'closeStaleOrders.ts': closeStaleOrdersJobFiles['closeStaleOrders.ts'].replace('MapReduceScript', 'Restlet') })).toContainEqual(
            expect.stringContaining("says '@NScriptType Restlet'"),
        );
    });

    it('wants getInputData, something to run, and summarize, which is where the run is closed', () => {
        expect(problemsOf({ 'closeStaleOrders.ts': closeStaleOrdersJobFiles['closeStaleOrders.ts'].replace("export { getInputData } from './getInputData';\n", '') })).toContainEqual(
            expect.stringContaining('a job exports getInputData'),
        );
        const withoutWork = closeStaleOrdersJobFiles['closeStaleOrders.ts'].replace("export { map } from './map';\n", '').replace("export { reduce } from './reduce';\n", '');
        expect(problemsOf({ 'closeStaleOrders.ts': withoutWork })).toContainEqual(expect.stringContaining('a job exports a map stage, a reduce stage, or both'));
        expect(problemsOf({ 'closeStaleOrders.ts': closeStaleOrdersJobFiles['closeStaleOrders.ts'].replace("export { summarize } from './summarize';\n", '') })).toContainEqual(
            expect.stringContaining('every job exports summarize'),
        );
    });

    it('rejects an export NetSuite has no entry point for', () => {
        expect(problemsOf({ 'closeStaleOrders.ts': closeStaleOrdersJobFiles['closeStaleOrders.ts'].replace("export { map } from './map';", "export { map, closeOne } from './map';") })).toContainEqual(
            expect.stringContaining("NetSuite has no entry point called 'closeOne'"),
        );
    });

    it('wants each stage to come from a file beside the job', () => {
        const fromPackage = closeStaleOrdersJobFiles['closeStaleOrders.ts'].replace("export { map } from './map';", "export { map } from '@amerilux/netsuite-api/server';");
        expect(problemsOf({ 'closeStaleOrders.ts': fromPackage })).toContainEqual(expect.stringContaining("'@amerilux/netsuite-api/server' is somewhere else"));
        expect(problemsOf({ 'map.ts': undefined })).toContainEqual(expect.stringContaining("there is no './map' beside the job"));
        expect(problemsOf({ 'map.ts': 'export const map = 7;\n' })).toContainEqual(expect.stringContaining("'map' is not exported from here as a function"));
    });

    it("wants a stage annotated with NetSuite's own context, the type it is called with", () => {
        const problems = readJob({ 'map.ts': "export function map(context: { value: string }): void {\n    void context;\n}\n" }).problems;

        expect(problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('EntryPoints.MapReduce.mapContext'));
        expect(problems.map((problem) => problem.filePath)).toContainEqual('api/src/jobs/closeStaleOrders/map.ts');
    });

    it('wants the run opened in getInputData and closed in summarize', () => {
        const withoutOpen = closeStaleOrdersJobFiles['getInputData.ts'].replace('openJobRun<CloseStaleRequest>(jobs.closeStaleOrders)', '{ olderThanDays: 30 }');
        expect(problemsOf({ 'getInputData.ts': withoutOpen })).toContainEqual(expect.stringContaining('getInputData opens the run it belongs to'));

        const withoutClose = closeStaleOrdersJobFiles['summarize.ts'].replace('closeJobRun<CloseStaleResult>(jobs.closeStaleOrders, context, { closed, owners });', 'void closed;\n    void owners;');
        expect(problemsOf({ 'summarize.ts': withoutClose })).toContainEqual(expect.stringContaining('summarize closes the run'));
    });

    it('wants the result written on the call that closes the run, which is where it reads it', () => {
        const untyped = closeStaleOrdersJobFiles['summarize.ts'].replace('closeJobRun<CloseStaleResult>(', 'closeJobRun(');
        const problems = readJob({ 'summarize.ts': untyped }).problems;

        expect(problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('a run\'s result shape is read from it'));
        expect(problems.map((problem) => problem.filePath)).toContainEqual('api/src/jobs/closeStaleOrders/summarize.ts');
    });

    it('takes a run that carries no input, which is how a scheduled job opens its own run', () => {
        const scheduled = closeStaleOrdersJobFiles['getInputData.ts']
            .replace('const input = openJobRun<CloseStaleRequest>(jobs.closeStaleOrders);', 'openJobRun(jobs.closeStaleOrders);')
            .replace('listStaleOrders(input.olderThanDays)', 'listStaleOrders(30)');
        const result = readJob({ 'getInputData.ts': scheduled });

        expect(result.problems).toEqual([]);
        expect(result.contract?.inputType).toBeUndefined();
    });

    it('wants the job in a folder of its own name', () => {
        const result = readJobContract('api/src/jobs/stale/closeStaleOrders.ts', closeStaleOrdersJobFiles['closeStaleOrders.ts'], readerOptions);

        expect(result.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('belongs in a folder called closeStaleOrders'));
    });

    it('rejects a Date in the input, which a run carries as JSON', () => {
        const withADate = closeStaleOrdersJobFiles['getInputData.ts'].replace('olderThanDays: number;', 'olderThan: Date;').replace('input.olderThanDays', '30');
        const plan = planClientGeneration(optionsFor(projectFiles(jobFolder({ 'getInputData.ts': withADate }))));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('takes a Date in its input'));
    });
});

describe('the shapes a run carries to the browser', () => {
    it('writes the job module with the result, the shapes the result names, and nothing callable', () => {
        const module = planClientGeneration(optionsFor(projectFiles())).files.find((file) => file.path === jobModuleFile)?.content ?? '';

        expect(module).toContain('export type Result = CloseStaleResult;');
        expect(module).toContain('export interface CloseStaleResult {');
        expect(module).toContain('// Types from api/src/jobs/closeStaleOrders/summarize.ts, copied so this module stands on its own.');
        expect(module).not.toContain('createApiClient');
        // Nothing in the browser names what a run is started with or what its stages pass along, so neither is copied.
        expect(module).not.toContain('export type Input');
        expect(module).not.toContain('CloseStaleRequest');
        expect(module).not.toContain('EntryPoints');
    });

    it('carries a service type the result names, and says where it came from', () => {
        const resultNamingStaleOrder = closeStaleOrdersJobFiles['summarize.ts']
            .replace("import { closeJobRun } from '../../repositories/jobRunRepository';", "import { closeJobRun } from '../../repositories/jobRunRepository';\nimport type { StaleOrder } from '../../services/staleOrderService';")
            .replace('    owners: string[];', '    oldest: StaleOrder | null;')
            .replace('{ closed, owners }', '{ closed, oldest: null }');
        const module =
            planClientGeneration(optionsFor(projectFiles(jobFolder({ 'summarize.ts': resultNamingStaleOrder })))).files.find((file) => file.path === jobModuleFile)?.content ?? '';

        expect(module).toContain('export interface StaleOrder {');
        expect(module).toContain('// Types from api/src/services/staleOrderService.ts, copied so this module stands on its own.');
    });

    it('reads a shape one stage file names from another', () => {
        // The value a map stage writes is declared where map writes it, and summarize names it again.
        const mapWritingAnOutcome = `import type { EntryPoints } from 'N/types';
import { closeOrder, type StaleOrder } from '../../services/staleOrderService';

/** What closing one order came to. */
export interface CloseOutcome {
    orderId: number;
    closed: boolean;
}

export function map(context: EntryPoints.MapReduce.mapContext): void {
    const order = JSON.parse(context.value) as StaleOrder;
    const outcome: CloseOutcome = { orderId: order.id, closed: closeOrder(order.id) };
    context.write({ key: order.owner.name, value: JSON.stringify(outcome) });
}
`;
        const summarizeNamingIt = `import type { EntryPoints } from 'N/types';
import { jobs } from '../../../../netsuite';
import { closeJobRun } from '../../repositories/jobRunRepository';
import type { CloseOutcome } from './map';

/** What the run leaves behind for the page that started it. */
export interface CloseStaleResult {
    outcomes: CloseOutcome[];
}

export function summarize(context: EntryPoints.MapReduce.summarizeContext): void {
    const outcomes: CloseOutcome[] = [];
    context.output.iterator().each((_key, value) => {
        outcomes.push(JSON.parse(value) as CloseOutcome);
        return true;
    });
    closeJobRun<CloseStaleResult>(jobs.closeStaleOrders, context, { outcomes });
}
`;
        const plan = planClientGeneration(optionsFor(projectFiles(jobFolder({ 'map.ts': mapWritingAnOutcome, 'summarize.ts': summarizeNamingIt }))));
        const module = plan.files.find((planned) => planned.path === jobModuleFile)?.content ?? '';

        expect(plan.problems).toEqual([]);
        expect(module).toContain('export type Result = CloseStaleResult;');
        expect(module).toContain('export interface CloseOutcome {');
        expect(module).toContain('// Types from api/src/jobs/closeStaleOrders/map.ts, copied so this module stands on its own.');
    });

    it('gives a run that leaves nothing behind a null result', () => {
        const leavingNothing = closeStaleOrdersJobFiles['summarize.ts'].replace('closeJobRun<CloseStaleResult>(jobs.closeStaleOrders, context, { closed, owners })', 'closeJobRun<null>(jobs.closeStaleOrders, context, null)');
        const module =
            planClientGeneration(optionsFor(projectFiles(jobFolder({ 'summarize.ts': leavingNothing })))).files.find((file) => file.path === jobModuleFile)?.content ?? '';

        expect(module).toContain('export type Result = null;');
    });
});

describe('planClientGeneration with jobs', () => {
    it('plans a module per job, the jobs index, and the run record in the scripts module', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));

        expect(plan.problems).toEqual([]);
        expect(plan.jobs).toEqual([{ name: 'closeStaleOrders', filePath: closeStaleOrdersLabel, stages: ['getInputData', 'map', 'reduce', 'summarize'] }]);
        expect(plan.files.map((file) => file.path)).toEqual(expect.arrayContaining([jobModuleFile, jobsIndexFile, indexModuleFile, scriptsModuleFile]));
    });

    it('reaches the jobs under `jobs` from the client index', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));

        expect(plan.files.find((file) => file.path === jobsIndexFile)?.content).toContain("export * as closeStaleOrders from './closeStaleOrdersJob.gen';");
        expect(plan.files.find((file) => file.path === indexModuleFile)?.content).toContain("export * as jobs from './jobs.gen';");
    });

    it('writes the run record beside the scripts, and no job ids: those are written in netsuite.ts', () => {
        const scripts = planClientGeneration(optionsFor(projectFiles())).files.find((file) => file.path === scriptsModuleFile)?.content ?? '';

        expect(scripts).toContain("import type { JobRunsConfig, ScriptRef } from '@amerilux/netsuite-api';");
        expect(scripts).toContain("recordType: 'customrecord_demo_job_run',");
        expect(scripts).toContain("status: 'custrecord_demo_jr_status',");
        expect(scripts).toContain("customerId: { id: 'custrecord_demo_jr_customer', type: 'integer' },");
        expect(scripts).not.toContain('customscript_demo_close_stale_mr');
        expect(scripts).not.toContain('export const jobs');
    });

    it('leaves the scripts module as it was for a project with no jobs', () => {
        const withoutJobs = projectFiles(Object.fromEntries(Object.keys(jobFolder()).map((path) => [path, undefined])));
        const scripts = planClientGeneration(optionsFor(withoutJobs, { jobRuns: undefined })).files.find((file) => file.path === scriptsModuleFile)?.content ?? '';

        expect(scripts).toContain("import type { ScriptRef } from '@amerilux/netsuite-api';");
        expect(scripts).not.toContain('jobs');
        expect(planClientGeneration(optionsFor(withoutJobs, { jobRuns: undefined })).files.map((file) => file.path)).not.toContain(jobsIndexFile);
    });

    it('says what is missing when a project has jobs but no run record', () => {
        const plan = planClientGeneration(optionsFor(projectFiles(), { jobRuns: undefined }));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('npm run add:jobs'));
    });

    it('rejects a file sitting in the jobs folder itself', () => {
        const plan = planClientGeneration(optionsFor(projectFiles({ [nodePath.join(jobsDirectory, 'closeHelpers.ts')]: 'export const helper = 1;' })));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('a job lives in a folder of its own'));
    });

    it('says what is missing when a job folder has no file of its own name', () => {
        const plan = planClientGeneration(optionsFor(projectFiles(jobFolder({ 'closeStaleOrders.ts': undefined }))));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('there is no closeStaleOrders.ts here'));
    });
});
