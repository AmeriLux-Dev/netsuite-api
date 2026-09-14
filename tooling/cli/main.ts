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
    '  generate        Read the controllers and write the client module: every wire shape, every endpoint interface, one client per browser-facing controller.',
    '  check           Exit non-zero when the client module is missing or out of date.',
    '  help            Show this message.',
    '',
    'Options:',
    '  --config <path>       Config file (default: netsuite-api.config.json in the working directory).',
    '  --dry-run             With generate: print the module that would be written without writing it.',
].join('\n');

export const EXIT_SUCCESS = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

const commands = ['generate', 'check'];

function formatProblems(plan: ClientGenerationPlan): string[] {
    return plan.problems.map((problem) => ` - ${problem.filePath}: ${problem.message}`);
}

function describeControllers(plan: ClientGenerationPlan, cwd: string): string {
    const outFile = toPosixPath(nodePath.relative(cwd, plan.outFile)) || plan.outFile;
    const lines = plan.controllers.map((controller) => ` - ${controller.name}: ${controller.endpointCount} endpoint(s)${controller.browser ? '' : ', types only'}`);
    return [`${outFile}: ${plan.controllers.length} controller(s)`, ...lines].join('\n');
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

    if (command === 'generate') {
        if (readFlagOption(parsed.options, 'dry-run')) {
            const plan = planClientGeneration(options);
            if (plan.problems.length > 0) {
                environment.stderr(['The controllers cannot be turned into a client module:', ...formatProblems(plan)].join('\n'));
                return EXIT_PROBLEMS;
            }
            environment.stdout(plan.content);
            return EXIT_SUCCESS;
        }
        const result = runClientGeneration(options);
        if (result.problems.length > 0) {
            environment.stderr(['The controllers cannot be turned into a client module:', ...formatProblems(result)].join('\n'));
            return EXIT_PROBLEMS;
        }
        environment.stdout(`${result.written ? 'Wrote' : 'Unchanged'} ${describeControllers(result, environment.cwd)}`);
        return EXIT_SUCCESS;
    }

    const check = checkClientGeneration(options);
    if (check.problems.length > 0) {
        environment.stderr(['The controllers cannot be turned into a client module:', ...formatProblems(check)].join('\n'));
        return EXIT_PROBLEMS;
    }
    if (check.status !== 'current') {
        environment.stderr(`The client module is ${check.status === 'missing' ? 'missing' : 'out of date'}. Run \`netsuite-api generate\`.`);
        return EXIT_PROBLEMS;
    }
    environment.stdout(`Up to date: ${describeControllers(check, environment.cwd)}`);
    return EXIT_SUCCESS;
}
