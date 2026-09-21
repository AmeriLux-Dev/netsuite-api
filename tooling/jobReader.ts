import * as nodePath from 'node:path';
import ts from 'typescript';
import { hasExportModifier, readLeadingJsDoc, readScriptTypeHeader, readTypeImport } from './controllerReader.js';
import type { CarriedTypeImport, ControllerProblem, InlinedTypeImport, ReadControllerOptions, TypeDeclaration } from './controllerReader.js';
import { toPosixPath } from './file-system.js';

/**
 * Reads what a job run carries: the stages the script exports, and the types on either end of a run.
 * A job is an ordinary Map/Reduce script — its stages are NetSuite's own entry points, written in a
 * file each — so there is nothing here about script ids: those are written by hand in netsuite.ts,
 * beside the job's SDF object, and the stages pass them to the run store themselves.
 *
 * A run's contract is where the run is opened and closed: `openJobRun<Request>(jobs.<name>)` on the
 * first line of getInputData is its input, and `closeJobRun<Result>(...)` in summarize is its result.
 * A parse, not a type check: the shapes are written out where the stages declare them.
 *
 * A job is a folder. `<name>/<name>.ts` carries the script's header and hands NetSuite the stages:
 *
 *     export { getInputData } from './getInputData';
 *     export { map } from './map';
 *     export { summarize } from './summarize';
 *
 * so a developer opens map.ts to see what the map stage does, and the file NetSuite loads says only
 * which stages there are.
 */

/** The stage names a job may export, in the order NetSuite calls them. */
export const JOB_STAGE_NAMES = ['getInputData', 'map', 'reduce', 'summarize'] as const;
export type JobStageName = (typeof JOB_STAGE_NAMES)[number];

/** The script type a job's leading JSDoc must declare. */
export const JOB_SCRIPT_TYPE_HEADER = 'MapReduceScript';

/** The type the generated job module gives the run's result. */
export const GENERATED_JOB_RESULT_TYPE_NAME = 'Result';

/**
 * The calls a run is opened and closed with, which is where a run's input and result are written
 * down. The repository `npm run add:jobs` writes exports them under these names; a project that
 * renames them hides its runs' shapes from the generator, so the names are part of the convention.
 */
export const RUN_OPEN_FUNCTION_NAME = 'openJobRun';
export const RUN_CLOSE_FUNCTION_NAME = 'closeJobRun';

const jobFileNamePattern = /^([a-z][A-Za-z0-9]*)\.ts$/;
const jobFolderNamePattern = /^[a-z][A-Za-z0-9]*$/;

/**
 * A file of the job's own folder the reader had to read: a stage, or a file a stage takes a shape from. What
 * it declares is copied into the browser's module like a service's, because a run's shapes are written where
 * its stages are — the value a map stage writes is declared in map.ts and named again in summarize.ts.
 */
export interface JobFolderFile {
    filePath: string;
    declarations: TypeDeclaration[];
    inlinedTypeImports: InlinedTypeImport[];
    carriedTypeImports: CarriedTypeImport[];
}

/** What a job's reader needs beyond a controller's: the files its stages are exported from. */
export interface ReadJobOptions extends ReadControllerOptions {
    /**
     * Reads a file a stage comes from, the specifier resolved against the job's own folder, or
     * undefined when there is no such file.
     */
    readStageFile?(specifier: string): { filePath: string; source: string } | undefined;
}

export interface JobContract {
    /** The job's name: `closeStaleOrders` for closeStaleOrders/closeStaleOrders.ts, and what netsuite.ts calls it. */
    name: string;
    filePath: string;
    carriedTypeImports: CarriedTypeImport[];
    inlinedTypeImports: InlinedTypeImport[];
    typeDeclarations: TypeDeclaration[];
    /** The type openJobRun is given in getInputData, or undefined when a run carries no input. */
    inputType?: string;
    /** The type closeJobRun is given in summarize: what a finished run leaves behind. */
    resultType?: string;
    /** The stages the script exports, in the order NetSuite calls them. */
    stages: JobStageName[];
    /** The files of the job's folder that were read, in that order: its stages, and whatever they name. */
    folderFiles: JobFolderFile[];
}

export interface JobReadResult {
    contract?: JobContract;
    problems: ControllerProblem[];
}

/** The name a job folder declares: `approveOrders` for api/src/jobs/approveOrders, or undefined when it is not a name. */
export function readJobFolderName(folderName: string): string | undefined {
    return jobFolderNamePattern.test(folderName) ? folderName : undefined;
}

/** The file NetSuite loads for a job: the folder's own name again, so the file is unique to open and to search for. */
export function jobDefinitionFileName(jobName: string): string {
    return `${jobName}.ts`;
}

interface FileTypes {
    declarations: TypeDeclaration[];
    carriedTypeImports: CarriedTypeImport[];
    inlinedTypeImports: InlinedTypeImport[];
    problems: ControllerProblem[];
}

/**
 * The exported type declarations of a file and the type imports it carries, for the file NetSuite
 * loads or for one of the stages: both end up in the browser's module, so both are read the same way.
 */
function readFileTypes(sourceFile: ts.SourceFile, filePath: string, options: ReadControllerOptions, folderFiles?: JobFolderFiles): FileTypes {
    const declarations: TypeDeclaration[] = [];
    const carriedTypeImports: CarriedTypeImport[] = [];
    const inlinedTypeImports: InlinedTypeImport[] = [];
    const problems: ControllerProblem[] = [];
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            // NetSuite's own types: a stage is an entry point, so it is annotated with them, and none of them crosses to the browser.
            if (ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('N/')) continue;
            const result = readTypeImport(statement, filePath, options);
            if (result.read?.kind === 'carried') carriedTypeImports.push(result.read.typeImport);
            else if (result.read?.kind === 'inlined') inlinedTypeImports.push(result.read.typeImport);
            else if (result.read?.kind === 'controller') {
                problems.push({ filePath, message: "a job does not take types from a controller; its input and result are its own, or a service's." });
            } else if (result.problems.length > 0 && ts.isStringLiteral(statement.moduleSpecifier) && isRelativeSpecifier(statement.moduleSpecifier.text)) {
                // A shape another file of this job's folder declares: read there instead of reported as unreachable.
                const sibling = folderFiles?.read(statement.moduleSpecifier.text);
                if (!sibling) problems.push(...result.problems);
                continue;
            }
            problems.push(...result.problems);
            continue;
        }
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEnumDeclaration(statement)) continue;
        if (!hasExportModifier(statement)) {
            problems.push({ filePath, message: `'${statement.name.text}' is not exported; the generator copies the shapes a run's result names into the browser's module as they are written, so export them.` });
            continue;
        }
        if (statement.name.text === GENERATED_JOB_RESULT_TYPE_NAME) {
            problems.push({ filePath, message: `type '${statement.name.text}' is the name the generated module gives the run's result; call this shape something else.` });
            continue;
        }
        const jsDoc = readLeadingJsDoc(statement, sourceFile);
        declarations.push({ name: statement.name.text, text: `${jsDoc ? `${jsDoc}\n` : ''}${statement.getText(sourceFile)}` });
    }
    return { declarations, carriedTypeImports, inlinedTypeImports, problems };
}

function isRelativeSpecifier(specifier: string): boolean {
    return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * The files of one job's folder, read once each however many stages and shapes come from them. A file is
 * registered before its own types are read, so two stage files naming each other's shapes stop there.
 */
interface JobFolderFiles {
    read(specifier: string): { sourceFile: ts.SourceFile; filePath: string } | undefined;
    readonly collected: JobFolderFile[];
    readonly problems: ControllerProblem[];
}

function createJobFolderFiles(options: ReadJobOptions): JobFolderFiles {
    const collected: JobFolderFile[] = [];
    const problems: ControllerProblem[] = [];
    const bySpecifier = new Map<string, { sourceFile: ts.SourceFile; filePath: string } | undefined>();
    const folderFiles: JobFolderFiles = {
        collected,
        problems,
        read(specifier) {
            if (bySpecifier.has(specifier)) return bySpecifier.get(specifier);
            const read = options.readStageFile?.(specifier);
            if (!read) {
                bySpecifier.set(specifier, undefined);
                return undefined;
            }
            const sourceFile = ts.createSourceFile(read.filePath, read.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
            const entry = { sourceFile, filePath: read.filePath };
            bySpecifier.set(specifier, entry);
            const types = readFileTypes(sourceFile, read.filePath, options, folderFiles);
            problems.push(...types.problems);
            collected.push({ filePath: read.filePath, declarations: types.declarations, inlinedTypeImports: types.inlinedTypeImports, carriedTypeImports: types.carriedTypeImports });
            return entry;
        },
    };
    return folderFiles;
}

type StageHandler = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

/** The exported function of that name in a stage file: `export function map…` or `export const map = …`. */
function findExportedFunction(sourceFile: ts.SourceFile, name: string): StageHandler | undefined {
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name?.text === name) return statement;
        if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
            const initializer = declaration.initializer;
            if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return initializer;
        }
    }
    return undefined;
}

/** The type a call was given, written out: `openJobRun<ApproveRequest>(…)` answers `ApproveRequest`. */
function findCallTypeArgument(sourceFile: ts.SourceFile, functionName: string): { found: boolean; typeText?: string } {
    let found = false;
    let typeText: string | undefined;
    const visit = (node: ts.Node): void => {
        if (found && typeText !== undefined) return;
        if (ts.isCallExpression(node)) {
            const called = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
            if (called === functionName) {
                found = true;
                const typeArgument = node.typeArguments?.[0];
                if (typeArgument && typeText === undefined) typeText = typeArgument.getText(sourceFile);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { found, typeText };
}

/** NetSuite's context for one stage, as a stage file annotates it: `EntryPoints.MapReduce.mapContext`. */
function isStageContextType(typeText: string | undefined, stage: JobStageName): boolean {
    return typeText !== undefined && typeText.replace(/\s/g, '').endsWith(`MapReduce.${stage}Context`);
}

interface ReadStagesResult {
    stages: JobStageName[];
    inputType?: string;
    resultType?: string;
    problems: ControllerProblem[];
}

/**
 * The stages the script hands NetSuite, each read in the file it comes from: what it is annotated
 * with, and — for the two stages a run is opened and closed in — the shapes on either end of the run.
 */
function readStages(sourceFile: ts.SourceFile, filePath: string, jobName: string, folderFiles: JobFolderFiles): ReadStagesResult {
    const problems: ControllerProblem[] = [];
    const stages: JobStageName[] = [];
    let inputType: string | undefined;
    let resultType: string | undefined;

    for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)) continue;
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
            problems.push({ filePath, message: "a stage is exported from the file it lives in: `export { map } from './map'`." });
            continue;
        }
        const specifier = statement.moduleSpecifier.text;
        if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
            problems.push({ filePath, message: `'export * from ${specifier}' says nothing about which stages there are; export them by name.` });
            continue;
        }
        if (!isRelativeSpecifier(specifier)) {
            problems.push({ filePath, message: `a stage comes from a file beside the job, such as './map'; '${specifier}' is somewhere else.` });
            continue;
        }
        const stageFile = folderFiles.read(specifier);
        if (!stageFile) {
            problems.push({ filePath, message: `there is no '${specifier}' beside the job for the generator to read.` });
            continue;
        }
        for (const element of statement.exportClause.elements) {
            const stageName = element.name.text;
            if (!JOB_STAGE_NAMES.includes(stageName as JobStageName)) {
                problems.push({ filePath, message: `NetSuite has no entry point called '${stageName}'; a job exports ${JOB_STAGE_NAMES.join(', ')}.` });
                continue;
            }
            const stage = stageName as JobStageName;
            if (stages.includes(stage)) {
                problems.push({ filePath, message: `'${stage}' is exported twice; NetSuite calls one function per stage.` });
                continue;
            }
            const localName = (element.propertyName ?? element.name).text;
            const handler = findExportedFunction(stageFile.sourceFile, localName);
            if (!handler) {
                problems.push({ filePath: stageFile.filePath, message: `'${localName}' is not exported from here as a function, and ${jobName} hands it to NetSuite as its ${stage} stage.` });
                continue;
            }
            stages.push(stage);
            const contextType = handler.parameters[0]?.type?.getText(stageFile.sourceFile);
            if (!isStageContextType(contextType, stage)) {
                problems.push({
                    filePath: stageFile.filePath,
                    message: `${stage} takes NetSuite's own context: \`(context: EntryPoints.MapReduce.${stage}Context)\`, the type it is called with.`,
                });
            }
            if (stage === 'getInputData') {
                const opened = findCallTypeArgument(stageFile.sourceFile, RUN_OPEN_FUNCTION_NAME);
                if (!opened.found) {
                    problems.push({
                        filePath: stageFile.filePath,
                        message: `getInputData opens the run it belongs to: \`${RUN_OPEN_FUNCTION_NAME}<Request>(jobs.${jobName})\`. Without it the run is never claimed and the page follows a run that says nothing.`,
                    });
                }
                inputType = opened.typeText;
            }
            if (stage === 'summarize') {
                const closed = findCallTypeArgument(stageFile.sourceFile, RUN_CLOSE_FUNCTION_NAME);
                if (!closed.found) {
                    problems.push({
                        filePath: stageFile.filePath,
                        message: `summarize closes the run: \`${RUN_CLOSE_FUNCTION_NAME}<Result>(jobs.${jobName}, context, result)\`. Without it the run never ends and the page polls a finished job.`,
                    });
                } else if (closed.typeText === undefined) {
                    problems.push({
                        filePath: stageFile.filePath,
                        message: `${RUN_CLOSE_FUNCTION_NAME} has no type on it; a run's result shape is read from it, so write it out: \`${RUN_CLOSE_FUNCTION_NAME}<Result>(…)\`, or \`<null>\` for a run that leaves nothing.`,
                    });
                }
                resultType = closed.typeText;
            }
        }
    }

    if (!stages.includes('getInputData')) problems.push({ filePath, message: 'a job exports getInputData; it is what NetSuite asks for the run\'s work.' });
    if (!stages.includes('map') && !stages.includes('reduce')) {
        problems.push({ filePath, message: 'a job exports a map stage, a reduce stage, or both; NetSuite has nothing to run otherwise.' });
    }
    // The run is closed in summarize, so a job that leaves it out would leave every run of it looking unfinished.
    if (!stages.includes('summarize')) problems.push({ filePath, message: 'every job exports summarize: it is where the run is closed and its result written.' });
    return { stages: JOB_STAGE_NAMES.filter((stage) => stages.includes(stage)), inputType, resultType, problems };
}

export function readJobContract(filePath: string, source: string, options: ReadJobOptions): JobReadResult {
    const problems: ControllerProblem[] = [];
    const posixPath = toPosixPath(filePath);
    const fileName = nodePath.basename(posixPath);
    const nameMatch = jobFileNamePattern.exec(fileName);
    if (!nameMatch) return { problems: [{ filePath, message: 'a job is the file <name>.ts of a folder of that name, with <name> in camelCase; nothing else is a job.' }] };
    const name = nameMatch[1];
    const folderName = nodePath.basename(nodePath.dirname(posixPath));
    if (folderName !== name) {
        problems.push({ filePath, message: `a job lives in a folder of its own name: ${fileName} belongs in a folder called ${name}, beside the stage files it is made of.` });
    }
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const header = readScriptTypeHeader(source);
    if (header !== JOB_SCRIPT_TYPE_HEADER) {
        problems.push({ filePath, message: `the leading JSDoc says '@NScriptType ${header ?? '(none)'}'; a job is a ${JOB_SCRIPT_TYPE_HEADER}.` });
    }

    const folderFiles = createJobFolderFiles(options);
    const fileTypes = readFileTypes(sourceFile, filePath, options, folderFiles);
    problems.push(...fileTypes.problems);
    const stages = readStages(sourceFile, filePath, name, folderFiles);
    problems.push(...stages.problems);
    problems.push(...folderFiles.problems);
    if (problems.length > 0) return { problems };

    return {
        contract: {
            name,
            filePath,
            carriedTypeImports: fileTypes.carriedTypeImports,
            inlinedTypeImports: fileTypes.inlinedTypeImports,
            typeDeclarations: fileTypes.declarations,
            inputType: stages.inputType,
            resultType: stages.resultType,
            stages: stages.stages,
            folderFiles: folderFiles.collected,
        },
        problems,
    };
}
