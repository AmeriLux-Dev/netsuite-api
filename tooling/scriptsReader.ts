import ts from 'typescript';
import type { ControllerProblem } from './controllerReader.js';

/**
 * Reads the `scripts` map of a project from its source: which scripts exist, and which the browser
 * calls. The file cannot be executed here (a template renders placeholders into it), so this is a
 * parse of `export const scripts = { name: { kind, scriptId, deployId, browser? }, ... }`.
 */

export interface ScriptRegistryEntry {
    name: string;
    kind?: string;
    /** False only when the entry says `browser: false`. */
    browser: boolean;
}

export interface ScriptRegistryReadResult {
    entries: Map<string, ScriptRegistryEntry>;
    problems: ControllerProblem[];
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
}

function findScriptsObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'scripts' || !declaration.initializer) continue;
            const initializer = unwrapExpression(declaration.initializer);
            if (ts.isObjectLiteralExpression(initializer)) return initializer;
        }
    }
    return undefined;
}

function readEntry(property: ts.ObjectLiteralElementLike, sourceFile: ts.SourceFile): ScriptRegistryEntry | undefined {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return undefined;
    const value = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(value)) return undefined;
    const entry: ScriptRegistryEntry = { name: property.name.text, browser: true };
    for (const member of value.properties) {
        if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) continue;
        const memberValue = unwrapExpression(member.initializer);
        if (member.name.text === 'kind' && ts.isStringLiteral(memberValue)) entry.kind = memberValue.text;
        if (member.name.text === 'browser') entry.browser = memberValue.kind !== ts.SyntaxKind.FalseKeyword;
    }
    void sourceFile;
    return entry;
}

export function readScriptRegistry(filePath: string, source: string): ScriptRegistryReadResult {
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const entries = new Map<string, ScriptRegistryEntry>();
    const scriptsObject = findScriptsObject(sourceFile);
    if (!scriptsObject) {
        return { entries, problems: [{ filePath, message: "declares no 'export const scripts = { ... }'." }] };
    }
    const problems: ControllerProblem[] = [];
    for (const property of scriptsObject.properties) {
        const entry = readEntry(property, sourceFile);
        if (entry) entries.set(entry.name, entry);
        else problems.push({ filePath, message: `scripts has an entry that is not 'name: { kind, scriptId, deployId }' (${property.getText(sourceFile).split('\n')[0]}).` });
    }
    return { entries, problems };
}
