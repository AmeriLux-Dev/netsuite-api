import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultClientGeneratorConfig } from '../../tooling/config.js';
import type { JobRunsSettings } from '../../tooling/config.js';
import { createInMemoryFileSystemAdapter } from '../../tooling/file-system.js';
import { planClientGeneration } from '../../tooling/generate.js';
import { readJobContract } from '../../tooling/jobReader.js';
import { closeStaleOrdersJobSource, modelsSource, staleOrderServiceSource, userControllerSource, userRolesControllerSource, userRolesServiceSource } from './fixtures.js';

const projectRoot = nodePath.resolve('/project');
const apiDirectory = nodePath.join(projectRoot, 'api', 'src');
const clientDirectory = nodePath.join(projectRoot, 'client', 'src', 'api');
const jobsDirectory = nodePath.join(apiDirectory, 'jobs');
/** A job is a folder of its own name: api/src/jobs/<name>/<name>.ts declares it, its stage files sit beside it. */
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

function projectFiles(overrides: Record<string, string | undefined> = {}) {
    const files: Record<string, string | undefined> = {
        [nodePath.join(apiDirectory, 'types', 'models.gen.ts')]: modelsSource,
        [nodePath.join(apiDirectory, 'services', 'userRolesService.ts')]: userRolesServiceSource,
        [nodePath.join(apiDirectory, 'services', 'staleOrderService.ts')]: staleOrderServiceSource,
        [nodePath.join(apiDirectory, 'controllers', 'userController.ts')]: userControllerSource,
        [nodePath.join(apiDirectory, 'controllers', 'userRolesController.ts')]: userRolesControllerSource,
        [jobFile('closeStaleOrders')]: closeStaleOrdersJobSource,
        ...overrides,
    };
    return createInMemoryFileSystemAdapter(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined)));
}

function optionsFor(fileSystem: ReturnType<typeof projectFiles>, configOverrides: Partial<typeof defaultClientGeneratorConfig> = {}) {
    return { config: { ...defaultClientGeneratorConfig, jobRuns, ...configOverrides, rootDirectory: projectRoot }, fileSystem };
}

/** A job with the given declaration and stages, so one detail at a time can be wrong. */
function jobSource(declaration: string, stages: string, exported = '{ getInputData, map, summarize }'): string {
    return `/**
 * @NScriptType MapReduceScript
 */
import { defineJob } from '@amerilux/netsuite-api/server';
import { jobRuns } from '../scripts.gen';

export const ${exported} = defineJob({${declaration}}, {${stages}});
`;
}

const validDeclaration = `
    name: 'closeStaleOrders',
    scriptId: 'customscript_demo_close_stale_mr',
    deployments: ['customdeploy_demo_close_stale_mr'],
    runParameter: 'custscript_demo_close_stale_run',
    runs: jobRuns,
`;
const validStages = `
    getInputData: (input: { olderThanDays: number }): number[] => [input.olderThanDays],
    map: (day: number, job): void => job.write(String(day), day),
    summarize: (summary): { days: number } => ({ days: summary.output.length }),
`;

function problemsOf(source: string): string[] {
    return readJobContract(closeStaleOrdersLabel, source, readerOptions).problems.map((problem) => problem.message);
}

describe('readJobContract', () => {
    it('reads the script, the stages and the shapes on either end of a run', () => {
        const result = readJobContract(closeStaleOrdersLabel, closeStaleOrdersJobSource, readerOptions);

        expect(result.problems).toEqual([]);
        expect(result.contract).toMatchObject({
            name: 'closeStaleOrders',
            script: {
                scriptId: 'customscript_demo_close_stale_mr',
                deployments: ['customdeploy_demo_close_stale_mr', 'customdeploy_demo_close_stale_mr_2'],
                runParameter: 'custscript_demo_close_stale_run',
                parameters: [{ name: 'batchSize', id: 'custscript_demo_close_stale_batch', type: 'integer' }],
            },
            inputType: 'CloseStaleRequest',
            resultType: 'CloseStaleResult',
            stages: ['getInputData', 'map', 'reduce', 'summarize'],
            exportedStages: ['getInputData', 'map', 'reduce', 'summarize'],
        });
    });

    it('wants the script type in the leading JSDoc', () => {
        expect(problemsOf(jobSource(validDeclaration, validStages).replace('MapReduceScript', 'Restlet'))).toContainEqual(expect.stringContaining("says '@NScriptType Restlet'"));
    });

    it('wants the run record the stages read the run through', () => {
        expect(problemsOf(jobSource(validDeclaration.replace('    runs: jobRuns,\n', ''), validStages))).toContainEqual(expect.stringContaining("needs 'runs: jobRuns'"));
    });

    it('wants at least one deployment', () => {
        expect(problemsOf(jobSource(validDeclaration.replace("['customdeploy_demo_close_stale_mr']", '[]'), validStages))).toContainEqual(expect.stringContaining("'deployments' is empty"));
    });

    it('wants the name to be the file name', () => {
        expect(problemsOf(jobSource(validDeclaration.replace("'closeStaleOrders'", "'somethingElse'"), validStages))).toContainEqual(expect.stringContaining("the job is closeStaleOrders"));
    });

    it('wants the input and result annotations it reads the shapes from', () => {
        expect(problemsOf(jobSource(validDeclaration, validStages.replace(': { olderThanDays: number }', '')))).toContainEqual(expect.stringContaining('getInputData has no type on its first parameter'));
        expect(problemsOf(jobSource(validDeclaration, validStages.replace(': { days: number }', '')))).toContainEqual(expect.stringContaining('summarize has no return type annotation'));
    });

    it('wants something for NetSuite to run', () => {
        const withoutMap = validStages.replace('    map: (day: number, job): void => job.write(String(day), day),\n', '');
        expect(problemsOf(jobSource(validDeclaration, withoutMap, '{ getInputData, summarize }'))).toContainEqual(expect.stringContaining('declares a map stage, a reduce stage, or both'));
    });

    it('wants summarize exported, because the run is closed there', () => {
        expect(problemsOf(jobSource(validDeclaration, validStages, '{ getInputData, map }'))).toContainEqual(expect.stringContaining('every job exports summarize'));
    });

    it('reports a stage exported without a declaration, and one declared without an export', () => {
        expect(problemsOf(jobSource(validDeclaration, validStages, '{ getInputData, map, reduce, summarize }'))).toContainEqual(expect.stringContaining("'reduce' is exported but not declared"));
        expect(problemsOf(jobSource(validDeclaration, validStages, '{ getInputData, summarize }'))).toContainEqual(expect.stringContaining("stage 'map' is declared but not exported"));
    });

    it('wants the stages exported from the call, the way NetSuite finds them', () => {
        const assigned = jobSource(validDeclaration, validStages).replace('export const { getInputData, map, summarize } =', 'const job =');
        expect(problemsOf(assigned)).toContainEqual(expect.stringContaining('the stages are exported from the call'));
    });

    it('rejects a Date in the input, which a run carries as JSON', () => {
        const plan = planClientGeneration(
            optionsFor(projectFiles({ [jobFile('closeStaleOrders')]: jobSource(validDeclaration, validStages.replace('olderThanDays: number', 'olderThan: Date')) })),
        );
        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('takes a Date in its input'));
    });
});

/**
 * A job in the shape a developer reads stage by stage: the definition file declares the script and wires
 * four names, and each stage's own file carries the work and the shapes on its own boundary.
 */
const stageShapedJob = {
    [jobFile('closeStaleOrders')]: `/**
 * @NScriptType MapReduceScript
 */

import { defineJob } from '@amerilux/netsuite-api/server';
import { jobRuns } from '../../scripts.gen';
import { getInputDataFunction } from './getInputData';
import { mapFunction } from './map';
import { summarizeFunction } from './summarize';

export const { getInputData, map, summarize } = defineJob({
    name: 'closeStaleOrders',
    scriptId: 'customscript_demo_close_stale_mr',
    deployments: ['customdeploy_demo_close_stale_mr', 'customdeploy_demo_close_stale_mr_2'],
    runParameter: 'custscript_demo_close_stale_run',
    runs: jobRuns,
}, {
    getInputData: getInputDataFunction,
    map: mapFunction,
    summarize: summarizeFunction,
});
`,
    [jobFile('closeStaleOrders', 'getInputData.ts')]: `import { listStaleOrders, type StaleOrder } from '../../services/staleOrderService';

/** What a run of this job is asked to do. */
export interface CloseStaleRequest {
    olderThanDays: number;
}

export const getInputDataFunction = (input: CloseStaleRequest): StaleOrder[] => listStaleOrders(input.olderThanDays);
`,
    [jobFile('closeStaleOrders', 'map.ts')]: `import { closeOrder, type StaleOrder } from '../../services/staleOrderService';

export const mapFunction = (order: StaleOrder, job: { write: (key: string, value: number) => void }): void => {
    if (closeOrder(order.id)) job.write(order.owner.name, order.id);
};
`,
    [jobFile('closeStaleOrders', 'summarize.ts')]: `import type { JobSummary } from '@amerilux/netsuite-api/server';

/** What the run leaves behind for the page that started it. */
export interface CloseStaleResult {
    closed: number;
}

export const summarizeFunction = (summary: JobSummary<number>): CloseStaleResult => ({ closed: summary.output.length });
`,
};

describe('a job whose stages are their own files', () => {
    it('reads the run\'s shapes from the stage that names them', () => {
        const result = readJobContract(closeStaleOrdersLabel, stageShapedJob[jobFile('closeStaleOrders')], {
            ...readerOptions,
            readStageFile: (specifier) => {
                const fileName = `${specifier.replace('./', '')}.ts`;
                const source = stageShapedJob[jobFile('closeStaleOrders', fileName)];
                return source === undefined ? undefined : { filePath: `api/src/jobs/closeStaleOrders/${fileName}`, source };
            },
        });

        expect(result.problems).toEqual([]);
        expect(result.contract).toMatchObject({ name: 'closeStaleOrders', inputType: 'CloseStaleRequest', resultType: 'CloseStaleResult', stages: ['getInputData', 'map', 'summarize'] });
        expect(result.contract?.stageFiles.map((stageFile) => stageFile.filePath)).toEqual([
            'api/src/jobs/closeStaleOrders/getInputData.ts',
            'api/src/jobs/closeStaleOrders/map.ts',
            'api/src/jobs/closeStaleOrders/summarize.ts',
        ]);
    });

    it('copies the result\'s shape out of the stage file that declares it, and says where it came from', () => {
        const module = planClientGeneration(optionsFor(projectFiles(stageShapedJob))).files.find((planned) => planned.path === jobModuleFile)?.content ?? '';

        expect(module).toContain('export type Result = CloseStaleResult;');
        expect(module).toContain('export interface CloseStaleResult {');
        expect(module).toContain('// Types from api/src/jobs/closeStaleOrders/summarize.ts, copied so this module stands on its own.');
        // JobSummary is the package's own, server-side: the result does not name it, so it is not carried over.
        expect(module).not.toContain('JobSummary');
    });

    it('carries a service type the result names through the stage file that imports it', () => {
        const resultNamingStaleOrder = {
            ...stageShapedJob,
            [jobFile('closeStaleOrders', 'summarize.ts')]: `import type { JobSummary } from '@amerilux/netsuite-api/server';
import type { StaleOrder } from '../../services/staleOrderService';

export interface CloseStaleResult {
    closed: number;
    oldest: StaleOrder;
}

export const summarizeFunction = (summary: JobSummary<StaleOrder>): CloseStaleResult => ({ closed: summary.output.length, oldest: summary.output[0].value });
`,
        };
        const module = planClientGeneration(optionsFor(projectFiles(resultNamingStaleOrder))).files.find((planned) => planned.path === jobModuleFile)?.content ?? '';

        expect(module).toContain('export interface StaleOrder {');
        expect(module).toContain('// Types from api/src/services/staleOrderService.ts, copied so this module stands on its own.');
    });

    it('says so when a stage names something the definition file does not import', () => {
        const withUnknownStage = { ...stageShapedJob, [jobFile('closeStaleOrders')]: stageShapedJob[jobFile('closeStaleOrders')].replace('map: mapFunction', 'map: mapTheOrders') };
        const problems = planClientGeneration(optionsFor(projectFiles(withUnknownStage))).problems.map((problem) => problem.message);

        expect(problems).toContainEqual(expect.stringContaining("stage 'map' names 'mapTheOrders', which this file does not import"));
    });

    it('says so when a stage is imported from somewhere that is not a file beside the job', () => {
        const fromPackage = {
            ...stageShapedJob,
            [jobFile('closeStaleOrders')]: stageShapedJob[jobFile('closeStaleOrders')].replace("import { mapFunction } from './map';", "import { mapFunction } from '@amerilux/netsuite-api/server';"),
        };
        const problems = planClientGeneration(optionsFor(projectFiles(fromPackage))).problems.map((problem) => problem.message);

        expect(problems).toContainEqual(expect.stringContaining("stage 'map' comes from '@amerilux/netsuite-api/server'"));
    });

    it('says so when the stage file is not there', () => {
        const withoutMapFile = { ...stageShapedJob, [jobFile('closeStaleOrders', 'map.ts')]: undefined };
        const problems = planClientGeneration(optionsFor(projectFiles(withoutMapFile))).problems.map((problem) => problem.message);

        expect(problems).toContainEqual(expect.stringContaining("stage 'map' is imported from './map', which is not a file beside the job"));
    });

    it('says so when the name a stage imports is not an exported function', () => {
        const notAFunction = { ...stageShapedJob, [jobFile('closeStaleOrders', 'map.ts')]: 'export const mapFunction = 7;\n' };
        const problems = planClientGeneration(optionsFor(projectFiles(notAFunction))).problems.map((problem) => problem.message);

        expect(problems).toContainEqual(expect.stringContaining("'mapFunction' is not exported from here as a function"));
    });

    it('reads an annotation the stage file leaves off as missing, pointing at that file', () => {
        const withoutReturnType = {
            ...stageShapedJob,
            [jobFile('closeStaleOrders', 'summarize.ts')]: stageShapedJob[jobFile('closeStaleOrders', 'summarize.ts')].replace('): CloseStaleResult =>', ') =>'),
        };
        const problems = planClientGeneration(optionsFor(projectFiles(withoutReturnType))).problems;

        expect(problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('summarize has no return type annotation'));
        expect(problems.map((problem) => problem.filePath)).toContainEqual('api/src/jobs/closeStaleOrders/summarize.ts');
    });
});

describe('planClientGeneration with jobs', () => {
    it('plans a module per job, the jobs index, and the run record in the scripts module', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));

        expect(plan.problems).toEqual([]);
        expect(plan.jobs).toEqual([{ name: 'closeStaleOrders', filePath: closeStaleOrdersLabel, stages: ['getInputData', 'map', 'reduce', 'summarize'], deploymentCount: 2 }]);
        expect(plan.files.map((file) => file.path)).toEqual(expect.arrayContaining([jobModuleFile, jobsIndexFile, indexModuleFile, scriptsModuleFile]));
    });

    it('writes the job module with the result, the shapes the result names, and nothing callable', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));
        const module = plan.files.find((file) => file.path === jobModuleFile)?.content ?? '';

        expect(module).toContain('export type Result = CloseStaleResult;');
        expect(module).toContain('export interface CloseStaleResult {');
        expect(module).not.toContain('createApiClient');
        // Nothing in the browser names what a run is started with or what its stages pass along, so neither is copied.
        expect(module).not.toContain('export type Input');
        expect(module).not.toContain('CloseStaleRequest');
        expect(module).not.toContain('export interface StaleOrder');
    });

    it('copies a service type the result names, and says where it came from', () => {
        const resultNamingStaleOrder = closeStaleOrdersJobSource.replace('    owners: string[];', '    sample: StaleOrder;').replace('owners: summary.output.map((entry) => entry.key),', 'sample: listStaleOrders(1)[0],');
        const module =
            planClientGeneration(optionsFor(projectFiles({ [jobFile('closeStaleOrders')]: resultNamingStaleOrder })))
                .files.find((file) => file.path === jobModuleFile)?.content ?? '';

        expect(module).toContain('export interface StaleOrder {');
        expect(module).toContain('// Types from api/src/services/staleOrderService.ts, copied so this module stands on its own.');
    });

    it('gives a job that answers nothing a null result, whether it has a summarize stage or not', () => {
        const withoutSummarize = jobSource(validDeclaration, validStages.replace('    summarize: (summary): { days: number } => ({ days: summary.output.length }),\n', ''));
        const returningVoid = jobSource(validDeclaration, validStages.replace(': { days: number } => ({ days: summary.output.length })', ': void => undefined'));

        for (const source of [withoutSummarize, returningVoid]) {
            const module = planClientGeneration(optionsFor(projectFiles({ [jobFile('closeStaleOrders')]: source })))
                .files.find((file) => file.path === nodePath.join(clientDirectory, 'closeStaleOrdersJob.gen.ts'))?.content ?? '';
            expect(module).toContain('export type Result = null;');
        }
    });

    it('reaches the jobs under `jobs` from the client index', () => {
        const plan = planClientGeneration(optionsFor(projectFiles()));

        expect(plan.files.find((file) => file.path === jobsIndexFile)?.content).toContain("export * as closeStaleOrders from './closeStaleOrdersJob.gen';");
        expect(plan.files.find((file) => file.path === indexModuleFile)?.content).toContain("export * as jobs from './jobs.gen';");
    });

    it('writes the jobs and the run record next to the scripts', () => {
        const scripts = planClientGeneration(optionsFor(projectFiles())).files.find((file) => file.path === scriptsModuleFile)?.content ?? '';

        expect(scripts).toContain("import type { JobRef, JobRunsConfig, ScriptRef } from '@amerilux/netsuite-api';");
        expect(scripts).toContain(
            "    closeStaleOrders: { kind: 'mapreduce', name: 'closeStaleOrders', scriptId: 'customscript_demo_close_stale_mr', deployments: ['customdeploy_demo_close_stale_mr', 'customdeploy_demo_close_stale_mr_2'], runParameter: 'custscript_demo_close_stale_run', parameters: { batchSize: 'custscript_demo_close_stale_batch' } },",
        );
        expect(scripts).toContain("recordType: 'customrecord_demo_job_run',");
        expect(scripts).toContain("status: 'custrecord_demo_jr_status',");
        expect(scripts).toContain("customerId: { id: 'custrecord_demo_jr_customer', type: 'integer' },");
        expect(scripts).toContain('} as const satisfies Record<string, JobRef>;');
    });

    it('leaves the scripts module as it was for a project with no jobs', () => {
        const withoutJobs = projectFiles({ [jobFile('closeStaleOrders')]: undefined });
        const scripts = planClientGeneration(optionsFor(withoutJobs, { jobRuns: undefined })).files.find((file) => file.path === scriptsModuleFile)?.content ?? '';

        expect(scripts).toContain("import type { ScriptRef } from '@amerilux/netsuite-api';");
        expect(scripts).not.toContain('jobs');
        expect(planClientGeneration(optionsFor(withoutJobs, { jobRuns: undefined })).files.map((file) => file.path)).not.toContain(jobsIndexFile);
    });

    it('says what is missing when a project has jobs but no run record', () => {
        const plan = planClientGeneration(optionsFor(projectFiles(), { jobRuns: undefined }));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('npm run add:jobs'));
    });

    it('reports a job and a controller claiming the same script id', () => {
        const clash = closeStaleOrdersJobSource.replace('customscript_demo_close_stale_mr', 'customscript_demo_user');
        const plan = planClientGeneration(optionsFor(projectFiles({ [jobFile('closeStaleOrders')]: clash })));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining("scriptId 'customscript_demo_user' is also declared by api/src/controllers/userController.ts"));
    });

    it('rejects a file sitting in the jobs folder itself', () => {
        const plan = planClientGeneration(optionsFor(projectFiles({ [nodePath.join(jobsDirectory, 'closeHelpers.ts')]: 'export const helper = 1;' })));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('a job lives in a folder of its own'));
    });

    it('says what is missing when a job folder has no file of its own name', () => {
        const plan = planClientGeneration(optionsFor(projectFiles({ [jobFile('closeStaleOrders')]: undefined, [jobFile('closeStaleOrders', 'map.ts')]: 'export const mapFunction = (): void => undefined;' })));

        expect(plan.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining('there is no closeStaleOrders.ts here'));
    });
});
