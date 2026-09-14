import * as file from 'N/file';
import * as search from 'N/search';

/**
 * File Cabinet lookups by folder and file name. The host Suitelet finds the client bundle this
 * way on purpose: internal ids differ between accounts, names do not.
 */

export interface FileCabinetLocation {
    /** Folder directly under /SuiteScripts, e.g. the application folder. */
    parentFolderName: string;
    /** Folder inside the parent, e.g. "client". */
    folderName: string;
    fileName: string;
}

export function findFolderId(folderName: string, parentFolderName: string): number | undefined {
    const folderSearch = search.create({
        type: 'folder',
        filters: [
            ['name', search.Operator.IS, folderName],
            'AND',
            ['formulatext: {parent}', search.Operator.IS, parentFolderName],
        ],
        columns: ['internalid'],
    });
    const results = folderSearch.run().getRange({ start: 0, end: 1 });
    return results.length > 0 ? Number(results[0].id) : undefined;
}

export function findFileId(location: FileCabinetLocation): number | undefined {
    const folderId = findFolderId(location.folderName, location.parentFolderName);
    if (folderId === undefined) return undefined;

    const fileSearch = search.create({
        type: 'file',
        filters: [
            ['name', search.Operator.IS, location.fileName],
            'AND',
            ['folder', search.Operator.ANYOF, String(folderId)],
        ],
        columns: ['internalid'],
    });
    const results = fileSearch.run().getRange({ start: 0, end: 2 });
    if (results.length > 1) {
        throw new Error(`Multiple files named ${location.fileName} in ${location.parentFolderName}/${location.folderName}.`);
    }
    return results.length === 1 ? Number(results[0].id) : undefined;
}

export function getFileUrlByName(location: FileCabinetLocation): string | undefined {
    const fileId = findFileId(location);
    if (fileId === undefined) return undefined;
    return file.load({ id: fileId }).url;
}
