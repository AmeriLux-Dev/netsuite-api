import { vi, type Mock } from 'vitest';

export const FieldType = { INLINEHTML: 'INLINEHTML', LABEL: 'LABEL', TEXT: 'TEXT' };

export const createForm: Mock = vi.fn((options: { title: string }) => ({
    title: options.title,
    clientScriptModulePath: '',
    addField: vi.fn((field: { id: string }) => ({ id: field.id, defaultValue: '' })),
}));
