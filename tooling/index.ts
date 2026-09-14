/** The generator as a library: what the `netsuite-api` command runs, for a build tool or a test to call directly. */
export { DEFAULT_CONFIG_FILE_NAME, ClientGeneratorConfigError, defaultClientGeneratorConfig, loadClientGeneratorConfig } from './config.js';
export type { ClientGeneratorConfig, ResolvedClientGeneratorConfig } from './config.js';
export { GENERATED_CLIENT_NAME, GENERATED_ENDPOINTS_TYPE_NAME, RAW_RESPONSE_TYPE_NAME, isControllerFileName, readControllerContract, readLeadingJsDoc } from './controllerReader.js';
export type { CarriedTypeImport, ControllerContract, ControllerKind, ControllerProblem, ControllerReadResult, ControllerTypeImport, DeclaredScript, EndpointSignature, InlinedTypeImport, ReadControllerOptions, TypeDeclaration, TypeImportName } from './controllerReader.js';
export { readInlinableTypesFile, selectInlinedTypes } from './typesFileReader.js';
export type { InlinableTypeDeclaration, InlinableTypesFile, SelectedInlinedTypes } from './typesFileReader.js';
export { readAppDeclarations } from './appReader.js';
export type { AppDeclarations } from './appReader.js';
export { CLIENT_INDEX_FILE_NAME, controllerModuleFileName, emitAppModule, emitClientIndexModule, emitControllerModule, emitScriptsModule } from './emit.js';
export type { EmitAppModuleOptions, EmitClientIndexModuleOptions, EmitControllerModuleOptions, EmitScriptsModuleOptions, EmittedController, InlinedTypeSection } from './emit.js';
export { checkClientGeneration, planClientGeneration, runClientGeneration } from './generate.js';
export type { ClientGenerationCheck, ClientGenerationPlan, ClientGenerationResult, GenerateClientOptions, PlannedController, PlannedFile } from './generate.js';
export { createInMemoryFileSystemAdapter, createNodeFileSystemAdapter, toPosixPath } from './file-system.js';
export type { FileSystemAdapter, InMemoryFileSystemAdapter } from './file-system.js';
export { CLI_USAGE, EXIT_PROBLEMS, EXIT_SUCCESS, EXIT_USAGE, runCli } from './cli/main.js';
export type { CliEnvironment } from './cli/main.js';
