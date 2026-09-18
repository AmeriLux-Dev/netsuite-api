import * as nodePath from 'node:path';
import ts from 'typescript';
import { hasExportModifier, readLeadingJsDoc, readScriptTypeHeader, readStringProperty, readTypeImport } from './controllerReader.js';
import type { CarriedTypeImport, ControllerProblem, InlinedTypeImport, ReadControllerOptions, TypeDeclaration } from './controllerReader.js';
import { toPosixPath } from './file-system.js';

/**
 * Reads what a job run carries, from its source alone: the script it declares in its defineJob call,
 * the stages it has, and the types on either end of a run. A run's input is the first parameter of
 * getInputData and its result is what summarize returns, so those two annotations are the contract,
 * the way a handler's parameter and return type are a controller's. A parse, not a type check: the
 * ids are string literals and the shapes are written out.
 */

/** The stage names a job may declare, in the order NetSuite calls them. */
export const JOB_STAGE_NAMES = ['getInputData', 'map', 'reduce', 'summarize'] as const;
export type JobStageName = (typeof JOB_STAGE_NAMES)[number];

/** The script type a job's leading JSDoc must declare. */
export const JOB_SCRIPT_TYPE_HEADER = 'MapReduceScript';

/** The type the generated job module gives the run's input, and the one it gives the result. */
export const GENERATED_JOB_RESULT_TYPE_NAME = 'Result';

const jobFileNamePattern = /^([a-z][A-Za-z0-9]*)\.ts$/;
const netsuiteValueTypes = ['text', 'integer', 'decimal', 'checkbox', 'date', 'select'] as const;

export interface JobParameterContract {
    /** The name the stages read it by. */
    name: string;
    id: string;
    type: (typeof netsuiteValueTypes)[number];
}

/** The script a job declares, as read off its defineJob call. */
export interface DeclaredJob {
    scriptId: string;
    deployments: string[];
    runParameter: string;
    parameters: JobParameterContract[];
}

export interface JobContract {
    /** The job's name: `closeStaleOrders` for closeStaleOrders.ts, matching `name` in its declaration. */
    name: string;
    filePath: string;
    script: DeclaredJob;
    carriedTypeImports: CarriedTypeImport[];
    inlinedTypeImports: InlinedTypeImport[];
    typeDeclarations: TypeDeclaration[];
    /** The type of getInputData's first parameter, or undefined when a run takes no input. */
    inputType?: string;
    /** What summarize returns, or undefined when the job has no summarize stage of its own. */
    resultType?: string;
    /** The stages the job declares. */
    stages: JobStageName[];
    /** The stages the file exports as NetSuite entry points. */
    exportedStages: string[];
}

export interface JobReadResult {
    contract?: JobContract;
    problems: ControllerProblem[];
}

export function isJobFileName(fileName: string): boolean {
    return jobFileNamePattern.test(fileName) && !fileName.endsWith('.d.ts');
}

/** `export const { getInputData, map, summarize } = defineJob(...)`: the call, and the names it exports. */
function findDefineJobCall(statement: ts.VariableStatement): { call: ts.CallExpression; exportedStages: string[]; destructured: boolean } | undefined {
    for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'defineJob') continue;
        if (!ts.isObjectBindingPattern(declaration.name)) return { call: initializer, exportedStages: [], destructured: false };
        const exportedStages = declaration.name.elements
            .map((element) => (ts.isIdentifier(element.name) ? element.name.text : undefined))
            .filter((exported): exported is string => exported !== undefined);
        return { call: initializer, exportedStages, destructured: true };
    }
    return undefined;
}

function readStringArrayProperty(literal: ts.ObjectLiteralExpression, propertyName: string): string[] | undefined {
    for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== propertyName) continue;
        if (!ts.isArrayLiteralExpression(property.initializer)) return undefined;
        const values = property.initializer.elements.map((element) => (ts.isStringLiteral(element) ? element.text : undefined));
        return values.every((value): value is string => value !== undefined) ? values : undefined;
    }
    return undefined;
}

function hasProperty(literal: ts.ObjectLiteralExpression, propertyName: string): boolean {
    return literal.properties.some((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === propertyName);
}

function readObjectProperty(literal: ts.ObjectLiteralExpression, propertyName: string): ts.ObjectLiteralExpression | undefined {
    for (const property of literal.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === propertyName && ts.isObjectLiteralExpression(property.initializer)) {
            return property.initializer;
        }
    }
    return undefined;
}

function readParameters(declaration: ts.ObjectLiteralExpression, filePath: string): { parameters: JobParameterContract[]; problems: ControllerProblem[] } {
    const problems: ControllerProblem[] = [];
    const parameters: JobParameterContract[] = [];
    const literal = readObjectProperty(declaration, 'parameters');
    if (!literal) {
        if (hasProperty(declaration, 'parameters')) problems.push({ filePath, message: "'parameters' must be an object literal of { id, type } written inline; the generator reads the ids from it." });
        return { parameters, problems };
    }
    for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
            problems.push({ filePath, message: 'every script parameter is named by a plain identifier and declared as { id, type }.' });
            continue;
        }
        const name = property.name.text;
        if (!ts.isObjectLiteralExpression(property.initializer)) {
            problems.push({ filePath, message: `parameter '${name}' must be written as { id: 'custscript_...', type: '...' }.` });
            continue;
        }
        const id = readStringProperty(property.initializer, 'id');
        const type = readStringProperty(property.initializer, 'type');
        if (id === undefined) problems.push({ filePath, message: `parameter '${name}' needs 'id' as a string literal: the script parameter's id in NetSuite.` });
        if (type === undefined || !netsuiteValueTypes.includes(type as JobParameterContract['type'])) {
            problems.push({ filePath, message: `parameter '${name}' needs 'type' as one of ${netsuiteValueTypes.map((value) => `'${value}'`).join(', ')}.` });
            continue;
        }
        if (id !== undefined) parameters.push({ name, id, type: type as JobParameterContract['type'] });
    }
    return { parameters, problems };
}

function readJobDeclaration(declaration: ts.ObjectLiteralExpression, jobName: string, filePath: string): { script?: DeclaredJob; problems: ControllerProblem[] } {
    const problems: ControllerProblem[] = [];
    const name = readStringProperty(declaration, 'name');
    const scriptId = readStringProperty(declaration, 'scriptId');
    const runParameter = readStringProperty(declaration, 'runParameter');
    const deployments = readStringArrayProperty(declaration, 'deployments');
    if (name === undefined) problems.push({ filePath, message: "the job declaration needs 'name' as a string literal; the generator reads it from the source." });
    else if (name !== jobName) problems.push({ filePath, message: `the job declaration says name: '${name}' but the file is ${jobName}.ts; the name is the file name.` });
    if (scriptId === undefined) problems.push({ filePath, message: "the job declaration needs 'scriptId' as a string literal." });
    if (runParameter === undefined) {
        problems.push({ filePath, message: "the job declaration needs 'runParameter' as a string literal: the script parameter the run id is passed in." });
    }
    if (deployments === undefined) {
        problems.push({ filePath, message: "the job declaration needs 'deployments' as an array of string literals: every deployment a run may be started on." });
    } else if (deployments.length === 0) {
        problems.push({ filePath, message: "'deployments' is empty; a job needs at least one deployment to run on." });
    }
    if (!hasProperty(declaration, 'runs')) {
        problems.push({ filePath, message: "the job declaration needs 'runs: jobRuns', the run record from the generated scripts map; the stages read the run through it." });
    }
    const readParametersResult = readParameters(declaration, filePath);
    problems.push(...readParametersResult.problems);
    if (problems.length > 0 || scriptId === undefined || runParameter === undefined || deployments === undefined) return { problems };
    return { script: { scriptId, deployments, runParameter, parameters: readParametersResult.parameters }, problems };
}

interface ReadStagesResult {
    stages: JobStageName[];
    inputType?: string;
    resultType?: string;
    problems: ControllerProblem[];
}

function readStages(literal: ts.ObjectLiteralExpression, filePath: string, sourceFile: ts.SourceFile): ReadStagesResult {
    const problems: ControllerProblem[] = [];
    const stages: JobStageName[] = [];
    let inputType: string | undefined;
    let resultType: string | undefined;

    for (const property of literal.properties) {
        const stageName = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
        if (stageName === undefined || !JOB_STAGE_NAMES.includes(stageName as JobStageName)) {
            problems.push({ filePath, message: `'${stageName ?? 'a stage'}' is not a stage; a job declares ${JOB_STAGE_NAMES.join(', ')}.` });
            continue;
        }
        let handler: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | undefined;
        if (ts.isMethodDeclaration(property)) handler = property;
        else if (ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))) handler = property.initializer;
        if (!handler) {
            problems.push({ filePath, message: `stage '${stageName}' must be an inline function; a reference to a function elsewhere carries no types the generator can read.` });
            continue;
        }
        stages.push(stageName as JobStageName);
        if (stageName === 'getInputData') {
            const parameter = handler.parameters[0];
            if (parameter && !parameter.type) {
                problems.push({ filePath, message: "getInputData has no type on its first parameter; a run's input shape is read from it." });
            }
            inputType = parameter?.type?.getText(sourceFile);
        }
        if (stageName === 'summarize') {
            if (!handler.type) problems.push({ filePath, message: "summarize has no return type annotation; a run's result shape is read from it." });
            resultType = handler.type?.getText(sourceFile);
        }
    }
    if (!stages.includes('getInputData')) problems.push({ filePath, message: 'a job declares getInputData; it is what NetSuite asks for the run\'s work.' });
    if (!stages.includes('map') && !stages.includes('reduce')) {
        problems.push({ filePath, message: 'a job declares a map stage, a reduce stage, or both; NetSuite has nothing to run otherwise.' });
    }
    return { stages, inputType, resultType, problems };
}

export function readJobContract(filePath: string, source: string, options: ReadControllerOptions): JobReadResult {
    const problems: ControllerProblem[] = [];
    const fileName = nodePath.basename(toPosixPath(filePath));
    const nameMatch = jobFileNamePattern.exec(fileName);
    if (!nameMatch) return { problems: [{ filePath, message: 'a job file is named <name>.ts, with <name> in camelCase; nothing else lives in the jobs folder.' }] };
    const name = nameMatch[1];
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const header = readScriptTypeHeader(source);
    if (header !== JOB_SCRIPT_TYPE_HEADER) {
        problems.push({ filePath, message: `the leading JSDoc says '@NScriptType ${header ?? '(none)'}'; a job is a ${JOB_SCRIPT_TYPE_HEADER}.` });
    }

    const carriedTypeImports: CarriedTypeImport[] = [];
    const inlinedTypeImports: InlinedTypeImport[] = [];
    const typeDeclarations: TypeDeclaration[] = [];
    let contract: Omit<JobContract, 'carriedTypeImports' | 'inlinedTypeImports' | 'typeDeclarations'> | undefined;

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const result = readTypeImport(statement, filePath, options);
            problems.push(...result.problems);
            if (result.read?.kind === 'carried') carriedTypeImports.push(result.read.typeImport);
            else if (result.read?.kind === 'inlined') inlinedTypeImports.push(result.read.typeImport);
            else if (result.read?.kind === 'controller') {
                problems.push({ filePath, message: 'a job does not take types from a controller; its input and result are its own, or a service\'s.' });
            }
            continue;
        }
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
            if (!hasExportModifier(statement)) {
                problems.push({ filePath, message: `'${statement.name.text}' is not exported; the generator copies the shapes a run's result names into the browser's module as they are written, so export them.` });
                continue;
            }
            if (statement.name.text === GENERATED_JOB_RESULT_TYPE_NAME) {
                problems.push({ filePath, message: `type '${statement.name.text}' is the name the generated module gives the run's result; call this shape something else.` });
                continue;
            }
            const jsDoc = readLeadingJsDoc(statement, sourceFile);
            typeDeclarations.push({ name: statement.name.text, text: `${jsDoc ? `${jsDoc}\n` : ''}${statement.getText(sourceFile)}` });
            continue;
        }
        if (!ts.isVariableStatement(statement)) continue;
        const found = findDefineJobCall(statement);
        if (!found) continue;
        if (contract) {
            problems.push({ filePath, message: 'a job file has one defineJob call; a second one is a second script.' });
            continue;
        }
        if (!hasExportModifier(statement) || !found.destructured) {
            problems.push({ filePath, message: "the stages are exported from the call: `export const { getInputData, map, summarize } = defineJob({ ... }, { ... })`; NetSuite looks for those exports." });
        }
        const [declarationArgument, stagesArgument] = found.call.arguments;
        if (!declarationArgument || !ts.isObjectLiteralExpression(declarationArgument)) {
            problems.push({ filePath, message: 'defineJob takes the job declaration as an object literal written inline.' });
            continue;
        }
        if (!stagesArgument || !ts.isObjectLiteralExpression(stagesArgument)) {
            problems.push({ filePath, message: 'defineJob takes the stages as an object literal written inline, each stage a function with its types annotated.' });
            continue;
        }
        const declared = readJobDeclaration(declarationArgument, name, filePath);
        problems.push(...declared.problems);
        const stages = readStages(stagesArgument, filePath, sourceFile);
        problems.push(...stages.problems);
        for (const exported of found.exportedStages) {
            if (!JOB_STAGE_NAMES.includes(exported as JobStageName)) {
                problems.push({ filePath, message: `'${exported}' is not a stage, so NetSuite has no entry point by that name; export ${JOB_STAGE_NAMES.join(', ')}.` });
            } else if (exported !== 'summarize' && !stages.stages.includes(exported as JobStageName)) {
                problems.push({ filePath, message: `'${exported}' is exported but not declared; a stage exported without a declaration throws when NetSuite calls it.` });
            }
        }
        for (const stage of stages.stages) {
            if (!found.exportedStages.includes(stage)) {
                problems.push({ filePath, message: `stage '${stage}' is declared but not exported; NetSuite only runs the stages the file exports.` });
            }
        }
        // The run is closed in summarize, so a job that leaves it out would leave every run of it looking unfinished.
        if (!found.exportedStages.includes('summarize')) {
            problems.push({ filePath, message: 'every job exports summarize, declared or not: it is where the run is closed and its result written.' });
        }
        if (!declared.script) continue;
        contract = { name, filePath, script: declared.script, inputType: stages.inputType, resultType: stages.resultType, stages: stages.stages, exportedStages: found.exportedStages };
    }

    if (!contract) {
        if (problems.length === 0) {
            problems.push({ filePath, message: 'must declare its script: `export const { getInputData, map, summarize } = defineJob({ name, scriptId, deployments, runParameter, runs }, { ... })`.' });
        }
        return { problems };
    }
    if (problems.length > 0) return { problems };
    return { contract: { ...contract, carriedTypeImports, inlinedTypeImports, typeDeclarations }, problems };
}
