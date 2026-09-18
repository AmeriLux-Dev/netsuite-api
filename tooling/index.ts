/** The generator as a library: what the `netsuite-api` command runs, for a build tool or a test to call directly. */
export { DEFAULT_CONFIG_FILE_NAME, ClientGeneratorConfigError, defaultClientGeneratorConfig, loadClientGeneratorConfig } from './config.js';
export { JOB_RUN_FIELD_SUFFIXES, netsuiteValueTypeNames, resolveJobRunFieldIds } from './config.js';
export type { ClientGeneratorConfig, JobRunFieldName, JobRunsSettings, NetsuiteValueTypeName, ResolvedClientGeneratorConfig } from './config.js';
export { GENERATED_CLIENT_NAME, GENERATED_ENDPOINTS_TYPE_NAME, RAW_RESPONSE_TYPE_NAME, isControllerFileName, readControllerContract, readLeadingJsDoc } from './controllerReader.js';
export type { CarriedTypeImport, ControllerContract, ControllerKind, ControllerProblem, ControllerReadResult, ControllerTypeImport, DeclaredScript, EndpointSignature, InlinedTypeImport, ReadControllerOptions, TypeDeclaration, TypeImportName } from './controllerReader.js';
export { GENERATED_JOB_RESULT_TYPE_NAME, JOB_SCRIPT_TYPE_HEADER, JOB_STAGE_NAMES, isJobFileName, readJobContract } from './jobReader.js';
export type { DeclaredJob, JobContract, JobParameterContract, JobReadResult, JobStageName } from './jobReader.js';
export { readInlinableTypesFile, selectInlinedTypes } from './typesFileReader.js';
export type { InlinableTypeDeclaration, InlinableTypesFile, SelectedInlinedTypes } from './typesFileReader.js';
export { CLIENT_INDEX_FILE_NAME, JOBS_INDEX_FILE_NAME, controllerModuleFileName, emitClientIndexModule, emitControllerModule, emitJobModule, emitJobsIndexModule, emitScriptsModule, jobModuleFileName } from './emit.js';
export type { EmitClientIndexModuleOptions, EmitControllerModuleOptions, EmitScriptsModuleOptions, EmittedController, EmittedJob, EmittedJobRuns, InlinedTypeSection } from './emit.js';
export { checkClientGeneration, planClientGeneration, runClientGeneration } from './generate.js';
export type { ClientGenerationCheck, ClientGenerationPlan, ClientGenerationResult, GenerateClientOptions, PlannedController, PlannedFile, PlannedJob } from './generate.js';
export { createInMemoryFileSystemAdapter, createNodeFileSystemAdapter, toPosixPath } from './file-system.js';
export type { FileSystemAdapter, InMemoryFileSystemAdapter } from './file-system.js';
export { CLI_USAGE, EXIT_PROBLEMS, EXIT_SUCCESS, EXIT_USAGE, runCli } from './cli/main.js';
export type { CliEnvironment } from './cli/main.js';
