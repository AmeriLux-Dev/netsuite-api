import * as nodePath from 'node:path';
import ts from 'typescript';
import { toPosixPath } from './file-system.js';

/**
 * Reads what a controller puts on the wire, from its source alone: the script it declares in its
 * defineRestlet or defineSuitelet call, the exported types (the DTOs), and the name, request type and
 * response type of every endpoint in its `defineEndpoints({ ... })`. A parse, not a type check: the
 * handler annotations are the contract, so they must be written out, a DTO may only reference types
 * from the inlined files, the carried modules or another controller, and the script ids are string
 * literals.
 */

export interface ControllerProblem {
    filePath: string;
    message: string;
}

export interface EndpointSignature {
    name: string;
    /** The handler's parameter type, or undefined when the handler takes no request. */
    requestType?: string;
    requestOptional: boolean;
    responseType: string;
    /** True when the return type is written `RawResponse`: the endpoint answers with a document, and the client resolves it to a Blob. */
    raw: boolean;
    jsDoc?: string;
}

/** The return type a handler writes, exactly, to answer with a document instead of the envelope. */
export const RAW_RESPONSE_TYPE_NAME = 'RawResponse';

/** The type every generated controller module declares for its endpoint signatures: `user.Endpoints`. */
export const GENERATED_ENDPOINTS_TYPE_NAME = 'Endpoints';
/** The client every generated browser-facing controller module exports: `user.api`. */
export const GENERATED_CLIENT_NAME = 'api';

/** One name of a type import, `Employee` or `Employee as EmployeeRecord`. */
export interface TypeImportName {
    name: string;
    alias?: string;
}

/** A type import the generated module keeps as an import: a package type such as RawResponse, under the specifier the client resolves. */
export interface CarriedTypeImport {
    /** The specifier as the client resolves it, after the typeImports mapping. */
    moduleSpecifier: string;
    names: TypeImportName[];
}

/** A type import whose declarations are copied into the generated module: the generated entity types. */
export interface InlinedTypeImport {
    /** The specifier as written in the controller: a key of inlineTypes. */
    specifier: string;
    names: TypeImportName[];
}

/** A type import from a sibling controller, resolved to that controller's generated module. */
export interface ControllerTypeImport {
    controllerName: string;
    names: TypeImportName[];
}

export interface TypeDeclaration {
    name: string;
    /** The declaration as written, JSDoc included. */
    text: string;
}

export type ControllerKind = 'restlet' | 'suitelet';

/** The script a controller declares, as read off its entry point. */
export interface DeclaredScript {
    kind: ControllerKind;
    scriptId: string;
    deployId: string;
    browser: boolean;
}

export interface ControllerContract {
    /** The controller's name: `user` for userController.ts, matching `name` in its declaration. */
    name: string;
    filePath: string;
    script: DeclaredScript;
    carriedTypeImports: CarriedTypeImport[];
    inlinedTypeImports: InlinedTypeImport[];
    controllerTypeImports: ControllerTypeImport[];
    typeDeclarations: TypeDeclaration[];
    endpoints: EndpointSignature[];
}

export interface ReadControllerOptions {
    /** Type imports a controller may carry as imports: the specifier written in the controller mapped to the specifier the client resolves. */
    typeImports: Record<string, string>;
    /** Type imports whose declarations are copied into the generated module: the specifier written in the controller mapped to the file it names. */
    inlineTypes: Record<string, string>;
}

export interface ControllerReadResult {
    contract?: ControllerContract;
    problems: ControllerProblem[];
}

const controllerFileNamePattern = /^([a-z][A-Za-z0-9]*)Controller\.ts$/;
const siblingControllerSpecifierPattern = /^\.\/([a-z][A-Za-z0-9]*)Controller(?:\.js|\.ts)?$/;

const entryPointByFunction: Record<string, { kind: ControllerKind; exportName: string; header: string }> = {
    defineRestlet: { kind: 'restlet', exportName: 'post', header: 'Restlet' },
    defineSuitelet: { kind: 'suitelet', exportName: 'onRequest', header: 'Suitelet' },
};

export function isControllerFileName(fileName: string): boolean {
    return controllerFileNamePattern.test(fileName);
}

function hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/** The JSDoc block directly above a node (no blank line between them), or undefined. */
export function readLeadingJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
    const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
    const jsDocRange = ranges.filter((range) => sourceFile.text.startsWith('/**', range.pos)).pop();
    if (!jsDocRange) return undefined;
    const gap = sourceFile.text.slice(jsDocRange.end, node.getStart(sourceFile));
    if (/\n[ \t]*\n/.test(gap)) return undefined;
    return sourceFile.text.slice(jsDocRange.pos, jsDocRange.end);
}

/** The script type NetSuite reads from the leading JSDoc, or undefined. */
function readScriptTypeHeader(source: string): string | undefined {
    const header = source.match(/^\s*(\/\*[\s\S]*?\*\/)/)?.[1] ?? '';
    return header.match(/@NScriptType\s+(\w+)/)?.[1];
}

type ReadTypeImport =
    | { kind: 'carried'; typeImport: CarriedTypeImport }
    | { kind: 'inlined'; typeImport: InlinedTypeImport }
    | { kind: 'controller'; typeImport: ControllerTypeImport };

function readTypeImport(statement: ts.ImportDeclaration, filePath: string, options: ReadControllerOptions): { read?: ReadTypeImport; problems: ControllerProblem[] } {
    const problems: ControllerProblem[] = [];
    const clause = statement.importClause;
    if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) return { problems };
    const moduleSpecifier = statement.moduleSpecifier.text;
    const bindings = clause.namedBindings;

    if (bindings && ts.isNamespaceImport(bindings)) {
        if (clause.isTypeOnly) {
            problems.push({ filePath, message: `'import type * as ${bindings.name.text}' from '${moduleSpecifier}' cannot be carried to the client; import the types by name.` });
        }
        return { problems };
    }
    const names: TypeImportName[] = [];
    if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
            if (clause.isTypeOnly || element.isTypeOnly) names.push(element.propertyName ? { name: element.propertyName.text, alias: element.name.text } : { name: element.name.text });
        }
    }
    if (clause.name && clause.isTypeOnly) {
        problems.push({ filePath, message: `'import type ${clause.name.text}' from '${moduleSpecifier}' cannot be carried to the client; import the types by name.` });
    }
    if (names.length === 0) return { problems };

    const sibling = siblingControllerSpecifierPattern.exec(moduleSpecifier);
    if (sibling) return { read: { kind: 'controller', typeImport: { controllerName: sibling[1], names } }, problems };
    if (options.inlineTypes[moduleSpecifier] !== undefined) return { read: { kind: 'inlined', typeImport: { specifier: moduleSpecifier, names } }, problems };
    const clientSpecifier = options.typeImports[moduleSpecifier];
    if (clientSpecifier !== undefined) return { read: { kind: 'carried', typeImport: { moduleSpecifier: clientSpecifier, names } }, problems };
    const allowed = [...Object.keys(options.inlineTypes), ...Object.keys(options.typeImports)].map((specifier) => `'${specifier}'`).join(', ');
    const written = names.map((imported) => (imported.alias ? `${imported.name} as ${imported.alias}` : imported.name)).join(', ');
    problems.push({ filePath, message: `type ${written} is imported from '${moduleSpecifier}'; a controller's wire shapes may only take types from ${allowed || 'the configured inlineTypes and typeImports'} or from another controller.` });
    return { problems };
}

function isTypeQueryAlias(statement: ts.Statement): statement is ts.TypeAliasDeclaration {
    return ts.isTypeAliasDeclaration(statement) && ts.isTypeQueryNode(statement.type);
}

function readEndpoint(property: ts.ObjectLiteralElementLike, filePath: string, sourceFile: ts.SourceFile): { endpoint?: EndpointSignature; problems: ControllerProblem[] } {
    const problems: ControllerProblem[] = [];
    const propertyName = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
    if (propertyName === undefined) {
        problems.push({ filePath, message: 'an endpoint must be named by a plain identifier.' });
        return { problems };
    }
    let handler: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | undefined;
    if (ts.isMethodDeclaration(property)) handler = property;
    else if (ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))) handler = property.initializer;
    if (!handler) {
        problems.push({ filePath, message: `endpoint '${propertyName}' must be an inline function with its parameter and return type annotated; a reference to a function elsewhere carries no types the generator can read.` });
        return { problems };
    }
    if (handler.parameters.length > 1) {
        problems.push({ filePath, message: `endpoint '${propertyName}' takes ${handler.parameters.length} parameters; an endpoint takes one request or none.` });
        return { problems };
    }
    if (!handler.type) {
        problems.push({ filePath, message: `endpoint '${propertyName}' has no return type annotation; the response shape is read from it.` });
        return { problems };
    }
    const parameter = handler.parameters[0];
    if (parameter && !parameter.type) {
        problems.push({ filePath, message: `endpoint '${propertyName}' has no parameter type annotation; the request shape is read from it.` });
        return { problems };
    }
    const responseType = handler.type.getText(sourceFile);
    return {
        endpoint: {
            name: propertyName,
            requestType: parameter?.type?.getText(sourceFile),
            requestOptional: parameter?.questionToken !== undefined || parameter?.initializer !== undefined,
            responseType,
            raw: responseType === RAW_RESPONSE_TYPE_NAME,
            jsDoc: readLeadingJsDoc(property, sourceFile),
        },
        problems,
    };
}

function findCall(statement: ts.VariableStatement, calleeNames: string[]): { declarationName: string; call: ts.CallExpression } | undefined {
    for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer;
        if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && calleeNames.includes(initializer.expression.text)) {
            return { declarationName: declaration.name.text, call: initializer };
        }
    }
    return undefined;
}

function readStringProperty(literal: ts.ObjectLiteralExpression, propertyName: string): string | undefined {
    for (const property of literal.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === propertyName && ts.isStringLiteral(property.initializer)) return property.initializer.text;
    }
    return undefined;
}

function readBooleanProperty(literal: ts.ObjectLiteralExpression, propertyName: string): boolean | undefined {
    for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== propertyName) continue;
        if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    }
    return undefined;
}

function readScriptDeclaration(
    found: { declarationName: string; call: ts.CallExpression },
    statement: ts.VariableStatement,
    controllerName: string,
    endpointsConstantName: string,
    source: string,
    filePath: string,
): { script?: DeclaredScript; problems: ControllerProblem[] } {
    const problems: ControllerProblem[] = [];
    const calleeName = (found.call.expression as ts.Identifier).text;
    const entryPoint = entryPointByFunction[calleeName];
    const callLabel = `${calleeName}({ name, scriptId, deployId }, ${endpointsConstantName})`;
    if (!hasExportModifier(statement) || found.declarationName !== entryPoint.exportName) {
        problems.push({ filePath, message: `the entry point must be 'export const ${entryPoint.exportName} = ${callLabel}'; NetSuite looks for that export on a ${entryPoint.header}.` });
    }
    const header = readScriptTypeHeader(source);
    if (header !== entryPoint.header) {
        problems.push({ filePath, message: `the leading JSDoc says '@NScriptType ${header ?? '(none)'}' but the entry point is ${calleeName}; both must say ${entryPoint.header}.` });
    }
    const [declaration, endpointsArgument] = found.call.arguments;
    if (!declaration || !ts.isObjectLiteralExpression(declaration)) {
        problems.push({ filePath, message: `${calleeName} takes the script declaration as an object literal written inline: ${callLabel}.` });
        return { problems };
    }
    if (!endpointsArgument || !ts.isIdentifier(endpointsArgument) || endpointsArgument.text !== endpointsConstantName) {
        problems.push({ filePath, message: `${calleeName} must be passed ${endpointsConstantName}: ${callLabel}.` });
    }
    const name = readStringProperty(declaration, 'name');
    const scriptId = readStringProperty(declaration, 'scriptId');
    const deployId = readStringProperty(declaration, 'deployId');
    for (const [property, value] of [['name', name], ['scriptId', scriptId], ['deployId', deployId]] as const) {
        if (value === undefined) problems.push({ filePath, message: `the script declaration needs '${property}' as a string literal; the generator reads it from the source.` });
    }
    if (name !== undefined && name !== controllerName) {
        problems.push({ filePath, message: `the script declaration says name: '${name}' but the file is ${controllerName}Controller.ts; the name is the file name without Controller.` });
    }
    const browser = readBooleanProperty(declaration, 'browser');
    if (browser === undefined && declaration.properties.some((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'browser')) {
        problems.push({ filePath, message: "'browser' must be the literal true or false." });
    }
    if (problems.length > 0 || scriptId === undefined || deployId === undefined) return { problems };
    return { script: { kind: entryPoint.kind, scriptId, deployId, browser: browser ?? true }, problems };
}

export function readControllerContract(filePath: string, source: string, options: ReadControllerOptions): ControllerReadResult {
    const problems: ControllerProblem[] = [];
    const fileName = nodePath.basename(toPosixPath(filePath));
    const nameMatch = controllerFileNamePattern.exec(fileName);
    if (!nameMatch) {
        return { problems: [{ filePath, message: 'a controller file is named <name>Controller.ts, with <name> in camelCase.' }] };
    }
    const name = nameMatch[1];
    const endpointsConstantName = `${name}Endpoints`;
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const carriedTypeImports: CarriedTypeImport[] = [];
    const inlinedTypeImports: InlinedTypeImport[] = [];
    const controllerTypeImports: ControllerTypeImport[] = [];
    const typeDeclarations: TypeDeclaration[] = [];
    const endpoints: EndpointSignature[] = [];
    let endpointsFound = false;
    let script: DeclaredScript | undefined;
    let entryPointFound = false;

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const result = readTypeImport(statement, filePath, options);
            problems.push(...result.problems);
            if (result.read?.kind === 'carried') carriedTypeImports.push(result.read.typeImport);
            else if (result.read?.kind === 'inlined') inlinedTypeImports.push(result.read.typeImport);
            else if (result.read?.kind === 'controller') controllerTypeImports.push(result.read.typeImport);
        } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
            if (isTypeQueryAlias(statement)) {
                const queried = statement.type as ts.TypeQueryNode;
                if (ts.isIdentifier(queried.exprName) && queried.exprName.text === endpointsConstantName) continue;
                problems.push({ filePath, message: `type '${statement.name.text}' is a typeof; a wire shape is written out as an interface or a type alias.` });
                continue;
            }
            if (!hasExportModifier(statement)) {
                problems.push({ filePath, message: `'${statement.name.text}' is not exported; every type in a controller is a wire shape, so export it (or move it below the controller).` });
                continue;
            }
            if (statement.name.text === GENERATED_ENDPOINTS_TYPE_NAME) {
                problems.push({ filePath, message: `type '${GENERATED_ENDPOINTS_TYPE_NAME}' is the name the generated module gives the endpoint signatures; call the wire shape something else.` });
                continue;
            }
            const jsDoc = readLeadingJsDoc(statement, sourceFile);
            typeDeclarations.push({ name: statement.name.text, text: `${jsDoc ? `${jsDoc}\n` : ''}${statement.getText(sourceFile)}` });
        } else if (ts.isVariableStatement(statement)) {
            const endpointsCall = findCall(statement, ['defineEndpoints']);
            if (endpointsCall) {
                if (endpointsCall.declarationName !== endpointsConstantName) {
                    problems.push({ filePath, message: `the endpoints are declared as 'export const ${endpointsConstantName} = defineEndpoints({ ... })', not '${endpointsCall.declarationName}'.` });
                    continue;
                }
                endpointsFound = true;
                const argument = endpointsCall.call.arguments[0];
                if (!argument || !ts.isObjectLiteralExpression(argument)) {
                    problems.push({ filePath, message: `${endpointsConstantName} must be defineEndpoints({ ... }) with the endpoints written inline.` });
                    continue;
                }
                for (const property of argument.properties) {
                    const result = readEndpoint(property, filePath, sourceFile);
                    problems.push(...result.problems);
                    if (result.endpoint) endpoints.push(result.endpoint);
                }
                continue;
            }
            const entryPointCall = findCall(statement, Object.keys(entryPointByFunction));
            if (entryPointCall) {
                if (entryPointFound) {
                    problems.push({ filePath, message: 'a controller has one entry point; a second defineRestlet or defineSuitelet call is a second script.' });
                    continue;
                }
                entryPointFound = true;
                const result = readScriptDeclaration(entryPointCall, statement, name, endpointsConstantName, source, filePath);
                problems.push(...result.problems);
                script = result.script;
            }
        }
    }
    if (!endpointsFound) {
        problems.push({ filePath, message: `must declare 'export const ${endpointsConstantName} = defineEndpoints({ ... })'.` });
    }
    if (!entryPointFound) {
        problems.push({ filePath, message: `must end with 'export const post = defineRestlet({ name, scriptId, deployId }, ${endpointsConstantName})' or 'export const onRequest = defineSuitelet(...)'.` });
    }
    if (problems.length > 0 || !script) return { problems };
    return {
        contract: { name, filePath, script, carriedTypeImports, inlinedTypeImports, controllerTypeImports, typeDeclarations, endpoints },
        problems,
    };
}
