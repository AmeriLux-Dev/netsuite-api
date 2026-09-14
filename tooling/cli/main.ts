import * as nodePath from 'node:path';
import { ClientGeneratorConfigError, loadClientGeneratorConfig } from '../config.js';
import type { ResolvedClientGeneratorConfig } from '../config.js';
import { createNodeFileSystemAdapter, toPosixPath } from '../file-system.js';
import type { FileSystemAdapter } from '../file-system.js';
import { checkClientGeneration, planClientGeneration, runClientGeneration } from '../generate.js';
import type { ClientGenerationPlan, GenerateClientOptions } from '../generate.js';
import { parseCommandLineArguments, readFlagOption, readStringOption } from './arguments.js';

export interface CliEnvironment {
    cwd: string;
    fileSystem?: FileSystemAdapter;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
}

export const CLI_USAGE = [
    'Usage: netsuite-api <command> [options]',
    '',
    'Commands:',
    '  generate        Read the controllers and the app file; write the client module, the scripts map and the copied type files.',
    '  check           Exit non-zero when a generated file is missing or out of date.',
    '  help            Show this message.',
    '',
    'Options:',
    '  --config <path>       Config file (default: netsuite-api.config.json in the working directory).',
    '  --dry-run             With generate: print the client module that would be written without writing anything.',
].join('\n');

export const EXIT_SUCCESS = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

const commands = ['generate', 'check'];

function formatProblems(plan: ClientGenerationPlan): string[] {
    return plan.problems.map((problem) => ` - ${problem.filePath}: ${problem.message}`);
}

function relativeTo(cwd: string, filePath: string): string {
    return toPosixPath(nodePath.relative(cwd, filePath)) || filePath;
}

function describeControllers(plan: ClientGenerationPlan): string[] {
    return plan.controllers.map((controller) => ` - ${controller.name} (${controller.kind}): ${controller.endpointCount} endpoint(s)${controller.browser ? '' : ', types only'}`);
}

/** Runs the CLI and resolves to the process exit code. Never throws for user errors. */
export function runCli(argv: string[], environment: CliEnvironment): number {
    const parsed = parseCommandLineArguments(argv);
    const fileSystem = environment.fileSystem ?? createNodeFileSystemAdapter();
    const command = parsed.command ?? 'help';

    if (command === 'help' || readFlagOption(parsed.options, 'help')) {
        environment.stdout(CLI_USAGE);
        return EXIT_SUCCESS;
    }
    if (!commands.includes(command)) {
        environment.stderr(`Unknown command '${command}'.\n\n${CLI_USAGE}`);
        return EXIT_USAGE;
    }

    let config: ResolvedClientGeneratorConfig;
    try {
        config = loadClientGeneratorConfig(fileSystem, environment.cwd, readStringOption(parsed.options, 'config'));
    } catch (error) {
        environment.stderr(error instanceof ClientGeneratorConfigError ? error.message : `Could not load the config: ${error instanceof Error ? error.message : String(error)}`);
        return EXIT_USAGE;
    }
    const options: GenerateClientOptions = { config, fileSystem };
    const failure = (plan: ClientGenerationPlan) => {
        environment.stderr(['The controllers cannot be turned into a client module:', ...formatProblems(plan)].join('\n'));
        return EXIT_PROBLEMS;
    };

    if (command === 'generate') {
        if (readFlagOption(parsed.options, 'dry-run')) {
            const plan = planClientGeneration(options);
            if (plan.problems.length > 0) return failure(plan);
            environment.stdout(plan.files[0].content);
            return EXIT_SUCCESS;
        }
        const result = runClientGeneration(options);
        if (result.problems.length > 0) return failure(result);
        environment.stdout([
            `netsuite-api: ${result.controllers.length} controller(s), ${result.writtenFiles.length} file(s) written, ${result.unchangedFiles.length} unchanged.`,
            ...describeControllers(result),
            ...result.writtenFiles.map((filePath) => ` - wrote ${relativeTo(environment.cwd, filePath)}`),
        ].join('\n'));
        return EXIT_SUCCESS;
    }

    const check = checkClientGeneration(options);
    if (check.problems.length > 0) return failure(check);
    if (check.missingFiles.length > 0 || check.staleFiles.length > 0) {
        environment.stderr([
            'The generated files are not up to date. Run `netsuite-api generate`.',
            ...check.missingFiles.map((filePath) => ` - missing: ${relativeTo(environment.cwd, filePath)}`),
            ...check.staleFiles.map((filePath) => ` - out of date: ${relativeTo(environment.cwd, filePath)}`),
        ].join('\n'));
        return EXIT_PROBLEMS;
    }
    environment.stdout([`Generated files are up to date (${check.files.length} file(s)).`, ...describeControllers(check)].join('\n'));
    return EXIT_SUCCESS;
}
