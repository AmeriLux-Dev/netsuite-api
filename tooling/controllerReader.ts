import * as nodePath from 'node:path';
import ts from 'typescript';
import { toPosixPath } from './file-system.js';

/**
 * Reads what a controller puts on the wire, from its source alone: the exported types (the DTOs),
 * and the name, request type and response type of every endpoint in its `defineEndpoints({ ... })`.
 * A parse, not a type check: the handler annotations are the contract, so they must be written out,
 * and a DTO may only reference types from the carried modules or from another controller.
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
    jsDoc?: string;
}

export interface CarriedTypeImport {
    moduleSpecifier: string;
    names: string[];
}

export interface TypeDeclaration {
    name: string;
    /** The declaration as written, JSDoc included. */
    text: string;
}

export interface ControllerContract {
    /** The scripts key: `user` for userController.ts. */
    name: string;
    filePath: string;
    /** `UserEndpoints`: the interface the generated module declares for the controller. */
    endpointsTypeName: string;
    /** `userApi`: the client the generated module exports for a browser-facing controller. */
    clientName: string;
    typeImports: CarriedTypeImport[];
    typeDeclarations: TypeDeclaration[];
    endpoints: EndpointSignature[];
}

export interface ReadControllerOptions {
    /** Module specifier prefixes whose type imports are carried into the generated module. */
    carriedTypeImports: string[];
}

export interface ControllerReadResult {
    contract?: ControllerContract;
    problems: ControllerProblem[];
}

const controllerFileNamePattern = /^([a-z][A-Za-z0-9]*)Controller\.ts$/;
const siblingControllerSpecifierPattern = /^\.\/[a-z][A-Za-z0-9]*Controller(?:\.js|\.ts)?$/;

export function isControllerFileName(fileName: string): boolean {
    return controllerFileNamePattern.test(fileName);
}

export function toPascalCase(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
}

function hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/** The JSDoc block directly above a node (no blank line between them), or undefined. */
function readLeadingJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
    const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
    const jsDocRange = ranges.filter((range) => sourceFile.text.startsWith('/**', range.pos)).pop();
    if (!jsDocRange) return undefined;
    const gap = sourceFile.text.slice(jsDocRange.end, node.getStart(sourceFile));
    if (/\n[ \t]*\n/.test(gap)) return undefined;
    return sourceFile.text.slice(jsDocRange.pos, jsDocRange.end);
}

function readTypeImport(statement: ts.ImportDeclaration, filePath: string, options: ReadControllerOptions): { typeImport?: CarriedTypeImport; problems: ControllerProblem[] } {
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
    const names: string[] = [];
    if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
            if (clause.isTypeOnly || element.isTypeOnly) names.push(element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text);
        }
    }
    if (clause.name && clause.isTypeOnly) {
        problems.push({ filePath, message: `'import type ${clause.name.text}' from '${moduleSpecifier}' cannot be carried to the client; import the types by name.` });
    }
    if (names.length === 0) return { problems };

    if (siblingControllerSpecifierPattern.test(moduleSpecifier)) return { problems };
    if (options.carriedTypeImports.some((prefix) => moduleSpecifier.startsWith(prefix))) {
        return { typeImport: { moduleSpecifier, names }, problems };
    }
    problems.push({
        filePath,
        message: `type ${names.join(', ')} is imported from '${moduleSpecifier}'; a controller's wire shapes may only take types from ${options.carriedTypeImports.map((prefix) => `'${prefix}'`).join(', ')} or from another controller.`,
    });
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
    return {
        endpoint: {
            name: propertyName,
            requestType: parameter?.type?.getText(sourceFile),
            requestOptional: parameter?.questionToken !== undefined || parameter?.initializer !== undefined,
            responseType: handler.type.getText(sourceFile),
            jsDoc: readLeadingJsDoc(property, sourceFile),
        },
        problems,
    };
}

function findEndpointsCall(statement: ts.VariableStatement, endpointsConstantName: string): ts.CallExpression | undefined {
    for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== endpointsConstantName) continue;
        const initializer = declaration.initializer;
        if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'defineEndpoints') return initializer;
    }
    return undefined;
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

    const typeImports: CarriedTypeImport[] = [];
    const typeDeclarations: TypeDeclaration[] = [];
    const endpoints: EndpointSignature[] = [];
    let endpointsFound = false;

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const result = readTypeImport(statement, filePath, options);
            problems.push(...result.problems);
            if (result.typeImport) typeImports.push(result.typeImport);
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
            const jsDoc = readLeadingJsDoc(statement, sourceFile);
            typeDeclarations.push({ name: statement.name.text, text: `${jsDoc ? `${jsDoc}\n` : ''}${statement.getText(sourceFile)}` });
        } else if (ts.isVariableStatement(statement)) {
            const call = findEndpointsCall(statement, endpointsConstantName);
            if (!call) continue;
            endpointsFound = true;
            const argument = call.arguments[0];
            if (!argument || !ts.isObjectLiteralExpression(argument)) {
                problems.push({ filePath, message: `${endpointsConstantName} must be defineEndpoints({ ... }) with the endpoints written inline.` });
                continue;
            }
            for (const property of argument.properties) {
                const result = readEndpoint(property, filePath, sourceFile);
                problems.push(...result.problems);
                if (result.endpoint) endpoints.push(result.endpoint);
            }
        }
    }
    if (!endpointsFound) {
        problems.push({ filePath, message: `must declare 'export const ${endpointsConstantName} = defineEndpoints({ ... })'.` });
    }
    if (problems.length > 0) return { problems };
    return {
        contract: { name, filePath, endpointsTypeName: `${toPascalCase(name)}Endpoints`, clientName: `${name}Api`, typeImports, typeDeclarations, endpoints },
        problems,
    };
}
