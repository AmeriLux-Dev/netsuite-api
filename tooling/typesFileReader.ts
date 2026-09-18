import ts from 'typescript';
import { readLeadingJsDoc } from './controllerReader.js';
import type { ControllerProblem, TypeDeclaration, TypeImportName } from './controllerReader.js';
import { collectTypeReferences } from './wireTypes.js';

/**
 * Reads a file whose type declarations the generator copies into a controller's generated module:
 * the generated entity types, or a service (its functions are skipped; its types are what a
 * controller builds wire shapes from). A controller names the types it imports from the file; each
 * of those is copied with every type it refers to, in the same file or, through an import, in
 * another inlinable file, so the generated module stands on its own. A type built on something no
 * inlinable file declares (the repository package's EntityCreate and EntityPatch) cannot be copied,
 * because the client would need that package to resolve it.
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
    /** The imports written `Name as Local`: the local name mapped to the name the module exports. */
    renamedImports: Map<string, string>;
}

/** The declarations to copy from one file. */
export interface SelectedInlinedSection {
    filePath: string;
    /** In file order; the section of the file the controller named ends with an alias for every renamed import. */
    declarations: TypeDeclaration[];
}

export interface SelectedInlinedTypes {
    /** One section per file the selection reached, the file the controller named first. */
    sections: SelectedInlinedSection[];
    problems: ControllerProblem[];
}

/**
 * Resolves a specifier written in an inlinable file to the inlinable file it names: undefined when
 * the client could not carry it, 'missing' when it names an inlinable file that does not exist (the
 * resolver reports that itself).
 */
export type ResolveInlinableImport = (specifier: string) => InlinableTypesFile | 'missing' | undefined;


function readImportedNames(statement: ts.ImportDeclaration, importedNames: Map<string, string>, renamedImports: Map<string, string>): void {
    const clause = statement.importClause;
    if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) return;
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (clause.name) importedNames.set(clause.name.text, moduleSpecifier);
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) importedNames.set(bindings.name.text, moduleSpecifier);
    else {
        for (const element of bindings.elements) {
            importedNames.set(element.name.text, moduleSpecifier);
            if (element.propertyName) renamedImports.set(element.name.text, element.propertyName.text);
        }
    }
}

export function readInlinableTypesFile(filePath: string, source: string): InlinableTypesFile {
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = new Map<string, InlinableTypeDeclaration>();
    const importedNames = new Map<string, string>();
    const renamedImports = new Map<string, string>();
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            readImportedNames(statement, importedNames, renamedImports);
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
    return { filePath, declarations, importedNames, renamedImports };
}

/**
 * The declarations a controller's imports pull out of the file: the named types and, transitively,
 * what they refer to. A reference to a name the file imports is followed into the inlinable file the
 * import resolves to, so a service's summary type built on an entity type carries the entity type
 * with it. A name the file does not declare, or an import the client could not carry, is a problem
 * reported against the controller.
 */
export function selectInlinedTypes(file: InlinableTypesFile, names: TypeImportName[], controllerPath: string, resolveImport: ResolveInlinableImport = () => undefined): SelectedInlinedTypes {
    const problems: ControllerProblem[] = [];
    const reached = new Map<string, InlinableTypesFile>([[file.filePath, file]]);
    const selectedByFile = new Map<string, Set<string>>();
    const selectedIn = (current: InlinableTypesFile): Set<string> => {
        let selected = selectedByFile.get(current.filePath);
        if (!selected) {
            selected = new Set<string>();
            selectedByFile.set(current.filePath, selected);
        }
        return selected;
    };
    const pending: { file: InlinableTypesFile; name: string; dependent?: string }[] = names.map((imported) => ({ file, name: imported.name }));
    while (pending.length > 0) {
        const { file: current, name, dependent } = pending.shift() as { file: InlinableTypesFile; name: string; dependent?: string };
        const selected = selectedIn(current);
        if (selected.has(name)) continue;
        const declaration = current.declarations.get(name);
        if (declaration) {
            selected.add(name);
            pending.push(...declaration.references.map((reference) => ({ file: current, name: reference, dependent: name })));
            continue;
        }
        const importedFrom = current.importedNames.get(name);
        if (importedFrom !== undefined) {
            const imported = resolveImport(importedFrom);
            const exportedName = current.renamedImports.get(name);
            if (imported === 'missing') {
                // The resolver reported the missing file; the reference has nothing to say beyond that.
            } else if (imported && exportedName === undefined) {
                if (!reached.has(imported.filePath)) reached.set(imported.filePath, imported);
                selected.add(name);
                pending.push({ file: imported, name, dependent });
            } else if (imported) {
                problems.push({
                    filePath: controllerPath,
                    about: dependent ?? name,
                    message: dependent
                        ? `type '${dependent}' (${current.filePath}) is built on ${name}, imported from '${importedFrom}' as a rename of ${exportedName}; import it under its own name so the client can carry it.`
                        : `type '${name}' is imported into ${current.filePath} from '${importedFrom}' as a rename of ${exportedName}; import it under its own name so the client can carry it.`,
                });
            } else {
                problems.push({
                    filePath: controllerPath,
                    about: dependent ?? name,
                    message: dependent
                        ? `type '${dependent}' (${current.filePath}) is built on ${name} from '${importedFrom}', which the client cannot carry; write the wire shape out in the controller instead.`
                        : `type '${name}' is imported into ${current.filePath} from '${importedFrom}', not declared there; the client cannot carry it.`,
                });
            }
        } else if (dependent === undefined) {
            problems.push({ filePath: controllerPath, about: name, message: `type '${name}' is not declared in ${current.filePath}.` });
        }
        // Anything else a declaration refers to is a global (Date, Record, Array): nothing to copy.
    }
    const sections: SelectedInlinedSection[] = Array.from(reached.values()).map((current) => {
        const selected = selectedByFile.get(current.filePath);
        return {
            filePath: current.filePath,
            declarations: Array.from(current.declarations.values())
                .filter((declaration) => selected?.has(declaration.name))
                .map(({ name, text }) => ({ name, text })),
        };
    });
    const resolvedNames = new Set(sections.flatMap((section) => section.declarations.map((declaration) => declaration.name)));
    for (const imported of names) {
        if (imported.alias && resolvedNames.has(imported.name)) sections[0].declarations.push({ name: imported.alias, text: `export type ${imported.alias} = ${imported.name};` });
    }
    return { sections: sections.filter((section, index) => index === 0 || section.declarations.length > 0), problems };
}
