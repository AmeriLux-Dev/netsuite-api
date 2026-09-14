import { vi, type Mock } from 'vitest';

export const load: Mock = vi.fn((options: { id: number | string }) => ({ id: options.id, url: `/core/media/media.nl?id=${options.id}`, getContents: () => '' }));
export const create: Mock = vi.fn();
const deleteFile: Mock = vi.fn();
export { deleteFile as delete };
export const Type = { PLAINTEXT: 'PLAINTEXT', JAVASCRIPT: 'JAVASCRIPT' };
