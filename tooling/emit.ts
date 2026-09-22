import { GENERATED_CLIENT_NAME, GENERATED_CLIENT_TYPE_IMPORT_NAMES } from './controllerReader.js';
import type { ControllerContract, DeclaredScript, EndpointSignature, TypeDeclaration, TypeImportName } from './controllerReader.js';
import type { JobRunFieldName } from './config.js';
import { GENERATED_JOB_RESULT_TYPE_NAME } from './jobReader.js';
import type { JobContract } from './jobReader.js';
import { readReferencedNames, writeDatesAsStrings } from './wireTypes.js';

/**
 * Writes the generated modules. Each controller gets its own client module, `<name>.gen.ts`: the
 * entity and service types it names (copied in, so the module stands on its own), its wire shapes
 * and, when the browser calls it, its client: one function per endpoint, each a call to callEndpoint
 * (callRawEndpoint for a document) with the controller's script. The index module re-exports each one as a
 * namespace, so a hook writes `user.api.roles()` and names a shape as `user.RolesResponse`. The
 * scripts module is the server-side map a repository passes to createSuiteletClient.
 *
 * A job gets a module of the same kind, `<name>Job.gen.ts`, holding the shape a finished run carries
 * (`Result`) and nothing callable: a page starts a job through a controller, not directly, and a run's
 * input is the service's own type, named where the run is started rather than in the browser.
 * They are reached under `jobs` (`jobs.closeStaleOrders.Result`). Server-side, the scripts module
 * carries the run record's ids; a job's own ids are written by hand in netsuite.ts.
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
    /** The run record, written out when the project has one. A job's own ids are not here: they are written by hand in netsuite.ts. */
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

/**
 * One endpoint as a function of the client: the request (when the handler takes one) and the call
 * options, posted to the controller's script. A document endpoint resolves to a Blob; any other to
 * what its handler returns, with a Date written as the ISO string it arrives as.
 */
function emitClientMethod(endpoint: EndpointSignature, scriptRefName: string): string {
    const responseType = endpoint.raw ? 'Blob' : writeDatesAsStrings(endpoint.responseType, 'type');
    const requestParameters = endpoint.requestType === undefined ? [] : [`request${endpoint.requestOptional ? '?' : ''}: ${writeDatesAsStrings(endpoint.requestType, 'type')}`];
    const parameters = [...requestParameters, 'options?: ApiCallOptions'].join(', ');
    // A handler without a request still gets a body: the endpoint name alone.
    const request = endpoint.requestType === undefined ? '{}' : 'request';
    const call = endpoint.raw
        ? `callRawEndpoint(${scriptRefName}, '${endpoint.name}', ${request}, options)`
        : `callEndpoint<${responseType}>(${scriptRefName}, '${endpoint.name}', ${request}, options)`;
    const member = `${INDENT}${endpoint.name}: (${parameters}): Promise<${responseType}> => ${call},`;
    return endpoint.jsDoc ? `${indentJsDoc(endpoint.jsDoc)}\n${member}` : member;
}

/** The client of a browser-facing controller: its script, then one function per endpoint posting to it. */
function emitControllerClient(contract: ControllerContract): string[] {
    if (contract.endpoints.length === 0) {
        return [`/** The ${contract.name} controller declares no endpoints yet, so its client has nothing to call. */\nexport const ${GENERATED_CLIENT_NAME} = {};`];
    }
    const scriptRefName = `${contract.name}ScriptRef`;
    const methods = contract.endpoints.map((endpoint) => emitClientMethod(endpoint, scriptRefName));
    return [
        `/** The script the ${contract.name} controller declares: every call below posts to it. */\nconst ${scriptRefName}: ScriptRef = ${emitScriptRef({ ...contract.script, browser: true })};`,
        `/** One function per endpoint of the ${contract.name} controller: \`${contract.name}.${GENERATED_CLIENT_NAME}.${contract.endpoints[0].name}(...)\`. */\n` +
            `export const ${GENERATED_CLIENT_NAME} = {\n${methods.join('\n')}\n};`,
    ];
}

/** The package's call functions the client uses: callRawEndpoint only when an endpoint answers with a document. */
function emitClientImport(contract: ControllerContract, clientModule: string): string[] {
    const calls = new Set(contract.endpoints.map((endpoint) => (endpoint.raw ? 'callRawEndpoint' : 'callEndpoint')));
    return calls.size === 0 ? [] : [`import { ${Array.from(calls).sort().join(', ')} } from '${clientModule}';`];
}

/**
 * The imports whose names the emitted code refers to: a type only a handler's signature named (RawResponse) is left
 * behind. The names are read from the syntax tree, so a type a comment mentions does not count as used.
 */
function keepReferencedTypeImports<TTypeImport extends { names: TypeImportName[] }>(typeImports: TTypeImport[], referencedNames: ReadonlySet<string>): TTypeImport[] {
    return typeImports
        .map((typeImport) => ({ ...typeImport, names: typeImport.names.filter((imported) => referencedNames.has(imported.alias ?? imported.name)) }))
        .filter((typeImport) => typeImport.names.length > 0);
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
    const declarations: string[] = [];
    for (const section of inlinedTypes) {
        declarations.push(`// Types from ${section.sourceLabel}, copied so this module stands on its own.`);
        for (const declaration of section.declarations) declarations.push(writeDatesAsStrings(declaration.text, 'declaration'));
    }
    for (const declaration of contract.typeDeclarations) declarations.push(writeDatesAsStrings(declaration.text, 'declaration'));
    const client = browser ? emitControllerClient(contract) : [];
    // Only what the module names is imported: the project compiles with noUnusedLocals, and a handler's
    // types reach the module only through the client's signatures, which a server-only module does not have.
    const typeImports = keepReferencedTypeImports(
        [
            ...(browser ? [{ moduleSpecifier: options.clientModule, names: GENERATED_CLIENT_TYPE_IMPORT_NAMES.map((name) => ({ name })) }] : []),
            ...contract.carriedTypeImports,
            ...contract.controllerTypeImports.map((typeImport) => ({ moduleSpecifier: `./${controllerModuleFileName(typeImport.controllerName).replace(/\.ts$/, '')}`, names: typeImport.names })),
        ],
        new Set(readReferencedNames([...declarations, ...client].join('\n\n'), 'declaration')),
    );
    const imports = [...(browser ? emitClientImport(contract, options.clientModule) : []), ...emitTypeImports(typeImports)];
    const sections: string[] = [header.join('\n'), imports.join('\n'), ...declarations, ...client];
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
    // A job that answers nothing has no summarize, or one that returns nothing: either way the run's result is null,
    // which is what the record holds and what the page reads back.
    const resultType = contract.resultType === undefined || RESULTLESS_TYPE_NAMES.has(contract.resultType.trim()) ? 'null' : writeDatesAsStrings(contract.resultType, 'type');
    // Only what the result names, because that is all this module declares: the shape a run is started with is
    // the service's, named where the run is started, and a stage's own item types never leave the server.
    const carried = findTypesReachedBy(resultType, contract.typeDeclarations, inlinedTypes);
    const declarations: string[] = [];
    for (const section of inlinedTypes) {
        const kept = section.declarations.filter((declaration) => carried.has(declaration.name));
        if (kept.length === 0) continue;
        declarations.push(`// Types from ${section.sourceLabel}, copied so this module stands on its own.`);
        for (const declaration of kept) declarations.push(writeDatesAsStrings(declaration.text, 'declaration'));
    }
    for (const declaration of contract.typeDeclarations) {
        if (carried.has(declaration.name)) declarations.push(writeDatesAsStrings(declaration.text, 'declaration'));
    }
    // A job's stages name package types the result does not (JobSummary on summarize), and those are
    // server-side: only an import a shape actually reaches is carried over.
    const usedTypeImports = keepReferencedTypeImports(
        contract.carriedTypeImports,
        new Set([...readReferencedNames(declarations.join('\n\n'), 'declaration'), ...readReferencedNames(resultType, 'type')]),
    );
    const sections: string[] = [
        [
            `// Generated by netsuite-api generate from ${sourceLabel}. Do not edit: change the job and run \`npm run generate\`.`,
            '// A job is started through a controller, so this module carries its types and nothing callable.',
            ESLINT_DISABLE,
        ].join('\n'),
        emitTypeImports(usedTypeImports).join('\n'),
        ...declarations,
    ];
    sections.push(`/** What a finished run of the ${contract.name} job carries as its result. */\nexport type ${GENERATED_JOB_RESULT_TYPE_NAME} = ${resultType};`);
    return `${sections.filter((section) => section !== '').join('\n\n')}\n`;
}

/**
 * The declared shapes a type names, and the shapes those name in turn: what a module has to carry for the
 * type to stand on its own. A name with no declaration here belongs to the package or to the language, and
 * the type import that brought it is what carries it.
 *
 * Every name the walk reaches is in the answer, including one nothing declares: a caller asking whether a
 * type matters to the wire needs the names that could not be resolved as much as the ones that could. What
 * is emitted is filtered against declarations, so the unresolved names add nothing to a module.
 */
export function findTypesReachedBy(type: string, ownDeclarations: TypeDeclaration[], inlinedTypes: InlinedTypeSection[]): Set<string> {
    const declarationsByName = new Map<string, string>();
    for (const section of inlinedTypes) for (const declaration of section.declarations) declarationsByName.set(declaration.name, declaration.text);
    for (const declaration of ownDeclarations) declarationsByName.set(declaration.name, declaration.text);
    const carried = new Set<string>();
    const pending = readReferencedNames(type, 'type');
    while (pending.length > 0) {
        const name = pending.shift() as string;
        if (carried.has(name)) continue;
        carried.add(name);
        const text = declarationsByName.get(name);
        if (text === undefined) continue;
        pending.push(...readReferencedNames(text, 'declaration'));
    }
    return carried;
}

/** The jobs index: every job module under the job's name, reached as `jobs.<name>` from the client index. */
export function emitJobsIndexModule(jobs: EmittedJob[], options: { jobsLabel: string }): string {
    const lines = [`// Generated by netsuite-api generate from ${options.jobsLabel}. Do not edit: change the jobs and run \`npm run generate\`.`, ESLINT_DISABLE, ''];
    for (const { contract } of sortJobs(jobs)) {
        lines.push(`/** The ${contract.name} job: the shape a finished run of it carries. */`, `export * as ${contract.name} from './${jobModuleFileName(contract.name).replace(/\.ts$/, '')}';`);
    }
    return `${lines.join('\n')}\n`;
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
    const importedTypes = ['ScriptRef', ...(options.jobRuns ? ['JobRunsConfig'] : [])].sort();
    const sourceLabels = options.controllersLabel;
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
        ...(options.jobRuns ? ['', ...emitJobRunsConfig(options.jobRuns)] : []),
        '',
    ].join('\n');
}
