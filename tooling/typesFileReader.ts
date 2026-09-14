import ts from 'typescript';
import { readLeadingJsDoc } from './controllerReader.js';
import type { ControllerProblem, TypeDeclaration, TypeImportName } from './controllerReader.js';

/**
 * Reads a type-only file whose declarations the generator copies into a controller's generated
 * module: the generated entity types. A controller names the types it imports from the file; each
 * of those is copied with every type it refers to in the same file, so the generated module stands
 * on its own. A type built on something the file imports (the repository package's EntityCreate and
 * EntityPatch) cannot be copied, because the client would need that package to resolve it.
 */

export interface InlinableTypeDeclaration extends TypeDeclaration {
    /** The names of the types the declaration refers to, each once, in the order met. */
    references: string[];
}

export interface InlinableTypesFile {
    /** How a problem names the file: its path relative to the project. */
    filePath: string;
    /** Every top-level type declaration by name, in file order. */
    declarations: Map<string, InlinableTypeDeclaration>;
    /** Every name the file imports, mapped to the module it comes from. */
    importedNames: Map<string, string>;
}

export interface SelectedInlinedTypes {
    /** The declarations to copy, in file order, followed by an alias for every renamed import. */
    declarations: TypeDeclaration[];
    problems: ControllerProblem[];
}

function leftmostIdentifier(name: ts.EntityName): string {
    return ts.isIdentifier(name) ? name.text : leftmostIdentifier(name.left);
}

function collectTypeReferences(node: ts.Node, references: string[]): void {
    let referenced: string | undefined;
    if (ts.isTypeReferenceNode(node)) referenced = leftmostIdentifier(node.typeName);
    else if (ts.isTypeQueryNode(node)) referenced = leftmostIdentifier(node.exprName);
    else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) referenced = node.expression.text;
    if (referenced !== undefined && !references.includes(referenced)) references.push(referenced);
    ts.forEachChild(node, (child) => collectTypeReferences(child, references));
}

function readImportedNames(statement: ts.ImportDeclaration, importedNames: Map<string, string>): void {
    const clause = statement.importClause;
    if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) return;
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (clause.name) importedNames.set(clause.name.text, moduleSpecifier);
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) importedNames.set(bindings.name.text, moduleSpecifier);
    else for (const element of bindings.elements) importedNames.set(element.name.text, moduleSpecifier);
}

export function readInlinableTypesFile(filePath: string, source: string): InlinableTypesFile {
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = new Map<string, InlinableTypeDeclaration>();
    const importedNames = new Map<string, string>();
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            readImportedNames(statement, importedNames);
            continue;
        }
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEnumDeclaration(statement)) continue;
        const references: string[] = [];
        if (!ts.isEnumDeclaration(statement)) {
            const own = new Set<string>([statement.name.text, ...(statement.typeParameters ?? []).map((parameter) => parameter.name.text)]);
            const found: string[] = [];
            collectTypeReferences(statement, found);
            references.push(...found.filter((name) => !own.has(name)));
        }
        const jsDoc = readLeadingJsDoc(statement, sourceFile);
        declarations.set(statement.name.text, { name: statement.name.text, text: `${jsDoc ? `${jsDoc}\n` : ''}${statement.getText(sourceFile)}`, references });
    }
    return { filePath, declarations, importedNames };
}

/**
 * The declarations a controller's imports pull out of the file: the named types and, transitively,
 * what they refer to. A name the file does not declare is a problem reported against the controller.
 */
export function selectInlinedTypes(file: InlinableTypesFile, names: TypeImportName[], controllerPath: string): SelectedInlinedTypes {
    const problems: ControllerProblem[] = [];
    const selected = new Set<string>();
    const pending: { name: string; dependent?: string }[] = names.map((imported) => ({ name: imported.name }));
    while (pending.length > 0) {
        const { name, dependent } = pending.shift() as { name: string; dependent?: string };
        if (selected.has(name)) continue;
        const declaration = file.declarations.get(name);
        if (declaration) {
            selected.add(name);
            pending.push(...declaration.references.map((reference) => ({ name: reference, dependent: name })));
            continue;
        }
        const importedFrom = file.importedNames.get(name);
        if (importedFrom !== undefined) {
            problems.push({
                filePath: controllerPath,
                message: dependent
                    ? `type '${dependent}' (${file.filePath}) is built on ${name} from '${importedFrom}', which the client cannot carry; write the wire shape out in the controller instead.`
                    : `type '${name}' is imported into ${file.filePath} from '${importedFrom}', not declared there; the client cannot carry it.`,
            });
        } else if (dependent === undefined) {
            problems.push({ filePath: controllerPath, message: `type '${name}' is not declared in ${file.filePath}.` });
        }
        // Anything else a declaration refers to is a global (Date, Record, Array): nothing to copy.
    }
    const declarations: TypeDeclaration[] = Array.from(file.declarations.values())
        .filter((declaration) => selected.has(declaration.name))
        .map(({ name, text }) => ({ name, text }));
    for (const imported of names) {
        if (imported.alias && selected.has(imported.name)) declarations.push({ name: imported.alias, text: `export type ${imported.alias} = ${imported.name};` });
    }
    return { declarations, problems };
}
