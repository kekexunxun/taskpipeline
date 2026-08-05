export type WikiFile = {
    path: string;
    title: string;
    content: string;
    mtime: string;
    hash: string;
};
export declare function sha1(content: string): string;
export declare function collectRepoWikiDocs(localPath: string): WikiFile[];
