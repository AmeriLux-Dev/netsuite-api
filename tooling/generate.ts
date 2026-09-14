import * as nodePath from 'node:path';
import { readAppDeclarations } from './appReader.js';
import type { ResolvedClientGeneratorConfig } from './config.js';
import { isControllerFileName, readControllerContract } from './controllerReader.js';
import type { ControllerProblem } from './controllerReader.js';
import { emitAppModule, emitClientModule, emitScriptsModule } from './emit.js';
import type { EmittedController } from './emit.js';
import { toPosixPath } from './file-system.js';
import type { FileSystemAdapter } from './file-system.js';

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
    /** The modules to write and the files to copy; empty when there are problems. */
    files: PlannedFile[];
    controllers: PlannedController[];
    problems: ControllerProblem[];
}

export interface ClientGenerationResult extends ClientGenerationPlan {
    writtenFiles: string[];
    unchangedFiles: string[];
}

export interface ClientGenerationCheck extends ClientGenerationPlan {
    missingFiles: string[];
    staleFiles: string[];
}

function relativeLabel(rootDirectory: string, filePath: string): string {
    return toPosixPath(nodePath.relative(rootDirectory, filePath));
}

function findDuplicateNames(controllers: EmittedController[]): ControllerProblem[] {
    const owners = new Map<string, string>();
    const problems: ControllerProblem[] = [];
    const claim = (name: string, filePath: string, what: string) => {
        const owner = owners.get(name);
        if (owner !== undefined && owner !== filePath) {
            problems.push({ filePath, message: `${what} '${name}' is also declared by ${owner}; the generated module holds every controller, so names are unique across them.` });
        } else {
            owners.set(name, filePath);
        }
    };
    for (const { contract } of controllers) {
        for (const declaration of contract.typeDeclarations) claim(declaration.name, contract.filePath, 'type');
        claim(contract.endpointsTypeName, contract.filePath, 'type');
        claim(contract.clientName, contract.filePath, 'client');
    }
    return problems;
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

export function planClientGeneration({ config, fileSystem }: GenerateClientOptions): ClientGenerationPlan {
    const resolve = (relativePath: string) => nodePath.resolve(config.rootDirectory, relativePath);
    const label = (absolutePath: string) => relativeLabel(config.rootDirectory, absolutePath);
    const controllersDirectory = resolve(config.controllers);
    const appFile = resolve(config.appFile);
    const problems: ControllerProblem[] = [];

    const controllerFiles = fileSystem.listFiles(controllersDirectory).filter((filePath) => isControllerFileName(nodePath.basename(filePath)));
    if (controllerFiles.length === 0) {
        problems.push({ filePath: label(controllersDirectory), message: 'holds no <name>Controller.ts file.' });
    }
    const emitted: EmittedController[] = [];
    for (const filePath of controllerFiles) {
        const result = readControllerContract(label(filePath), fileSystem.readTextFile(filePath), { typeImports: config.typeImports });
        problems.push(...result.problems);
        if (result.contract) emitted.push({ contract: result.contract, sourceLabel: label(filePath) });
    }
    problems.push(...findDuplicateNames(emitted), ...findDuplicateScriptIds(emitted));

    let appDeclarations: string[] = [];
    if (fileSystem.fileExists(appFile)) {
        const app = readAppDeclarations(label(appFile), fileSystem.readTextFile(appFile));
        problems.push(...app.problems);
        appDeclarations = app.declarations;
    } else {
        problems.push({ filePath: label(appFile), message: 'the app file does not exist.' });
    }

    const copies: PlannedFile[] = [];
    for (const [source, destination] of Object.entries(config.copyFiles)) {
        const sourcePath = resolve(source);
        if (!fileSystem.fileExists(sourcePath)) {
            problems.push({ filePath: label(sourcePath), message: 'the file to copy into the client does not exist; run the model generator first.' });
            continue;
        }
        copies.push({ path: resolve(destination), content: fileSystem.readTextFile(sourcePath) });
    }

    const controllers: PlannedController[] = emitted.map(({ contract }) => ({
        name: contract.name,
        filePath: contract.filePath,
        kind: contract.script.kind,
        browser: contract.script.browser,
        endpointCount: contract.endpoints.length,
    }));
    if (problems.length > 0) return { files: [], controllers, problems };

    const controllersLabel = label(controllersDirectory);
    const files: PlannedFile[] = [
        { path: resolve(config.outFile), content: emitClientModule(emitted, { clientModule: config.clientModule, controllersLabel }) },
        { path: resolve(config.appOutFile), content: emitAppModule(appDeclarations, { appLabel: label(appFile) }) },
        { path: resolve(config.scriptsOutFile), content: emitScriptsModule(emitted, { wireModule: config.wireModule, controllersLabel }) },
        ...copies,
    ];
    return { files, controllers, problems };
}

export function runClientGeneration(options: GenerateClientOptions): ClientGenerationResult {
    const plan = planClientGeneration(options);
    const writtenFiles: string[] = [];
    const unchangedFiles: string[] = [];
    if (plan.problems.length > 0) return { ...plan, writtenFiles, unchangedFiles };
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
    return { ...plan, writtenFiles, unchangedFiles };
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
