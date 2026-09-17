import { GENERATED_CLIENT_NAME, GENERATED_ENDPOINTS_TYPE_NAME } from './controllerReader.js';
import type { ControllerContract, DeclaredScript, EndpointSignature, TypeDeclaration, TypeImportName } from './controllerReader.js';
import type { JobRunFieldName } from './config.js';
import { GENERATED_JOB_INPUT_TYPE_NAME, GENERATED_JOB_RESULT_TYPE_NAME } from './jobReader.js';
import type { JobContract } from './jobReader.js';
import { writeDatesAsStrings } from './wireTypes.js';

/**
 * Writes the generated modules. Each controller gets its own client module, `<name>.gen.ts`: the
 * entity and service types it names (copied in, so the module stands on its own), its wire shapes,
 * its endpoint type and, when the browser calls it, its client. The index module re-exports each one as a
 * namespace, so a hook writes `user.api.roles()` and names a shape as `user.RolesResponse`. The
 * scripts module is the server-side map a repository passes to createSuiteletClient.
 *
 * A job gets a module of the same kind, `<name>Job.gen.ts`, holding the shapes on either end of a run
 * (`Input` and `Result`) and nothing callable: a page starts a job through a controller, not directly.
 * They are reached under `jobs` (`jobs.closeStaleOrders.Result`). Server-side, the scripts module
 * carries the jobs as well, and the run record's ids next to them.
 */

/** The declarations copied from one inlined type file. */
export interface InlinedTypeSection {
    /** Where the declarations come from: the file's path relative to the project. */
    sourceLabel: string;
    declarations: TypeDeclaration[];
}

export interface EmittedController {
    contract: ControllerContract;
    /** Where the file's header points a reader: the controller's path relative to the project. */
    sourceLabel: string;
    inlinedTypes: InlinedTypeSection[];
}

export interface EmitControllerModuleOptions {
    clientModule: string;
}

export interface EmitClientIndexModuleOptions {
    /** How the header names the sources: `api/src/controllers`. */
    controllersLabel: string;
    /** True when the project has jobs, so the index re-exports them under `jobs`. */
    hasJobs?: boolean;
}

/** The run record's ids as the scripts module writes them out. */
export interface EmittedJobRuns {
    recordType: string;
    fields: Record<JobRunFieldName, string>;
    extraFields: Record<string, { id: string; type: string }>;
}

export interface EmitScriptsModuleOptions {
    wireModule: string;
    controllersLabel: string;
    /** The jobs to carry alongside the controllers, and where they came from. */
    jobs?: EmittedJob[];
    jobsLabel?: string;
    /** The run record, written out when the project has one. */
    jobRuns?: EmittedJobRuns;
}

/** The index module of the client, next to the controller modules: what a hook imports. */
export const CLIENT_INDEX_FILE_NAME = 'index.gen.ts';

/** The module re-exporting every job module, reached as `jobs` from the client index. */
export const JOBS_INDEX_FILE_NAME = 'jobs.gen.ts';

/** The client module of a controller: `user.gen.ts` for the user controller. */
export function controllerModuleFileName(controllerName: string): string {
    return `${controllerName}.gen.ts`;
}

/** The client module of a job: `closeStaleOrdersJob.gen.ts` for the closeStaleOrders job. */
export function jobModuleFileName(jobName: string): string {
    return `${jobName}Job.gen.ts`;
}

/** A job as the generator writes it out: its contract, and the types copied in with it. */
export interface EmittedJob {
    contract: JobContract;
    /** Where the file's header points a reader: the job's path relative to the project. */
    sourceLabel: string;
    inlinedTypes: InlinedTypeSection[];
}

const INDENT = '    ';
/** What a summarize stage returns when the run has no result to carry; the run record holds null either way. */
const RESULTLESS_TYPE_NAMES = new Set(['void', 'undefined', 'null', 'never']);
const EDIT_NOTICE = 'Do not edit: change the controller and run `npm run generate`.';
const ESLINT_DISABLE = '/* eslint-disable */';

function indentJsDoc(jsDoc: string): string {
    return jsDoc
        .split('\n')
        .map((line, index) => (index === 0 ? `${INDENT}${line.trim()}` : `${INDENT} ${line.trim()}`))
        .join('\n');
}

// A Date on the wire is an ISO string: the client module says so wherever a shape says Date.
function emitEndpointMember(endpoint: EndpointSignature): string {
    const parameter = endpoint.requestType === undefined ? '' : `request${endpoint.requestOptional ? '?' : ''}: ${writeDatesAsStrings(endpoint.requestType, 'type')}`;
    const member = `${INDENT}${endpoint.name}: (${parameter}) => ${writeDatesAsStrings(endpoint.responseType, 'type')};`;
    return endpoint.jsDoc ? `${indentJsDoc(endpoint.jsDoc)}\n${member}` : member;
}

function formatImportName(imported: TypeImportName): string {
    return imported.alias ? `${imported.name} as ${imported.alias}` : imported.name;
}

/** One `import type` per module, names merged and sorted, modules sorted. */
function emitTypeImports(imports: { moduleSpecifier: string; names: TypeImportName[] }[]): string[] {
    const namesByModule = new Map<string, Set<string>>();
    for (const typeImport of imports) {
        const names = namesByModule.get(typeImport.moduleSpecifier) ?? new Set<string>();
        typeImport.names.forEach((imported) => names.add(formatImportName(imported)));
        namesByModule.set(typeImport.moduleSpecifier, names);
    }
    return Array.from(namesByModule.keys())
        .sort()
        .map((moduleSpecifier) => `import type { ${Array.from(namesByModule.get(moduleSpecifier) ?? []).sort().join(', ')} } from '${moduleSpecifier}';`);
}

/** The script reference as a literal, as the controller module and the scripts module write it. */
function emitScriptRef(script: DeclaredScript): string {
    const browser = script.browser ? '' : ', browser: false';
    return `{ kind: '${script.kind}', scriptId: '${script.scriptId}', deployId: '${script.deployId}'${browser} }`;
}

export function emitControllerModule({ contract, sourceLabel, inlinedTypes }: EmittedController, options: EmitControllerModuleOptions): string {
    const browser = contract.script.browser;
    const header = [
        `// Generated by netsuite-api generate from ${sourceLabel}. ${EDIT_NOTICE}`,
        ...(browser ? [] : ['// Called by server code only: its types, and no client.']),
        ESLINT_DISABLE,
    ];
    const imports = [
        ...(browser ? [`import { createApiClient } from '${options.clientModule}';`] : []),
        ...emitTypeImports([
            ...contract.carriedTypeImports,
            ...contract.controllerTypeImports.map((typeImport) => ({ moduleSpecifier: `./${controllerModuleFileName(typeImport.controllerName).replace(/\.ts$/, '')}`, names: typeImport.names })),
        ]),
    ];
    const sections: string[] = [header.join('\n'), imports.join('\n')];
    for (const section of inlinedTypes) {
        sections.push(`// Types from ${section.sourceLabel}, copied so this module stands on its own.`);
        for (const declaration of section.declarations) sections.push(writeDatesAsStrings(declaration.text, 'declaration'));
    }
    for (const declaration of contract.typeDeclarations) sections.push(writeDatesAsStrings(declaration.text, 'declaration'));
    const members = contract.endpoints.map(emitEndpointMember);
    // A type alias, not an interface: only an object type literal satisfies the Endpoints index signature.
    sections.push(`/** The endpoint signatures of the ${contract.name} controller, as its handlers declare them. */\nexport type ${GENERATED_ENDPOINTS_TYPE_NAME} = {\n${members.join('\n')}\n};`);
    if (browser) {
        const rawEndpoints = contract.endpoints.filter((endpoint) => endpoint.raw).map((endpoint) => `'${endpoint.name}'`);
        const clientOptions = rawEndpoints.length > 0 ? `, { rawEndpoints: [${rawEndpoints.join(', ')}] }` : '';
        sections.push(
            `/** One typed function per endpoint of the ${contract.name} controller: \`${contract.name}.${GENERATED_CLIENT_NAME}.${contract.endpoints[0]?.name ?? 'endpoint'}(...)\`. */\n` +
                `export const ${GENERATED_CLIENT_NAME} = createApiClient<${GENERATED_ENDPOINTS_TYPE_NAME}>(${emitScriptRef({ ...contract.script, browser: true })}${clientOptions});`,
        );
    }
    return `${sections.filter((section) => section !== '').join('\n\n')}\n`;
}

export function sortControllers(controllers: EmittedController[]): EmittedController[] {
    return [...controllers].sort((left, right) => left.contract.name.localeCompare(right.contract.name));
}

/** The index module: every controller module re-exported under the controller's name. */
export function emitClientIndexModule(controllers: EmittedController[], options: EmitClientIndexModuleOptions): string {
    const lines = [`// Generated by netsuite-api generate from ${options.controllersLabel}. Do not edit: change the controllers and run \`npm run generate\`.`, ESLINT_DISABLE, ''];
    for (const { contract } of sortControllers(controllers)) {
        const summary = contract.script.browser
            ? `The ${contract.name} controller: its request and response types, and \`${contract.name}.${GENERATED_CLIENT_NAME}\`, one typed function per endpoint.`
            : `The ${contract.name} controller: its request and response types only; server code calls it, the browser does not.`;
        lines.push(`/** ${summary} */`, `export * as ${contract.name} from './${controllerModuleFileName(contract.name).replace(/\.ts$/, '')}';`);
    }
    if (options.hasJobs) {
        lines.push('/** Every job of this application: the shapes a run of each is started with and ends in. */', `export * as jobs from './${JOBS_INDEX_FILE_NAME.replace(/\.ts$/, '')}';`);
    }
    return `${lines.join('\n')}\n`;
}

export function sortJobs(jobs: EmittedJob[]): EmittedJob[] {
    return [...jobs].sort((left, right) => left.contract.name.localeCompare(right.contract.name));
}

/** A job's module: the shapes a run is started with and ends in, and the types they are built from. */
export function emitJobModule({ contract, sourceLabel, inlinedTypes }: EmittedJob): string {
    const declarations: string[] = [];
    for (const section of inlinedTypes) {
        declarations.push(`// Types from ${section.sourceLabel}, copied so this module stands on its own.`);
        for (const declaration of section.declarations) declarations.push(writeDatesAsStrings(declaration.text, 'declaration'));
    }
    for (const declaration of contract.typeDeclarations) declarations.push(writeDatesAsStrings(declaration.text, 'declaration'));
    const inputType = contract.inputType === undefined ? 'void' : writeDatesAsStrings(contract.inputType, 'type');
    // A job that answers nothing has no summarize, or one that returns nothing: either way the run's result is null,
    // which is what the record holds and what the page reads back.
    const resultType = contract.resultType === undefined || RESULTLESS_TYPE_NAMES.has(contract.resultType.trim()) ? 'null' : writeDatesAsStrings(contract.resultType, 'type');
    // A job's stages name package types the run's shapes do not (JobSummary on summarize), and those are
    // server-side: only an import a shape actually reaches is carried over.
    const emittedText = [...declarations, inputType, resultType].join('\n');
    const usedTypeImports = contract.carriedTypeImports
        .map((typeImport) => ({ ...typeImport, names: typeImport.names.filter((imported) => new RegExp(`\\b${imported.alias ?? imported.name}\\b`).test(emittedText)) }))
        .filter((typeImport) => typeImport.names.length > 0);
    const sections: string[] = [
        [
            `// Generated by netsuite-api generate from ${sourceLabel}. Do not edit: change the job and run \`npm run generate\`.`,
            '// A job is started through a controller, so this module carries its types and nothing callable.',
            ESLINT_DISABLE,
        ].join('\n'),
        emitTypeImports(usedTypeImports).join('\n'),
        ...declarations,
    ];
    sections.push(`/** What a run of the ${contract.name} job is started with. */\nexport type ${GENERATED_JOB_INPUT_TYPE_NAME} = ${inputType};`);
    sections.push(`/** What a finished run of the ${contract.name} job carries as its result. */\nexport type ${GENERATED_JOB_RESULT_TYPE_NAME} = ${resultType};`);
    return `${sections.filter((section) => section !== '').join('\n\n')}\n`;
}

/** The jobs index: every job module under the job's name, reached as `jobs.<name>` from the client index. */
export function emitJobsIndexModule(jobs: EmittedJob[], options: { jobsLabel: string }): string {
    const lines = [`// Generated by netsuite-api generate from ${options.jobsLabel}. Do not edit: change the jobs and run \`npm run generate\`.`, ESLINT_DISABLE, ''];
    for (const { contract } of sortJobs(jobs)) {
        lines.push(`/** The ${contract.name} job: the shapes a run of it is started with and ends in. */`, `export * as ${contract.name} from './${jobModuleFileName(contract.name).replace(/\.ts$/, '')}';`);
    }
    return `${lines.join('\n')}\n`;
}

/** The job reference as the scripts module writes it: what startJob submits. */
function emitJobRef(contract: JobContract): string {
    const { scriptId, deployments, runParameter, parameters } = contract.script;
    const deploymentList = deployments.map((deployment) => `'${deployment}'`).join(', ');
    const parameterEntries = parameters.map((parameter) => `${parameter.name}: '${parameter.id}'`).join(', ');
    const parameterProperty = parameters.length > 0 ? `, parameters: { ${parameterEntries} }` : '';
    return `{ kind: 'mapreduce', name: '${contract.name}', scriptId: '${scriptId}', deployments: [${deploymentList}], runParameter: '${runParameter}'${parameterProperty} }`;
}

function emitJobRunsConfig(jobRuns: EmittedJobRuns): string[] {
    const fieldEntries = Object.entries(jobRuns.fields).map(([name, id]) => `${INDENT}${INDENT}${name}: '${id}',`);
    const extraEntries = Object.entries(jobRuns.extraFields).map(([name, field]) => `${INDENT}${INDENT}${name}: { id: '${field.id}', type: '${field.type}' },`);
    return [
        '/** The run record this application deployed: what a job and the run store read and write a run through. */',
        'export const jobRuns = {',
        `${INDENT}recordType: '${jobRuns.recordType}',`,
        `${INDENT}fields: {`,
        ...fieldEntries,
        `${INDENT}},`,
        ...(extraEntries.length > 0 ? [`${INDENT}extraFields: {`, ...extraEntries, `${INDENT}},`] : [`${INDENT}extraFields: {},`]),
        '} as const satisfies JobRunsConfig;',
    ];
}

export function emitScriptsModule(controllers: EmittedController[], options: EmitScriptsModuleOptions): string {
    const ordered = sortControllers(controllers);
    const entries = ordered.map(({ contract }) => `${INDENT}${contract.name}: ${emitScriptRef(contract.script)},`);
    const jobs = sortJobs(options.jobs ?? []);
    const importedTypes = ['ScriptRef', ...(jobs.length > 0 ? ['JobRef'] : []), ...(options.jobRuns ? ['JobRunsConfig'] : [])].sort();
    const sourceLabels = [options.controllersLabel, ...(jobs.length > 0 && options.jobsLabel ? [options.jobsLabel] : [])].join(' and ');
    return [
        `// Generated by netsuite-api generate from ${sourceLabels}. ${EDIT_NOTICE}`,
        ESLINT_DISABLE,
        '',
        `import type { ${importedTypes.join(', ')} } from '${options.wireModule}';`,
        '',
        '/** Every script the controllers declare, by controller name: what a repository passes to createSuiteletClient. */',
        'export const scripts = {',
        ...entries,
        '} as const satisfies Record<string, ScriptRef>;',
        ...(jobs.length > 0
            ? [
                  '',
                  '/** Every job, by name: what a repository passes to the run store to start one. */',
                  'export const jobs = {',
                  ...jobs.map(({ contract }) => `${INDENT}${contract.name}: ${emitJobRef(contract)},`),
                  '} as const satisfies Record<string, JobRef>;',
              ]
            : []),
        ...(options.jobRuns ? ['', ...emitJobRunsConfig(options.jobRuns)] : []),
        '',
    ].join('\n');
}
