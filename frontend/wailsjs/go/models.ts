export namespace main {
	
	export class BatchResult {
	    target: string;
	    enabled: boolean;
	    success: boolean;
	    errors: string[];
	
	    static createFrom(source: any = {}) {
	        return new BatchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.target = source["target"];
	        this.enabled = source["enabled"];
	        this.success = source["success"];
	        this.errors = source["errors"];
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
	
	export class ModelEntry {
	    key: string;
	    type: string;
	    model: string;
	    label: string;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new ModelEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.type = source["type"];
	        this.model = source["model"];
	        this.label = source["label"];
	        this.comment = source["comment"];
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
	export class SkillInfo {
	    name: string;
	    description: string;
	    sourcePath: string;
	    targets: Record<string, boolean>;
	
	    static createFrom(source: any = {}) {
	        return new SkillInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.sourcePath = source["sourcePath"];
	        this.targets = source["targets"];
	    }
	}
	export class Stats {
	    totalSkills: number;
	    targetStats: Record<string, number>;
	
	    static createFrom(source: any = {}) {
	        return new Stats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.totalSkills = source["totalSkills"];
	        this.targetStats = source["targetStats"];
	    }
	}
	export class TargetInfo {
	    key: string;
	    label: string;
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new TargetInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.label = source["label"];
	        this.path = source["path"];
	    }
	}
	export class ToggleResult {
	    skillName: string;
	    target: string;
	    linked: boolean;
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ToggleResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.skillName = source["skillName"];
	        this.target = source["target"];
	        this.linked = source["linked"];
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}

}

