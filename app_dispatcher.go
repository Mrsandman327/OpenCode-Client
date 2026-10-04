package main

import (
	"encoding/json"
	"fmt"

	"oc-manager/config/omo"
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
	case "SaveBrowserFile":
		var rootDir, path, content string
		if err := decodeArgs(args, &rootDir, &path, &content); err != nil {
			return nil, err
		}
		return a.SaveBrowserFile(rootDir, path, content)
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
	case "CreateBrowserDir":
		var rootDir, path, dirName string
		if err := decodeArgs(args, &rootDir, &path, &dirName); err != nil {
			return nil, err
		}
		return a.CreateBrowserDir(rootDir, path, dirName)
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
		var proxy model.ProxyConfig
		if err := decodeArgs(args, &rootDir, &proxy); err != nil {
			return nil, err
		}
		return a.GitPush(rootDir, proxy), nil
	case "GitPull":
		var rootDir string
		var proxy model.ProxyConfig
		if err := decodeArgs(args, &rootDir, &proxy); err != nil {
			return nil, err
		}
		return a.GitPull(rootDir, proxy), nil
	case "DiscardFile":
		var rootDir, path string
		if err := decodeArgs(args, &rootDir, &path); err != nil {
			return nil, err
		}
		return a.DiscardFile(rootDir, path), nil
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
	case "GetSlimConfig":
		var projectDir string
		if len(args) > 0 {
			if err := decodeArgs(args, &projectDir); err != nil {
				return nil, err
			}
		}
		return a.GetSlimConfig(projectDir)
	case "SaveSlimConfig":
		var payload omo.SlimSavePayload
		if err := decodeArgs(args, &payload); err != nil {
			return nil, err
		}
		return a.SaveSlimConfig(payload), nil
	case "GetSlimConfigPath":
		return a.GetSlimConfigPath(), nil
	case "GetSlimAgentDescriptions":
		return a.GetSlimAgentDescriptions(), nil
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
		var sessionID string
		var answers [][]string
		if err := decodeArgs(args, &sessionID, &answers); err != nil {
			return nil, err
		}
		return a.AnswerQuestion(sessionID, answers), nil
	case "RejectQuestion":
		var sessionID string
		if err := decodeArgs(args, &sessionID); err != nil {
			return nil, err
		}
		return a.RejectQuestion(sessionID), nil
	case "OpenDirectoryDialog":
		return a.OpenDirectoryDialog(), nil
	case "OpenFileBrowserWindow":
		var rootDir string
		var withGit bool
		if err := decodeArgs(args, &rootDir, &withGit); err != nil {
			return nil, err
		}
		a.OpenFileBrowserWindow(rootDir, withGit)
		return nil, nil
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
		var password string
		var proxy model.ProxyConfig
		if err := decodeArgs(args, &port, &hostname, &password, &proxy); err != nil {
			return nil, err
		}
		return a.StartOpenCodeWeb(port, hostname, password, proxy), nil
	case "StopOpenCodeWeb":
		return a.StopOpenCodeWeb(), nil
	case "GetWebStatus":
		var hostname string
		var port int
		if err := decodeArgs(args, &hostname, &port); err != nil {
			return nil, err
		}
		return a.GetWebStatus(hostname, port), nil
	case "SetServerPassword":
		var password string
		if err := decodeArgs(args, &password); err != nil {
			return nil, err
		}
		a.SetServerPassword(password)
		return true, nil
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
	case "MoveSession":
		var sessionID, directory, delivery string
		if err := decodeArgs(args, &sessionID, &directory, &delivery); err != nil {
			return nil, err
		}
		return a.MoveSession(sessionID, directory, delivery), nil
	case "MarkSessionViewed":
		var sessionID string
		var idle int64
		if err := decodeArgs(args, &sessionID, &idle); err != nil {
			return nil, err
		}
		return a.MarkSessionViewed(sessionID, idle), nil
	case "GetSessionContext":
		var sessionID string
		if err := decodeArgs(args, &sessionID); err != nil {
			return nil, err
		}
		return a.GetSessionContext(sessionID), nil
	case "ExportSession":
		var sessionID string
		var sanitize bool
		if err := decodeArgs(args, &sessionID, &sanitize); err != nil {
			return nil, err
		}
		return a.ExportSession(sessionID, sanitize), nil
	case "ImportSession":
		var exportJSON string
		if err := decodeArgs(args, &exportJSON); err != nil {
			return nil, err
		}
		return a.ImportSession(exportJSON), nil
	case "ListIntegrations":
		var directory string
		var includeEmpty bool
		if err := decodeArgs(args, &directory, &includeEmpty); err != nil {
			return nil, err
		}
		return a.ListIntegrations(directory, includeEmpty), nil
	case "ActivateCredential":
		var credentialID string
		if err := decodeArgs(args, &credentialID); err != nil {
			return nil, err
		}
		return a.ActivateCredential(credentialID), nil
	case "RenameCredential":
		var credentialID, label string
		if err := decodeArgs(args, &credentialID, &label); err != nil {
			return nil, err
		}
		return a.RenameCredential(credentialID, label), nil
	case "AddCredential":
		var integrationID, key, label string
		if err := decodeArgs(args, &integrationID, &key, &label); err != nil {
			return nil, err
		}
		return a.AddCredential(integrationID, key, label), nil
	case "DeleteCredential":
		var credentialID string
		if err := decodeArgs(args, &credentialID); err != nil {
			return nil, err
		}
		return a.DeleteCredential(credentialID), nil
	case "ListWorktrees":
		var projectID string
		if err := decodeArgs(args, &projectID); err != nil {
			return nil, err
		}
		return a.ListWorktrees(projectID), nil
	case "ListBranches":
		var directory, search string
		var limit int
		if err := decodeArgs(args, &directory, &search, &limit); err != nil {
			return nil, err
		}
		return a.ListBranches(directory, search, limit), nil
	case "ListPtys":
		var directory string
		if err := decodeArgs(args, &directory); err != nil {
			return nil, err
		}
		return a.ListPtys(directory), nil
	case "StartOpenCodeEvents":
		return a.StartOpenCodeEvents(), nil
	case "StopOpenCodeEvents":
		return a.StopOpenCodeEvents(), nil
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
	case "CheckOpenCodeVersion":
		var currentVersion string
		if err := decodeArgs(args, &currentVersion); err != nil {
			return nil, err
		}
		return a.CheckOpenCodeVersion(currentVersion), nil
	case "KnowledgeList":
		return a.KnowledgeList()
	case "KnowledgeGet":
		var id string
		if err := decodeArgs(args, &id); err != nil {
			return nil, err
		}
		return a.KnowledgeGet(id)
	case "KnowledgeSave":
		var entry model.KnowledgeEntry
		if err := decodeArgs(args, &entry); err != nil {
			return nil, err
		}
		return a.KnowledgeSave(entry)
	case "KnowledgeDelete":
		var id string
		if err := decodeArgs(args, &id); err != nil {
			return nil, err
		}
		return nil, a.KnowledgeDelete(id)
	case "KnowledgeCategories":
		return a.KnowledgeCategories()
	case "KnowledgeSaveCategories":
		var cats []model.KnowledgeCategory
		if err := decodeArgs(args, &cats); err != nil {
			return nil, err
		}
		return nil, a.KnowledgeSaveCategories(cats)
	case "KnowledgeConvertPreview":
		var req model.ConvertRequest
		if err := decodeArgs(args, &req); err != nil {
			return nil, err
		}
		return a.KnowledgeConvertPreview(req)
	case "KnowledgeConvert":
		var req model.ConvertRequest
		if err := decodeArgs(args, &req); err != nil {
			return nil, err
		}
		return a.KnowledgeConvert(req)
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
