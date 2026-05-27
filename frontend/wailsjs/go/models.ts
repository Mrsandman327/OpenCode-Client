export namespace model {
	
	export class APIResult {
	    success: boolean;
	    status: number;
	    body: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new APIResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.status = source["status"];
	        this.body = source["body"];
	        this.error = source["error"];
	    }
	}
	export class AggregatedSourceInfo {
	    path: string;
	    source: string;
	
	    static createFrom(source: any = {}) {
	        return new AggregatedSourceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.source = source["source"];
	    }
	}
	export class CmdInfo {
	    name: string;
	    sub: string;
	    options: string;
	    desc: string;
	
	    static createFrom(source: any = {}) {
	        return new CmdInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.sub = source["sub"];
	        this.options = source["options"];
	        this.desc = source["desc"];
	    }
	}
	export class CmdGroup {
	    title: string;
	    cmds: CmdInfo[];
	    isTui: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CmdGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.cmds = this.convertValues(source["cmds"], CmdInfo);
	        this.isTui = source["isTui"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class DirectoryEntry {
	    name: string;
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new DirectoryEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	    }
	}
	export class FileBrowserItem {
	    name: string;
	    path: string;
	    type: string;
	    ext: string;
	    size: number;
	    modifiedAt: string;
	    mime: string;
	
	    static createFrom(source: any = {}) {
	        return new FileBrowserItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.type = source["type"];
	        this.ext = source["ext"];
	        this.size = source["size"];
	        this.modifiedAt = source["modifiedAt"];
	        this.mime = source["mime"];
	    }
	}
	export class FileBrowserListResult {
	    rootDir: string;
	    currentPath: string;
	    parentPath: string;
	    items: FileBrowserItem[];
	
	    static createFrom(source: any = {}) {
	        return new FileBrowserListResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rootDir = source["rootDir"];
	        this.currentPath = source["currentPath"];
	        this.parentPath = source["parentPath"];
	        this.items = this.convertValues(source["items"], FileBrowserItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FileBrowserRawResult {
	    rootDir: string;
	    path: string;
	    name: string;
	    mime: string;
	    base64: string;
	
	    static createFrom(source: any = {}) {
	        return new FileBrowserRawResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rootDir = source["rootDir"];
	        this.path = source["path"];
	        this.name = source["name"];
	        this.mime = source["mime"];
	        this.base64 = source["base64"];
	    }
	}
	export class FileBrowserReadResult {
	    rootDir: string;
	    path: string;
	    content: string;
	    encoding: string;
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileBrowserReadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rootDir = source["rootDir"];
	        this.path = source["path"];
	        this.content = source["content"];
	        this.encoding = source["encoding"];
	        this.truncated = source["truncated"];
	    }
	}
	export class FileBrowserStatResult {
	    rootDir: string;
	    name: string;
	    path: string;
	    type: string;
	    ext: string;
	    size: number;
	    modifiedAt: string;
	    mime: string;
	    previewKind: string;
	    previewable: boolean;
	    editable: boolean;
	    defaultMode: string;
	
	    static createFrom(source: any = {}) {
	        return new FileBrowserStatResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rootDir = source["rootDir"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.type = source["type"];
	        this.ext = source["ext"];
	        this.size = source["size"];
	        this.modifiedAt = source["modifiedAt"];
	        this.mime = source["mime"];
	        this.previewKind = source["previewKind"];
	        this.previewable = source["previewable"];
	        this.editable = source["editable"];
	        this.defaultMode = source["defaultMode"];
	    }
	}
	export class FileBrowserUploadResult {
	    success: boolean;
	    conflict: boolean;
	    name?: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new FileBrowserUploadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.conflict = source["conflict"];
	        this.name = source["name"];
	        this.error = source["error"];
	    }
	}
	export class GitActionResult {
	    success: boolean;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new GitActionResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	    }
	}
	export class GitChangedFile {
	    path: string;
	    name: string;
	    statusCode: string;
	    tracked: boolean;
	    hasStaged: boolean;
	    hasUnstaged: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitChangedFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.statusCode = source["statusCode"];
	        this.tracked = source["tracked"];
	        this.hasStaged = source["hasStaged"];
	        this.hasUnstaged = source["hasUnstaged"];
	    }
	}
	export class GitCommitChangedFile {
	    path: string;
	    displayName: string;
	    status: string;
	    oldPath?: string;
	
	    static createFrom(source: any = {}) {
	        return new GitCommitChangedFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.displayName = source["displayName"];
	        this.status = source["status"];
	        this.oldPath = source["oldPath"];
	    }
	}
	export class GitDiffLine {
	    kind: string;
	    oldNo: number;
	    newNo: number;
	    text: string;
	
	    static createFrom(source: any = {}) {
	        return new GitDiffLine(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.oldNo = source["oldNo"];
	        this.newNo = source["newNo"];
	        this.text = source["text"];
	    }
	}
	export class GitDiffBlock {
	    left: GitDiffLine[];
	    right: GitDiffLine[];
	
	    static createFrom(source: any = {}) {
	        return new GitDiffBlock(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.left = this.convertValues(source["left"], GitDiffLine);
	        this.right = this.convertValues(source["right"], GitDiffLine);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitCommitFilePreviewResult {
	    commitHash: string;
	    filePath: string;
	    blocks: GitDiffBlock[];
	
	    static createFrom(source: any = {}) {
	        return new GitCommitFilePreviewResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.commitHash = source["commitHash"];
	        this.filePath = source["filePath"];
	        this.blocks = this.convertValues(source["blocks"], GitDiffBlock);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitCommitFilesResult {
	    commitHash: string;
	    files: GitCommitChangedFile[];
	
	    static createFrom(source: any = {}) {
	        return new GitCommitFilesResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.commitHash = source["commitHash"];
	        this.files = this.convertValues(source["files"], GitCommitChangedFile);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class GitFilePreviewResult {
	    path: string;
	    tracked: boolean;
	    hasStaged: boolean;
	    hasUnstaged: boolean;
	    stagedBlocks: GitDiffBlock[];
	    unstagedBlocks: GitDiffBlock[];
	    untrackedContent: string;
	
	    static createFrom(source: any = {}) {
	        return new GitFilePreviewResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.tracked = source["tracked"];
	        this.hasStaged = source["hasStaged"];
	        this.hasUnstaged = source["hasUnstaged"];
	        this.stagedBlocks = this.convertValues(source["stagedBlocks"], GitDiffBlock);
	        this.unstagedBlocks = this.convertValues(source["unstagedBlocks"], GitDiffBlock);
	        this.untrackedContent = source["untrackedContent"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitHistoryItem {
	    hash: string;
	    shortHash: string;
	    subject: string;
	    author: string;
	    date: string;
	    synced: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitHistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.shortHash = source["shortHash"];
	        this.subject = source["subject"];
	        this.author = source["author"];
	        this.date = source["date"];
	        this.synced = source["synced"];
	    }
	}
	export class GitHistoryResult {
	    items: GitHistoryItem[];
	    hasMore: boolean;
	    offset: number;
	    limit: number;
	
	    static createFrom(source: any = {}) {
	        return new GitHistoryResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.items = this.convertValues(source["items"], GitHistoryItem);
	        this.hasMore = source["hasMore"];
	        this.offset = source["offset"];
	        this.limit = source["limit"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitStatusResult {
	    isGitRepo: boolean;
	    files: GitChangedFile[];
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new GitStatusResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.isGitRepo = source["isGitRepo"];
	        this.files = this.convertValues(source["files"], GitChangedFile);
	        this.message = source["message"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GlobalConfigInfo {
	    path: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new GlobalConfigInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	    }
	}
	export class ImportableSkill {
	    name: string;
	    description: string;
	    sourceDir: string;
	    sourcePath: string;
	    imported: boolean;
	    globalExist: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ImportableSkill(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.sourceDir = source["sourceDir"];
	        this.sourcePath = source["sourcePath"];
	        this.imported = source["imported"];
	        this.globalExist = source["globalExist"];
	    }
	}
	export class ModelEntry {
	    key: string;
	    type: string;
	    model: string;
	    variant: string;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new ModelEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.type = source["type"];
	        this.model = source["model"];
	        this.variant = source["variant"];
	        this.comment = source["comment"];
	    }
	}
	export class ModelInfo {
	    id: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new ModelInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	    }
	}
	export class ProjectConfigFileEntry {
	    name: string;
	    path: string;
	    type: string;
	    description?: string;
	
	    static createFrom(source: any = {}) {
	        return new ProjectConfigFileEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.type = source["type"];
	        this.description = source["description"];
	    }
	}
	export class ProjectConfigFileResult {
	    path: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new ProjectConfigFileResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	    }
	}
	export class ProjectConfigTab {
	    exists: boolean;
	    message: string;
	    files: ProjectConfigFileEntry[];
	
	    static createFrom(source: any = {}) {
	        return new ProjectConfigTab(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.exists = source["exists"];
	        this.message = source["message"];
	        this.files = this.convertValues(source["files"], ProjectConfigFileEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectConfigSummary {
	    rootDir: string;
	    coreConfig: ProjectConfigTab;
	    skills: ProjectConfigTab;
	    agentsMd: ProjectConfigTab;
	    commands: ProjectConfigTab;
	    rules: ProjectConfigTab;
	
	    static createFrom(source: any = {}) {
	        return new ProjectConfigSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rootDir = source["rootDir"];
	        this.coreConfig = this.convertValues(source["coreConfig"], ProjectConfigTab);
	        this.skills = this.convertValues(source["skills"], ProjectConfigTab);
	        this.agentsMd = this.convertValues(source["agentsMd"], ProjectConfigTab);
	        this.commands = this.convertValues(source["commands"], ProjectConfigTab);
	        this.rules = this.convertValues(source["rules"], ProjectConfigTab);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class ProviderInfo {
	    key: string;
	    name: string;
	    baseURL: string;
	    apiKey: string;
	    npm: string;
	    enabled: boolean;
	    models: ModelInfo[];
	
	    static createFrom(source: any = {}) {
	        return new ProviderInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.name = source["name"];
	        this.baseURL = source["baseURL"];
	        this.apiKey = source["apiKey"];
	        this.npm = source["npm"];
	        this.enabled = source["enabled"];
	        this.models = this.convertValues(source["models"], ModelInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProviderSave {
	    key: string;
	    name: string;
	    baseURL: string;
	    apiKey: string;
	    npm: string;
	    enabled: boolean;
	    models: ModelInfo[];
	
	    static createFrom(source: any = {}) {
	        return new ProviderSave(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.name = source["name"];
	        this.baseURL = source["baseURL"];
	        this.apiKey = source["apiKey"];
	        this.npm = source["npm"];
	        this.enabled = source["enabled"];
	        this.models = this.convertValues(source["models"], ModelInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProxyConfig {
	    proxyEnabled: boolean;
	    proxyHost: string;
	    proxyPort: string;
	
	    static createFrom(source: any = {}) {
	        return new ProxyConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.proxyEnabled = source["proxyEnabled"];
	        this.proxyHost = source["proxyHost"];
	        this.proxyPort = source["proxyPort"];
	    }
	}
	export class SaveResult {
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new SaveResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}
	export class SchemeApplyResult {
	    applied: string[];
	    missing: string[];
	    conflicts: string[];
	    errors: string[];
	    success: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SchemeApplyResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.applied = source["applied"];
	        this.missing = source["missing"];
	        this.conflicts = source["conflicts"];
	        this.errors = source["errors"];
	        this.success = source["success"];
	    }
	}
	export class SchemeInfo {
	    name: string;
	    fileName: string;
	    fullPath: string;
	
	    static createFrom(source: any = {}) {
	        return new SchemeInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.fileName = source["fileName"];
	        this.fullPath = source["fullPath"];
	    }
	}
	export class Stats {
	    globalSkills: number;
	
	    static createFrom(source: any = {}) {
	        return new Stats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.globalSkills = source["globalSkills"];
	    }
	}
	export class SkillInfo {
	    name: string;
	    description: string;
	    path: string;
	    linked: boolean;
	    source: string;
	    conflict: boolean;
	    noSources: boolean;
	    sources: AggregatedSourceInfo[];
	    enableable: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SkillInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.path = source["path"];
	        this.linked = source["linked"];
	        this.source = source["source"];
	        this.conflict = source["conflict"];
	        this.noSources = source["noSources"];
	        this.sources = this.convertValues(source["sources"], AggregatedSourceInfo);
	        this.enableable = source["enableable"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SkillConfigResult {
	    sourceDirs: string[];
	    skills: SkillInfo[];
	    stats: Stats;
	
	    static createFrom(source: any = {}) {
	        return new SkillConfigResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourceDirs = source["sourceDirs"];
	        this.skills = this.convertValues(source["skills"], SkillInfo);
	        this.stats = this.convertValues(source["stats"], Stats);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class ToggleResult {
	    skillName: string;
	    linked: boolean;
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ToggleResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.skillName = source["skillName"];
	        this.linked = source["linked"];
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}
	export class WebResult {
	    running: boolean;
	    success: boolean;
	    url: string;
	    health: string;
	    version: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new WebResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.success = source["success"];
	        this.url = source["url"];
	        this.health = source["health"];
	        this.version = source["version"];
	        this.error = source["error"];
	    }
	}

}

