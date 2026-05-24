package main

import (
	"encoding/json"
	"fmt"

	"oc-manager/model"
)

// AppCall 为前端 Web 统一分发调用。
func (a *App) AppCall(method string, args []json.RawMessage) (interface{}, error) {
	return a.callFrontendMethod(method, args)
}

func (a *App) callFrontendMethod(method string, args []json.RawMessage) (interface{}, error) {
	switch method {
	case "GetCommands":
		return a.GetCommands(), nil
	case "StartFrontendWeb":
		var port int
		var hostname string
		if err := decodeArgs(args, &port, &hostname); err != nil {
			return nil, err
		}
		return a.StartFrontendWeb(port, hostname), nil
	case "StopFrontendWeb":
		return a.StopFrontendWeb(), nil
	case "GetFrontendWebStatus":
		var hostname string
		var port int
		if err := decodeArgs(args, &hostname, &port); err != nil {
			return nil, err
		}
		return a.GetFrontendWebStatus(hostname, port), nil
	case "GetSkillConfig":
		return a.GetSkillConfig(), nil
	case "GetDirEnabledSkills":
		var dir string
		if err := decodeArgs(args, &dir); err != nil {
			return nil, err
		}
		return a.GetDirEnabledSkills(dir), nil
	case "GetSkills":
		return a.GetSkills(), nil
	case "GetAggregatedSkills":
		return a.GetAggregatedSkills(), nil
	case "GetStats":
		return a.GetStats(), nil
	case "GetSourceDir":
		return a.GetSourceDir(), nil
	case "ListBrowsableDirs":
		var path string
		if err := decodeArgs(args, &path); err != nil {
			return nil, err
		}
		return a.ListBrowsableDirs(path)
	case "ListBrowserFiles":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.ListBrowserFiles(rootDir, path)
	case "StatBrowserFile":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.StatBrowserFile(rootDir, path)
	case "ReadBrowserFile":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.ReadBrowserFile(rootDir, path)
	case "ReadBrowserRawBase64":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.ReadBrowserRawBase64(rootDir, path)
	case "UploadBrowserFile":
		var rootDir, path, fileName, base64 string
		var overwrite bool
		if err := decodeArgs(args, &rootDir, &path, &fileName, &base64, &overwrite); err != nil {
			return nil, err
		}
		return a.UploadBrowserFile(rootDir, path, fileName, base64, overwrite)
	case "DeleteBrowserEntry":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.DeleteBrowserEntry(rootDir, path)
	case "GetGitStatus":
		var rootDir string
		if err := decodeArgs(args, &rootDir); err != nil {
			return nil, err
		}
		return a.GetGitStatus(rootDir), nil
	case "GetGitPreview":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.GetGitPreview(rootDir, path)
	case "GetGitHistory":
		var rootDir string
		var offset, limit int
		if err := decodeArgs(args, &rootDir, &offset, &limit); err != nil {
			return nil, err
		}
		return a.GetGitHistory(rootDir, offset, limit)
	case "GetGitHistoryFiles":
		var rootDir, commitHash string
		if err := decodeArgs(args, &rootDir, &commitHash); err != nil {
			return nil, err
		}
		return a.GetGitHistoryFiles(rootDir, commitHash)
	case "GetGitHistoryPreview":
		var rootDir, commitHash, path string
		if err := decodeArgs(args, &rootDir, &commitHash, &path); err != nil {
			return nil, err
		}
		return a.GetGitHistoryPreview(rootDir, commitHash, path)
	case "StageFile":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.StageFile(rootDir, path), nil
	case "UnstageFile":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.UnstageFile(rootDir, path), nil
	case "StageAllFiles":
		var rootDir string
		if err := decodeArgs(args, &rootDir); err != nil {
			return nil, err
		}
		return a.StageAllFiles(rootDir), nil
	case "GitCommit":
		var rootDir, message string
		if err := decodeArgs(args, &rootDir, &message); err != nil {
			return nil, err
		}
		return a.GitCommit(rootDir, message), nil
	case "GitPush":
		var rootDir string
		if err := decodeArgs(args, &rootDir); err != nil {
			return nil, err
		}
		return a.GitPush(rootDir), nil
	case "GitPull":
		var rootDir string
		if err := decodeArgs(args, &rootDir); err != nil {
			return nil, err
		}
		return a.GitPull(rootDir), nil
	case "DiscardFile":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.DiscardFile(rootDir, path), nil
	case "ReadSkillContent":
		var skillPath string
		if err := decodeArgs(args, &skillPath); err != nil {
			return nil, err
		}
		return a.ReadSkillContent(skillPath)
	case "SaveSkillContent":
		var skillPath, content string
		if err := decodeArgs(args, &skillPath, &content); err != nil {
			return nil, err
		}
		return map[string]bool{"success": a.SaveSkillContent(skillPath, content) == nil}, nil
	case "ListSkillFiles":
		var skillPath string
		if err := decodeArgs(args, &skillPath); err != nil {
			return nil, err
		}
		return a.ListSkillFiles(skillPath)
	case "ReadSkillFile":
		var skillPath, relativePath string
		if err := decodeArgs(args, &skillPath, &relativePath); err != nil {
			return nil, err
		}
		return a.ReadSkillFile(skillPath, relativePath)
	case "SaveSkillFile":
		var skillPath, relativePath, content string
		if err := decodeArgs(args, &skillPath, &relativePath, &content); err != nil {
			return nil, err
		}
		return map[string]bool{"success": a.SaveSkillFile(skillPath, relativePath, content) == nil}, nil
	case "ToggleSkill":
		var skillPath, skillName string
		var enable bool
		if err := decodeArgs(args, &skillPath, &skillName, &enable); err != nil {
			return nil, err
		}
		return a.ToggleSkill(skillPath, skillName, enable), nil
	case "GetProviders":
		return a.GetProviders()
	case "GetModelList":
		var baseURL, apiKey string
		if err := decodeArgs(args, &baseURL, &apiKey); err != nil {
			return nil, err
		}
		return a.GetModelList(baseURL, apiKey), nil
	case "GetModelConfig":
		return a.GetModelConfig()
	case "GetProviderConfigPath":
		return a.GetProviderConfigPath(), nil
	case "SaveProvider":
		var provider model.ProviderSave
		if err := decodeArgs(args, &provider); err != nil {
			return nil, err
		}
		return a.SaveProvider(provider), nil
	case "DeleteProvider":
		var key string
		if err := decodeArgs(args, &key); err != nil {
			return nil, err
		}
		return a.DeleteProvider(key), nil
	case "GetFullConfig":
		return a.GetFullConfig(), nil
	case "GetConfigPath":
		return a.GetConfigPath(), nil
	case "GetAgentDescriptions":
		return a.GetAgentDescriptions(), nil
	case "AddModelType":
		var entryType string
		if err := decodeArgs(args, &entryType); err != nil {
			return nil, err
		}
		return a.AddModelType(entryType), nil
	case "DeleteModelType":
		var entryType string
		if err := decodeArgs(args, &entryType); err != nil {
			return nil, err
		}
		return a.DeleteModelType(entryType), nil
	case "GetSchemeDir":
		return a.GetSchemeDir(), nil
	case "ListSchemes":
		return a.ListSchemes(), nil
	case "ReadScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil {
			return nil, err
		}
		return a.ReadScheme(name)
	case "SaveScheme":
		var name, content string
		if err := decodeArgs(args, &name, &content); err != nil {
			return nil, err
		}
		return map[string]bool{"success": a.SaveScheme(name, content) == nil}, nil
	case "SaveFullConfig":
		var jsonStr string
		if err := decodeArgs(args, &jsonStr); err != nil {
			return nil, err
		}
		return a.SaveFullConfig(jsonStr), nil
	case "Refresh":
		return map[string]bool{"success": a.Refresh() == nil}, nil
	case "AddSkillSourceDir":
		var dir string
		if err := decodeArgs(args, &dir); err != nil {
			return nil, err
		}
		return a.AddSkillSourceDir(dir), nil
	case "RemoveSkillSourceDir":
		var dir string
		if err := decodeArgs(args, &dir); err != nil {
			return nil, err
		}
		return a.RemoveSkillSourceDir(dir), nil
	case "GetSkillSourceDirs":
		return a.GetSkillSourceDirs(), nil
	case "AnswerQuestion":
		var sessionID, answerLabel string
		if err := decodeArgs(args, &sessionID, &answerLabel); err != nil {
			return nil, err
		}
		return a.AnswerQuestion(sessionID, answerLabel), nil
	case "RejectQuestion":
		var sessionID string
		if err := decodeArgs(args, &sessionID); err != nil {
			return nil, err
		}
		return a.RejectQuestion(sessionID), nil
	case "OpenDirectoryDialog":
		return a.OpenDirectoryDialog(), nil
	case "ShowConfirmDialog":
		var title, message string
		if err := decodeArgs(args, &title, &message); err != nil {
			return nil, err
		}
		return a.ShowConfirmDialog(title, message), nil
	case "LaunchWindowsTerminal":
		var mode, webURL, dir string
		if err := decodeArgs(args, &mode, &webURL, &dir); err != nil {
			return nil, err
		}
		return a.LaunchWindowsTerminal(mode, webURL, dir), nil
	case "OpenDir":
		var path string
		if err := decodeArgs(args, &path); err != nil {
			return nil, err
		}
		return map[string]bool{"success": a.OpenDir(path) == nil}, nil
	case "OpenSchemeDir":
		return map[string]bool{"success": a.OpenSchemeDir() == nil}, nil
	case "ExportConfig":
		var dir, filename, content string
		if err := decodeArgs(args, &dir, &filename, &content); err != nil {
			return nil, err
		}
		return a.ExportConfig(dir, filename, content)
	case "SaveSkillScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil {
			return nil, err
		}
		return a.SaveSkillScheme(name), nil
	case "ApplySkillScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil {
			return nil, err
		}
		return a.ApplySkillScheme(name), nil
	case "ListSkillSchemes":
		return a.ListSkillSchemes(), nil
	case "DeleteSkillScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil {
			return nil, err
		}
		return a.DeleteSkillScheme(name), nil
	case "StartOpenCodeWeb":
		var port int
		var hostname string
		var proxy model.ProxyConfig
		if err := decodeArgs(args, &port, &hostname, &proxy); err != nil {
			return nil, err
		}
		return a.StartOpenCodeWeb(port, hostname, proxy), nil
	case "StopOpenCodeWeb":
		return a.StopOpenCodeWeb(), nil
	case "GetWebStatus":
		var hostname string
		var port int
		if err := decodeArgs(args, &hostname, &port); err != nil {
			return nil, err
		}
		return a.GetWebStatus(hostname, port), nil
	case "OpenCodeAPI":
		var method, path, body string
		if err := decodeArgs(args, &method, &path, &body); err != nil {
			return nil, err
		}
		return a.OpenCodeAPI(method, path, body), nil
	case "GetProjectTree":
		var knownDirs string
		if err := decodeArgs(args, &knownDirs); err != nil {
			return nil, err
		}
		return a.GetProjectTree(knownDirs), nil
	case "StartOpenCodeEvents":
		return a.StartOpenCodeEvents(), nil
	case "StopOpenCodeEvents":
		return a.StopOpenCodeEvents(), nil
	case "UpdateModels":
		var entries []model.ModelEntry
		if err := decodeArgs(args, &entries); err != nil {
			return nil, err
		}
		return a.UpdateModels(entries), nil
	case "AddModelEntry":
		var key, modelName, entryType string
		if err := decodeArgs(args, &key, &modelName, &entryType); err != nil {
			return nil, err
		}
		return a.AddModelEntry(key, modelName, entryType), nil
	case "DeleteModelEntry":
		var key, entryType string
		if err := decodeArgs(args, &key, &entryType); err != nil {
			return nil, err
		}
		return a.DeleteModelEntry(key, entryType), nil
	case "DeleteScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil {
			return nil, err
		}
		return a.DeleteScheme(name), nil
	case "GetProjectConfigSummary":
		var rootDir string
		if err := decodeArgs(args, &rootDir); err != nil {
			return nil, err
		}
		return a.GetProjectConfigSummary(rootDir), nil
	case "ReadProjectConfigFile":
		var rootDir, category, relPath string
		if err := decodeArgs(args, &rootDir, &category, &relPath); err != nil {
			return nil, err
		}
		return a.ReadProjectConfigFile(rootDir, category, relPath)
	case "SaveProjectConfigFile":
		var rootDir, category, relPath, content string
		if err := decodeArgs(args, &rootDir, &category, &relPath, &content); err != nil {
			return nil, err
		}
		return a.SaveProjectConfigFile(rootDir, category, relPath, content)
	case "GetGlobalOpenCodeConfig":
		return a.GetGlobalOpenCodeConfig(), nil
	case "ListProjectConfigDir":
		var rootDir, category, relPath string
		if err := decodeArgs(args, &rootDir, &category, &relPath); err != nil {
			return nil, err
		}
		return a.ListProjectConfigDir(rootDir, category, relPath)
	case "CreateProjectEntry":
		var rootDir, category, name string
		if err := decodeArgs(args, &rootDir, &category, &name); err != nil {
			return nil, err
		}
		return a.CreateProjectEntry(rootDir, category, name)
	case "DeleteProjectEntry":
		var rootDir, category, relPath string
		if err := decodeArgs(args, &rootDir, &category, &relPath); err != nil {
			return nil, err
		}
		return nil, a.DeleteProjectEntry(rootDir, category, relPath)
	case "GetImportableSkills":
		var rootDir string
		if err := decodeArgs(args, &rootDir); err != nil {
			return nil, err
		}
		return a.GetImportableSkills(rootDir), nil
	case "ImportSkill":
		var rootDir, sourcePath, skillName string
		if err := decodeArgs(args, &rootDir, &sourcePath, &skillName); err != nil {
			return nil, err
		}
		return nil, a.ImportSkill(rootDir, sourcePath, skillName)
	default:
		return nil, fmt.Errorf("unsupported method: %s", method)
	}
}

func decodeArgs(args []json.RawMessage, targets ...interface{}) error {
	if len(args) < len(targets) {
		return fmt.Errorf("参数数量不足: need %d got %d", len(targets), len(args))
	}
	for i, target := range targets {
		if err := json.Unmarshal(args[i], target); err != nil {
			return fmt.Errorf("参数 %d 解析失败: %w", i, err)
		}
	}
	return nil
}
