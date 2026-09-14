import { vi, type Mock } from 'vitest';

export const create: Mock = vi.fn((options: { name: string; message: string }) => {
    const suiteScriptError = new Error(options.message);
    suiteScriptError.name = options.name;
    return suiteScriptError;
});
