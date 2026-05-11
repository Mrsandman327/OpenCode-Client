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
	
	export class CmdPaletteItem {
	    name: string;
	    description: string;
	    source: string;
	
	    static createFrom(source: any = {}) {
	        return new CmdPaletteItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.source = source["source"];
	    }
	}
	export class ModelEntry {
	    key: string;
	    type: string;
	    model: string;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new ModelEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.type = source["type"];
	        this.model = source["model"];
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
	export class ModelSaveResult {
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ModelSaveResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}
	export class ProviderInfo {
	    key: string;
	    name: string;
	    baseURL: string;
	    apiKey: string;
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
	export class SessionInfo {
	    id: string;
	    title: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	    }
	}
	export class SkillInfo {
	    name: string;
	    description: string;
	    path: string;
	    linked: boolean;
	    source: string;
	
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

