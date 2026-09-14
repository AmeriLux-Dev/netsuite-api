/** The generator as a library: what the `netsuite-api` command runs, for a build tool or a test to call directly. */
export { DEFAULT_CONFIG_FILE_NAME, ClientGeneratorConfigError, defaultClientGeneratorConfig, loadClientGeneratorConfig } from './config.js';
export type { ClientGeneratorConfig, ResolvedClientGeneratorConfig } from './config.js';
export { isControllerFileName, readControllerContract, toPascalCase } from './controllerReader.js';
export type { CarriedTypeImport, ControllerContract, ControllerProblem, ControllerReadResult, EndpointSignature, ReadControllerOptions, TypeDeclaration } from './controllerReader.js';
export { readScriptRegistry } from './scriptsReader.js';
export type { ScriptRegistryEntry, ScriptRegistryReadResult } from './scriptsReader.js';
export { emitClientModule, toEmittedController } from './emit.js';
export type { EmitClientModuleOptions, EmittedController } from './emit.js';
export { checkClientGeneration, planClientGeneration, runClientGeneration } from './generate.js';
export type { ClientGenerationCheck, ClientGenerationPlan, ClientGenerationResult, ClientGenerationStatus, GenerateClientOptions, PlannedController } from './generate.js';
export { createInMemoryFileSystemAdapter, createNodeFileSystemAdapter, toPosixPath } from './file-system.js';
export type { FileSystemAdapter, InMemoryFileSystemAdapter } from './file-system.js';
export { CLI_USAGE, EXIT_PROBLEMS, EXIT_SUCCESS, EXIT_USAGE, runCli } from './cli/main.js';
export type { CliEnvironment } from './cli/main.js';
