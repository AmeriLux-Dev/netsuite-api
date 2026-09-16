import * as nodePath from 'node:path';
import { resolveInlineTypesFile } from './config.js';
import type { ResolvedClientGeneratorConfig } from './config.js';
import { isControllerFileName, readControllerContract } from './controllerReader.js';
import type { ControllerProblem } from './controllerReader.js';
import { CLIENT_INDEX_FILE_NAME, controllerModuleFileName, emitClientIndexModule, emitControllerModule, emitScriptsModule, sortControllers } from './emit.js';
import type { EmittedController, InlinedTypeSection } from './emit.js';
import { toPosixPath } from './file-system.js';
import type { FileSystemAdapter } from './file-system.js';
import { readInlinableTypesFile, selectInlinedTypes } from './typesFileReader.js';
import type { InlinableTypesFile } from './typesFileReader.js';

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

export interface PlannedFile {
    /** Absolute path. */
    path: string;
    content: string;
}

export interface ClientGenerationPlan {
    /** The modules to write: one per controller, the client index, the scripts map; empty when there are problems. */
    files: PlannedFile[];
    /** Generated files in the client's output directory the plan does not write: a removed controller's module, or the copy of the entity types an earlier version made. Absolute paths. */
    leftoverFiles: string[];
    controllers: PlannedController[];
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

function findDuplicateScriptIds(controllers: EmittedController[]): ControllerProblem[] {
    const problems: ControllerProblem[] = [];
    for (const property of ['scriptId', 'deployId'] as const) {
        const owners = new Map<string, string>();
        for (const { contract } of controllers) {
            const id = contract.script[property];
            const owner = owners.get(id);
            if (owner !== undefined) problems.push({ filePath: contract.filePath, message: `${property} '${id}' is also declared by ${owner}; every controller is its own script.` });
            else owners.set(id, contract.filePath);
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
        emitted.push({ contract, sourceLabel: controllerLabel, inlinedTypes });
    }
    problems.push(...findDuplicateScriptIds(emitted));

    const controllers: PlannedController[] = emitted.map(({ contract }) => ({
        name: contract.name,
        filePath: contract.filePath,
        kind: contract.script.kind,
        browser: contract.script.browser,
        endpointCount: contract.endpoints.length,
    }));
    if (problems.length > 0) return { files: [], leftoverFiles: [], controllers, problems };

    const controllersLabel = label(controllersDirectory);
    const files: PlannedFile[] = [
        ...sortControllers(emitted).map((controller) => ({
            path: nodePath.join(outDirectory, controllerModuleFileName(controller.contract.name)),
            content: emitControllerModule(controller, { clientModule: config.clientModule }),
        })),
        { path: nodePath.join(outDirectory, CLIENT_INDEX_FILE_NAME), content: emitClientIndexModule(emitted, { controllersLabel }) },
        { path: resolve(config.scriptsOutFile), content: emitScriptsModule(emitted, { wireModule: config.wireModule, controllersLabel }) },
    ];
    const leftoverFiles = findLeftoverFiles(fileSystem, outDirectory, files.map((file) => file.path));
    return { files, leftoverFiles, controllers, problems };
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
