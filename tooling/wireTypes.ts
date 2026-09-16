import ts from 'typescript';

/**
 * JSON carries no dates: a Date on the wire is an ISO 8601 string in both directions, and neither
 * side revives it. So the generated client module says `string` wherever a wire shape says `Date`,
 * and a request shape may not carry a Date at all, because the handler would receive a string where
 * its annotation promises a Date. The shapes are text (the declarations as written, the handler
 * annotations), so both operations parse the text and work on the syntax tree.
 */

/** A fragment is a whole declaration (`export interface X { ... }`) or a bare type annotation (`Date[]`). */
export type WireFragmentKind = 'declaration' | 'type';

const TYPE_FRAGMENT_PREFIX = 'type __WireFragment = ';

function parseFragment(text: string, kind: WireFragmentKind): { sourceFile: ts.SourceFile; offset: number } {
    const source = kind === 'type' ? `${TYPE_FRAGMENT_PREFIX}${text};` : text;
    return { sourceFile: ts.createSourceFile('wire.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), offset: kind === 'type' ? TYPE_FRAGMENT_PREFIX.length : 0 };
}

function leftmostIdentifier(name: ts.EntityName): string {
    return ts.isIdentifier(name) ? name.text : leftmostIdentifier(name.left);
}

/** Collects, in order met and each once, the names a node refers to: type references, heritage clauses and typeof targets. */
export function collectTypeReferences(node: ts.Node, references: string[]): void {
    let referenced: string | undefined;
    if (ts.isTypeReferenceNode(node)) referenced = leftmostIdentifier(node.typeName);
    else if (ts.isTypeQueryNode(node)) referenced = leftmostIdentifier(node.exprName);
    else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) referenced = node.expression.text;
    if (referenced !== undefined && !references.includes(referenced)) references.push(referenced);
    ts.forEachChild(node, (child) => collectTypeReferences(child, references));
}

/** The names a fragment refers to, `Date` included when it does. */
export function readReferencedNames(text: string, kind: WireFragmentKind): string[] {
    const { sourceFile } = parseFragment(text, kind);
    const references: string[] = [];
    collectTypeReferences(sourceFile, references);
    return references.filter((name) => name !== '__WireFragment');
}

function isDateReference(node: ts.Node): node is ts.TypeReferenceNode {
    return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Date' && node.typeArguments === undefined;
}

function collectNodes<TNode extends ts.Node>(node: ts.Node, matches: (candidate: ts.Node) => candidate is TNode, found: TNode[]): void {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, (child) => collectNodes(child, matches, found));
}

/** The fragment with every `Date` type reference written as `string`, everything else byte for byte as it was. */
export function writeDatesAsStrings(text: string, kind: WireFragmentKind): string {
    const { sourceFile, offset } = parseFragment(text, kind);
    const references: ts.TypeReferenceNode[] = [];
    collectNodes(sourceFile, isDateReference, references);
    let result = text;
    for (const reference of references.sort((left, right) => right.getStart(sourceFile) - left.getStart(sourceFile))) {
        const start = reference.getStart(sourceFile) - offset;
        const end = reference.getEnd() - offset;
        result = `${result.slice(0, start)}string${result.slice(end)}`;
    }
    return result;
}
