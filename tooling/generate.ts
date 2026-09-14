import * as nodePath from 'node:path';
import type { ResolvedClientGeneratorConfig } from './config.js';
import { isControllerFileName, readControllerContract } from './controllerReader.js';
import type { ControllerContract, ControllerProblem } from './controllerReader.js';
import { emitClientModule, toEmittedController } from './emit.js';
import type { EmittedController } from './emit.js';
import { toPosixPath } from './file-system.js';
import type { FileSystemAdapter } from './file-system.js';
import { readScriptRegistry } from './scriptsReader.js';

export interface GenerateClientOptions {
    config: ResolvedClientGeneratorConfig;
    fileSystem: FileSystemAdapter;
}

export interface PlannedController {
    name: string;
    filePath: string;
    browser: boolean;
    endpointCount: number;
}

export interface ClientGenerationPlan {
    /** Absolute path of the module to write. */
    outFile: string;
    /** The module's content; empty when there are problems. */
    content: string;
    controllers: PlannedController[];
    problems: ControllerProblem[];
}

export interface ClientGenerationResult extends ClientGenerationPlan {
    /** True when the file was written; false when it already had this content or there were problems. */
    written: boolean;
}

export type ClientGenerationStatus = 'current' | 'missing' | 'stale';

export interface ClientGenerationCheck extends ClientGenerationPlan {
    status: ClientGenerationStatus;
}

function relativeLabel(rootDirectory: string, filePath: string): string {
    // The project root is one level above the client workspace that holds the config.
    return toPosixPath(nodePath.relative(nodePath.resolve(rootDirectory, '..'), filePath));
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

export function planClientGeneration({ config, fileSystem }: GenerateClientOptions): ClientGenerationPlan {
    const controllersDirectory = nodePath.resolve(config.rootDirectory, config.controllers);
    const scriptsFile = nodePath.resolve(config.rootDirectory, config.scriptsFile);
    const outFile = nodePath.resolve(config.rootDirectory, config.outFile);
    const problems: ControllerProblem[] = [];

    if (!fileSystem.fileExists(scriptsFile)) {
        return { outFile, content: '', controllers: [], problems: [{ filePath: scriptsFile, message: 'the scripts file does not exist.' }] };
    }
    const registry = readScriptRegistry(relativeLabel(config.rootDirectory, scriptsFile), fileSystem.readTextFile(scriptsFile));
    problems.push(...registry.problems);

    const controllerFiles = fileSystem.listFiles(controllersDirectory).filter((filePath) => isControllerFileName(nodePath.basename(filePath)));
    if (controllerFiles.length === 0) {
        problems.push({ filePath: relativeLabel(config.rootDirectory, controllersDirectory), message: 'holds no <name>Controller.ts file.' });
    }
    const emitted: EmittedController[] = [];
    for (const filePath of controllerFiles) {
        const label = relativeLabel(config.rootDirectory, filePath);
        const result = readControllerContract(label, fileSystem.readTextFile(filePath), { carriedTypeImports: config.carriedTypeImports });
        problems.push(...result.problems);
        const contract: ControllerContract | undefined = result.contract;
        if (!contract) continue;
        const entry = registry.entries.get(contract.name);
        if (!entry) {
            problems.push({ filePath: label, message: `has no scripts.${contract.name} entry in ${relativeLabel(config.rootDirectory, scriptsFile)}.` });
            continue;
        }
        emitted.push(toEmittedController(contract, entry, label));
    }
    problems.push(...findDuplicateNames(emitted));

    const controllers: PlannedController[] = emitted.map(({ contract, browser }) => ({ name: contract.name, filePath: contract.filePath, browser, endpointCount: contract.endpoints.length }));
    if (problems.length > 0) return { outFile, content: '', controllers, problems };
    const content = emitClientModule(emitted, {
        clientModule: config.clientModule,
        scriptsModule: config.scriptsModule,
        controllersLabel: relativeLabel(config.rootDirectory, controllersDirectory),
    });
    return { outFile, content, controllers, problems };
}

export function runClientGeneration(options: GenerateClientOptions): ClientGenerationResult {
    const plan = planClientGeneration(options);
    if (plan.problems.length > 0) return { ...plan, written: false };
    const { fileSystem } = options;
    if (fileSystem.fileExists(plan.outFile) && fileSystem.readTextFile(plan.outFile) === plan.content) return { ...plan, written: false };
    fileSystem.ensureDirectory(nodePath.dirname(plan.outFile));
    fileSystem.writeTextFile(plan.outFile, plan.content);
    return { ...plan, written: true };
}

export function checkClientGeneration(options: GenerateClientOptions): ClientGenerationCheck {
    const plan = planClientGeneration(options);
    const { fileSystem } = options;
    if (!fileSystem.fileExists(plan.outFile)) return { ...plan, status: 'missing' };
    return { ...plan, status: fileSystem.readTextFile(plan.outFile) === plan.content ? 'current' : 'stale' };
}
