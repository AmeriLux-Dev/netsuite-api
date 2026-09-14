import ts from 'typescript';
import { readLeadingJsDoc } from './controllerReader.js';
import type { ControllerProblem } from './controllerReader.js';

/**
 * Reads the project's app file (netsuite.ts): the application's names and the ids no controller or
 * model owns. The client module carries it verbatim, so the file is plain declarations: exported
 * constants and types, no imports, nothing that runs. The generator names anything else.
 */

export interface AppDeclarations {
    /** Every exported declaration as written, JSDoc included, in file order. */
    declarations: string[];
    problems: ControllerProblem[];
}

function hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function describeStatement(statement: ts.Statement, sourceFile: ts.SourceFile): string {
    return statement.getText(sourceFile).split('\n')[0].trim();
}

export function readAppDeclarations(filePath: string, source: string): AppDeclarations {
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations: string[] = [];
    const problems: ControllerProblem[] = [];
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            problems.push({ filePath, message: `imports nothing: it is copied into the client module verbatim (found ${describeStatement(statement, sourceFile)}).` });
            continue;
        }
        const isDeclaration = ts.isVariableStatement(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement);
        if (!isDeclaration || !hasExportModifier(statement)) {
            problems.push({ filePath, message: `holds exported constants and types only, because the client module carries it verbatim (found ${describeStatement(statement, sourceFile)}).` });
            continue;
        }
        if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Const)) {
            problems.push({ filePath, message: `exports constants only (found ${describeStatement(statement, sourceFile)}).` });
            continue;
        }
        const jsDoc = readLeadingJsDoc(statement, sourceFile);
        declarations.push(`${jsDoc ? `${jsDoc}\n` : ''}${statement.getText(sourceFile)}`);
    }
    return { declarations, problems };
}
