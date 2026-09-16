package model

// ========== 知识库相关 ==========

// KnowledgeEntry 知识库条目。
type KnowledgeEntry struct {
	ID        string   `json:"id"`        // 文件名即 ID（不含 .md）
	Title     string   `json:"title"`     // 标题
	Category  string   `json:"category"`  // 所属分类 ID（单个）
	Tags      []string `json:"tags"`      // 标签（多值）
	Summary   string   `json:"summary"`   // 说明，用户手填的必填短文本（非自动摘要）
	Created   string   `json:"created"`   // 创建时间，格式 "2006-01-02 15:04"
	Updated   string   `json:"updated"`   // 更新时间，同上
	Converted []string `json:"converted"` // 转化记录，如 ["全局命令:deploy"]
	Content   string   `json:"content"`   // 正文（列表接口可不返回）
}

// KnowledgeCategory 知识库分类（树形）。
type KnowledgeCategory struct {
	ID       string              `json:"id"`
	Name     string              `json:"name"`
	Children []KnowledgeCategory `json:"children"`
}

// ConvertRequest 知识库条目转化为 OpenCode 资产的请求。
type ConvertRequest struct {
	ID         string `json:"id"`         // 知识库条目 ID
	Kind       string `json:"kind"`       // 目标类型：skill | command | rule | agents
	Scope      string `json:"scope"`      // 作用域：global | project
	ProjectDir string `json:"projectDir"` // scope=project 时的项目根目录
	Name       string `json:"name"`       // 目标名称（不含扩展名）；技能为目录名，agents 固定为 AGENTS
	SyncMode   string `json:"syncMode"`   // 同步方式：copy | symlink
}

// ConvertPreview 转化预览结果，纯读取计算，不产生任何写入。
type ConvertPreview struct {
	TargetPath   string `json:"targetPath"`   // 将要写入的完整路径
	Mode         string `json:"mode"`         // create | overwrite | append
	NewContent   string `json:"newContent"`   // 写入后目标的完整内容（append 时含原有内容）
	OldContent   string `json:"oldContent"`   // 目标已存在时的原有内容，否则为空
	Exists       bool   `json:"exists"`       // 目标是否已存在
	AppendAtLine int    `json:"appendAtLine"` // mode=append 时追加块的起始行号（1 基）
}
