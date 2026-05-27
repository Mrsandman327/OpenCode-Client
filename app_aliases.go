package main

import "oc-manager/model"

// 以下通过类型别名保持前端 Wails bind 兼容。
type (
	SkillInfo         = model.SkillInfo
	Stats             = model.Stats
	ToggleResult      = model.ToggleResult
	WebResult         = model.WebResult
	APIResult         = model.APIResult
	ProxyConfig       = model.ProxyConfig
	ModelEntry        = model.ModelEntry
	SaveResult        = model.SaveResult
	ProviderInfo      = model.ProviderInfo
	ModelInfo         = model.ModelInfo
	ProviderSave      = model.ProviderSave
	CmdInfo           = model.CmdInfo
	CmdGroup          = model.CmdGroup
	CmdPaletteItem    = model.CmdPaletteItem
	SessionInfo       = model.SessionInfo
	SchemeInfo        = model.SchemeInfo
	SchemeApplyResult = model.SchemeApplyResult
)
