import * as nodePath from 'node:path';
import { resolveInlineTypesFile, resolveJobRunFieldIds } from './config.js';
import type { ResolvedClientGeneratorConfig } from './config.js';
import { isControllerFileName, readControllerContract } from './controllerReader.js';
import type { ControllerContract, ControllerProblem, InlinedTypeImport } from './controllerReader.js';
import {
    CLIENT_INDEX_FILE_NAME,
    JOBS_INDEX_FILE_NAME,
    controllerModuleFileName,
    emitClientIndexModule,
    emitControllerModule,
    emitJobModule,
    emitJobsIndexModule,
    findTypesReachedBy,
    emitScriptsModule,
    jobModuleFileName,
    sortControllers,
    sortJobs,
} from './emit.js';
import type { EmittedController, EmittedJob, EmittedJobRuns, InlinedTypeSection } from './emit.js';
import { jobDefinitionFileName, readJobContract, readJobFolderName } from './jobReader.js';
import type { JobContract } from './jobReader.js';
import { toPosixPath } from './file-system.js';
import type { FileSystemAdapter } from './file-system.js';
import { readInlinableTypesFile, selectInlinedTypes } from './typesFileReader.js';
import type { InlinableTypesFile } from './typesFileReader.js';
import { readReferencedNames } from './wireTypes.js';

export interface GenerateClientOptions {
    config: ResolvedClientGeneratorConfig;
    fileSystem: FileSystemAdapter;
}

export interface PlannedController {
    name: string;
    filePath: string;
    kind: 'restlet' | 'suitelet';
    browser: boolean;
    endpointCount: number;
}

export interface PlannedJob {
    name: string;
    filePath: string;
    /** The stages the job declares, in the order NetSuite calls them. */
    stages: string[];
    /** How many deployments a run can be started on: how many runs of the job can overlap. */
    deploymentCount: number;
}

export interface PlannedFile {
    /** Absolute path. */
    path: string;
    content: string;
}

export interface ClientGenerationPlan {
    /** The modules to write: one per controller and per job, the client index, the jobs index, the scripts map; empty when there are problems. */
    files: PlannedFile[];
    /** Generated files in the client's output directory the plan does not write: a removed controller's module, or the copy of the entity types an earlier version made. Absolute paths. */
    leftoverFiles: string[];
    controllers: PlannedController[];
    jobs: PlannedJob[];
    problems: ControllerProblem[];
}

export interface ClientGenerationResult extends ClientGenerationPlan {
    writtenFiles: string[];
    unchangedFiles: string[];
    deletedFiles: string[];
}

export interface ClientGenerationCheck extends ClientGenerationPlan {
    missingFiles: string[];
    staleFiles: string[];
}

const generatedFileNamePattern = /\.gen\.ts$/;

function relativeLabel(rootDirectory: string, filePath: string): string {
    return toPosixPath(nodePath.relative(rootDirectory, filePath));
}

function findDuplicateScriptIds(controllers: EmittedController[], jobs: EmittedJob[]): ControllerProblem[] {
    const problems: ControllerProblem[] = [];
    const scriptOwners = new Map<string, string>();
    const deployOwners = new Map<string, string>();
    const claim = (owners: Map<string, string>, id: string, filePath: string, label: string) => {
        const owner = owners.get(id);
        if (owner !== undefined) problems.push({ filePath, message: `${label} '${id}' is also declared by ${owner}; every controller and every job is its own script.` });
        else owners.set(id, filePath);
    };
    for (const { contract } of controllers) {
        claim(scriptOwners, contract.script.scriptId, contract.filePath, 'scriptId');
        claim(deployOwners, contract.script.deployId, contract.filePath, 'deployId');
    }
    for (const { contract } of jobs) {
        claim(scriptOwners, contract.script.scriptId, contract.filePath, 'scriptId');
        for (const deployment of contract.script.deployments) claim(deployOwners, deployment, contract.filePath, 'deployment');
    }
    return problems;
}

/** Every type declaration a shape can be built from: the file's own, then the ones copied into it. */
function collectDeclarations(own: { name: string; text: string }[], inlinedTypes: InlinedTypeSection[]): Map<string, string> {
    const declarations = new Map<string, string>();
    for (const declaration of own) declarations.set(declaration.name, declaration.text);
    for (const section of inlinedTypes) {
        for (const declaration of section.declarations) if (!declarations.has(declaration.name)) declarations.set(declaration.name, declaration.text);
    }
    return declarations;
}

/**
 * A Date reached from a run's input: it is stored as JSON on the run record, so the stage would
 * receive an ISO string where its annotation promises a Date. The result is not checked, because
 * nothing reads it back as a Date; the browser sees whatever summarize wrote.
 */
function findDatesInJobInput(contract: JobContract, inlinedTypes: InlinedTypeSection[], jobLabel: string): ControllerProblem[] {
    if (contract.inputType === undefined) return [];
    const declarations = collectDeclarations(contract.typeDeclarations, inlinedTypes);
    const visited = new Set<string>();
    const pending: { name: string; via: string }[] = readReferencedNames(contract.inputType, 'type').map((name) => ({ name, via: contract.inputType as string }));
    while (pending.length > 0) {
        const { name, via } = pending.shift() as { name: string; via: string };
        if (name === 'Date') {
            return [{ filePath: jobLabel, message: `getInputData takes a Date in its input (through ${via}); a run carries its input as JSON, so take a string and parse it in the stage.` }];
        }
        const text = declarations.get(name);
        if (text === undefined || visited.has(name)) continue;
        visited.add(name);
        pending.push(...readReferencedNames(text, 'declaration').map((reference) => ({ name: reference, via: name })));
    }
    return [];
}

/**
 * A Date reached from a request shape, through the controller's own declarations and the copied
 * ones: the handler would receive an ISO string where its annotation promises a Date. (A shape taken
 * from a sibling controller is checked where it is declared, as that controller's own request.)
 */
function findDatesInRequestShapes(contract: ControllerContract, inlinedTypes: InlinedTypeSection[], controllerLabel: string): ControllerProblem[] {
    const declarations = collectDeclarations(contract.typeDeclarations, inlinedTypes);
    const problems: ControllerProblem[] = [];
    for (const endpoint of contract.endpoints) {
        if (endpoint.requestType === undefined) continue;
        const visited = new Set<string>();
        const pending: { name: string; via: string }[] = readReferencedNames(endpoint.requestType, 'type').map((name) => ({ name, via: endpoint.requestType as string }));
        while (pending.length > 0) {
            const { name, via } = pending.shift() as { name: string; via: string };
            if (name === 'Date') {
                problems.push({ filePath: controllerLabel, message: `endpoint '${endpoint.name}' takes a Date in its request (through ${via}); JSON carries dates as ISO 8601 strings, so take a string and parse it in the handler.` });
                break;
            }
            const text = declarations.get(name);
            if (text === undefined || visited.has(name)) continue;
            visited.add(name);
            pending.push(...readReferencedNames(text, 'declaration').map((reference) => ({ name: reference, via: name })));
        }
    }
    return problems;
}

/** Every generated file in the output directory that is not one of the given paths. */
function findLeftoverFiles(fileSystem: FileSystemAdapter, outDirectory: string, plannedPaths: string[]): string[] {
    const planned = new Set(plannedPaths.map((filePath) => toPosixPath(nodePath.resolve(filePath))));
    return fileSystem
        .listFiles(outDirectory)
        .filter((filePath) => generatedFileNamePattern.test(nodePath.basename(filePath)) && !planned.has(toPosixPath(nodePath.resolve(filePath))));
}

export function planClientGeneration({ config, fileSystem }: GenerateClientOptions): ClientGenerationPlan {
    const resolve = (relativePath: string) => nodePath.resolve(config.rootDirectory, relativePath);
    const label = (absolutePath: string) => relativeLabel(config.rootDirectory, absolutePath);
    const controllersDirectory = resolve(config.controllers);
    const outDirectory = resolve(config.outDir);
    const problems: ControllerProblem[] = [];

    const controllerFiles = fileSystem.listFiles(controllersDirectory).filter((filePath) => isControllerFileName(nodePath.basename(filePath)));
    if (controllerFiles.length === 0) {
        problems.push({ filePath: label(controllersDirectory), message: 'holds no <name>Controller.ts file.' });
    }
    const controllerNames = new Set(controllerFiles.map((filePath) => nodePath.basename(filePath).replace(/Controller\.ts$/, '')));
    const inlinableFiles = new Map<string, InlinableTypesFile | 'missing'>();
    /** The inlinable file a specifier names, read once; a file that does not exist is reported once and answered as 'missing'. */
    const readInlinable = (specifier: string): InlinableTypesFile | 'missing' | undefined => {
        const known = inlinableFiles.get(specifier);
        if (known !== undefined) return known;
        const relativePath = resolveInlineTypesFile(config.inlineTypes, specifier);
        if (relativePath === undefined) return undefined;
        const filePath = resolve(relativePath);
        let file: InlinableTypesFile | 'missing';
        if (fileSystem.fileExists(filePath)) file = readInlinableTypesFile(label(filePath), fileSystem.readTextFile(filePath));
        else {
            file = 'missing';
            const hint = config.inlineTypes[specifier] !== undefined ? 'run the model generator first.' : `'${specifier}' names it.`;
            problems.push({ filePath: label(filePath), message: `the file to copy types from does not exist; ${hint}` });
        }
        inlinableFiles.set(specifier, file);
        return file;
    };

    const emitted: EmittedController[] = [];
    for (const filePath of controllerFiles) {
        const controllerLabel = label(filePath);
        const result = readControllerContract(controllerLabel, fileSystem.readTextFile(filePath), { typeImports: config.typeImports, inlineTypes: config.inlineTypes });
        problems.push(...result.problems);
        const contract = result.contract;
        if (!contract) continue;
        if (controllerModuleFileName(contract.name) === CLIENT_INDEX_FILE_NAME) {
            problems.push({ filePath: controllerLabel, message: `a controller named '${contract.name}' would take the client's ${CLIENT_INDEX_FILE_NAME}; name it something else.` });
        }
        for (const typeImport of contract.controllerTypeImports) {
            if (!controllerNames.has(typeImport.controllerName)) {
                problems.push({ filePath: controllerLabel, message: `imports types from './${typeImport.controllerName}Controller', which is not a controller in ${label(controllersDirectory)}.` });
            }
        }
        const inlinedTypes: InlinedTypeSection[] = [];
        for (const typeImport of contract.inlinedTypeImports) {
            const file = readInlinable(typeImport.specifier);
            if (!file || file === 'missing') continue;
            const selected = selectInlinedTypes(file, typeImport.names, controllerLabel, readInlinable);
            problems.push(...selected.problems);
            for (const selectedSection of selected.sections) {
                const section = inlinedTypes.find((existing) => existing.sourceLabel === selectedSection.filePath);
                if (section) section.declarations.push(...selectedSection.declarations.filter((declaration) => !section.declarations.some((existing) => existing.name === declaration.name)));
                else inlinedTypes.push({ sourceLabel: selectedSection.filePath, declarations: selectedSection.declarations });
            }
        }
        problems.push(...findDatesInRequestShapes(contract, inlinedTypes, controllerLabel));
        emitted.push({ contract, sourceLabel: controllerLabel, inlinedTypes });
    }
    // Jobs: the same reading, with a run instead of a request and a record instead of a reply. A job is a
    // folder — <name>/<name>.ts declares it and its stage files sit beside it — so the shapes on either end
    // of a run are read wherever the stage that names them lives.
    const jobsDirectory = resolve(config.jobs);
    const emittedJobs: EmittedJob[] = [];

    /** Copies what one type import names into the job's sections, following imports between the files it reaches. */
    function addInlinedTypes(sections: InlinedTypeSection[], typeImport: InlinedTypeImport, fromLabel: string, sink: ControllerProblem[]): void {
        const file = readInlinable(typeImport.specifier);
        if (!file || file === 'missing') return;
        const selected = selectInlinedTypes(file, typeImport.names, fromLabel, readInlinable);
        sink.push(...selected.problems);
        for (const selectedSection of selected.sections) addDeclarations(sections, selectedSection.filePath, selectedSection.declarations);
    }

    /** One section per source file, so a shape copied twice is written once. */
    function addDeclarations(sections: InlinedTypeSection[], sourceLabel: string, declarations: { name: string; text: string }[]): void {
        const section = sections.find((existing) => existing.sourceLabel === sourceLabel);
        if (section) section.declarations.push(...declarations.filter((declaration) => !section.declarations.some((existing) => existing.name === declaration.name)));
        else sections.push({ sourceLabel, declarations: [...declarations] });
    }

    for (const strayPath of fileSystem.listFiles(jobsDirectory)) {
        problems.push({ filePath: label(strayPath), message: 'a job lives in a folder of its own, declared by the file of that name; nothing sits in the jobs folder itself.' });
    }
    for (const jobDirectory of fileSystem.listDirectories(jobsDirectory)) {
        const jobName = readJobFolderName(nodePath.basename(jobDirectory));
        if (jobName === undefined) {
            problems.push({ filePath: label(jobDirectory), message: 'a job folder is named for its job, in camelCase.' });
            continue;
        }
        const definitionPath = nodePath.join(jobDirectory, jobDefinitionFileName(jobName));
        if (!fileSystem.fileExists(definitionPath)) {
            problems.push({ filePath: label(jobDirectory), message: `there is no ${jobDefinitionFileName(jobName)} here; the file of the folder's own name is what declares the job.` });
            continue;
        }
        const jobLabel = label(definitionPath);
        const result = readJobContract(jobLabel, fileSystem.readTextFile(definitionPath), {
            typeImports: config.typeImports,
            inlineTypes: config.inlineTypes,
            readStageFile: (specifier) => {
                const stagePath = `${nodePath.resolve(jobDirectory, specifier)}.ts`;
                return fileSystem.fileExists(stagePath) ? { filePath: label(stagePath), source: fileSystem.readTextFile(stagePath) } : undefined;
            },
        });
        problems.push(...result.problems);
        const contract = result.contract;
        if (!contract) continue;
        if (controllerNames.has(contract.name) && jobModuleFileName(contract.name) === controllerModuleFileName(contract.name)) {
            problems.push({ filePath: jobLabel, message: `a controller is named '${contract.name}' too; their generated modules would be the same file.` });
        }
        const inlinedTypes: InlinedTypeSection[] = [];
        // What the job's own files declare, then whatever they take from a service: both are the run's shapes.
        const inliningProblems: ControllerProblem[] = [];
        for (const folderFile of contract.folderFiles) {
            addDeclarations(inlinedTypes, folderFile.filePath, folderFile.declarations);
            for (const typeImport of folderFile.inlinedTypeImports) addInlinedTypes(inlinedTypes, typeImport, folderFile.filePath, inliningProblems);
        }
        for (const typeImport of contract.inlinedTypeImports) addInlinedTypes(inlinedTypes, typeImport, jobLabel, inliningProblems);
        // The result is the only shape of a run the client is given, so it is the only one that has to be
        // carryable. A stage's working types stay on the server: the items a run is planned into may be built
        // on a carrier's API request or a customer's configuration, and none of that is the client's business.
        const carriedByResult = contract.resultType === undefined
            ? new Set<string>()
            : findTypesReachedBy(contract.resultType, contract.typeDeclarations, inlinedTypes);
        // One mistake, reported once: the message names the file the shape lives in, so which stage file
        // imported it adds nothing, and a shape three stages name would otherwise be reported three times.
        const reportedMessages = new Set<string>();
        for (const problem of inliningProblems) {
            if (problem.about !== undefined && !carriedByResult.has(problem.about)) continue;
            if (reportedMessages.has(problem.message)) continue;
            reportedMessages.add(problem.message);
            problems.push(problem);
        }
        problems.push(...findDatesInJobInput(contract, inlinedTypes, jobLabel));
        emittedJobs.push({ contract, sourceLabel: jobLabel, inlinedTypes });
    }
    if (emittedJobs.length > 0 && config.jobRuns === undefined) {
        problems.push({
            filePath: label(jobsDirectory),
            message: 'the project has jobs but no run record: add the `jobRuns` block to netsuite-api.config.json (`npm run add:jobs` writes it, with the record itself).',
        });
    }
    problems.push(...findDuplicateScriptIds(emitted, emittedJobs));

    const controllers: PlannedController[] = emitted.map(({ contract }) => ({
        name: contract.name,
        filePath: contract.filePath,
        kind: contract.script.kind,
        browser: contract.script.browser,
        endpointCount: contract.endpoints.length,
    }));
    const jobs: PlannedJob[] = emittedJobs.map(({ contract }) => ({
        name: contract.name,
        filePath: contract.filePath,
        stages: contract.stages,
        deploymentCount: contract.script.deployments.length,
    }));
    if (problems.length > 0) return { files: [], leftoverFiles: [], controllers, jobs, problems };

    const controllersLabel = label(controllersDirectory);
    const jobsLabel = label(jobsDirectory);
    const jobRuns: EmittedJobRuns | undefined = config.jobRuns
        ? { recordType: config.jobRuns.recordType, fields: resolveJobRunFieldIds(config.jobRuns), extraFields: config.jobRuns.extraFields ?? {} }
        : undefined;
    const files: PlannedFile[] = [
        ...sortControllers(emitted).map((controller) => ({
            path: nodePath.join(outDirectory, controllerModuleFileName(controller.contract.name)),
            content: emitControllerModule(controller, { clientModule: config.clientModule }),
        })),
        ...sortJobs(emittedJobs).map((job) => ({ path: nodePath.join(outDirectory, jobModuleFileName(job.contract.name)), content: emitJobModule(job) })),
        ...(emittedJobs.length > 0 ? [{ path: nodePath.join(outDirectory, JOBS_INDEX_FILE_NAME), content: emitJobsIndexModule(emittedJobs, { jobsLabel }) }] : []),
        { path: nodePath.join(outDirectory, CLIENT_INDEX_FILE_NAME), content: emitClientIndexModule(emitted, { controllersLabel, hasJobs: emittedJobs.length > 0 }) },
        { path: resolve(config.scriptsOutFile), content: emitScriptsModule(emitted, { wireModule: config.wireModule, controllersLabel, jobs: emittedJobs, jobsLabel, jobRuns }) },
    ];
    const leftoverFiles = findLeftoverFiles(fileSystem, outDirectory, files.map((file) => file.path));
    return { files, leftoverFiles, controllers, jobs, problems };
}

export function runClientGeneration(options: GenerateClientOptions): ClientGenerationResult {
    const plan = planClientGeneration(options);
    const writtenFiles: string[] = [];
    const unchangedFiles: string[] = [];
    const deletedFiles: string[] = [];
    if (plan.problems.length > 0) return { ...plan, writtenFiles, unchangedFiles, deletedFiles };
    const { fileSystem } = options;
    for (const file of plan.files) {
        if (fileSystem.fileExists(file.path) && fileSystem.readTextFile(file.path) === file.content) {
            unchangedFiles.push(file.path);
            continue;
        }
        fileSystem.ensureDirectory(nodePath.dirname(file.path));
        fileSystem.writeTextFile(file.path, file.content);
        writtenFiles.push(file.path);
    }
    for (const filePath of plan.leftoverFiles) {
        fileSystem.deleteFile(filePath);
        deletedFiles.push(filePath);
    }
    return { ...plan, writtenFiles, unchangedFiles, deletedFiles };
}

export function checkClientGeneration(options: GenerateClientOptions): ClientGenerationCheck {
    const plan = planClientGeneration(options);
    const { fileSystem } = options;
    const missingFiles: string[] = [];
    const staleFiles: string[] = [];
    for (const file of plan.files) {
        if (!fileSystem.fileExists(file.path)) missingFiles.push(file.path);
        else if (fileSystem.readTextFile(file.path) !== file.content) staleFiles.push(file.path);
    }
    return { ...plan, missingFiles, staleFiles };
}
