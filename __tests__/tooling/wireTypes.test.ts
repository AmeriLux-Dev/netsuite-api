import { describe, expect, it } from 'vitest';
import { readReferencedNames, writeDatesAsStrings } from '../../tooling/wireTypes.js';

describe('writeDatesAsStrings', () => {
    it('writes every Date type reference as string in a declaration and leaves everything else as it was', () => {
        const declaration = '/** When. */\nexport interface Shift {\n    date: Date;\n    window: [Date, Date | null];\n    nested: Promise<Date>;\n    label: string;\n}';
        expect(writeDatesAsStrings(declaration, 'declaration')).toBe('/** When. */\nexport interface Shift {\n    date: string;\n    window: [string, string | null];\n    nested: Promise<string>;\n    label: string;\n}');
    });

    it('rewrites a bare type annotation, and touches neither a property named date nor a text without a Date', () => {
        expect(writeDatesAsStrings('Date[]', 'type')).toBe('string[]');
        expect(writeDatesAsStrings('{ from: Date; date: number }', 'type')).toBe('{ from: string; date: number }');
        expect(writeDatesAsStrings('export type Id = number;', 'declaration')).toBe('export type Id = number;');
    });
});

describe('readReferencedNames', () => {
    it('lists the names a fragment refers to, Date included, each once', () => {
        expect(readReferencedNames('{ from: Date; to: Date; who: Employee }', 'type')).toEqual(['Date', 'Employee']);
        expect(readReferencedNames('export interface Line extends Base { item: Pick<Item, "id">; when: Date }', 'declaration')).toEqual(['Base', 'Pick', 'Item', 'Date']);
    });
});
