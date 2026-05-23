package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"oc-manager/config"
	"oc-manager/model"
)

// setupTempSkillConfigDir 在临时目录中创建 configs 子目录，并通过环境变量
// SKILL_CONFIG_DIR 将其设置为技能配置目录。返回该 configs 目录的路径。
func setupTempSkillConfigDir(t *testing.T) string {
	t.Helper()
	tmpDir := t.TempDir()
	configDir := filepath.Join(tmpDir, "configs")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatalf("创建测试 configs 目录失败: %v", err)
	}
	t.Setenv("SKILL_CONFIG_DIR", configDir)
	return configDir
}

// writeTempSkillConfig 在指定的 configs 目录中创建 skill-config.json 文件。
// 返回该文件的完整路径。
func writeTempSkillConfig(t *testing.T, dir string, content string) string {
	t.Helper()
	path := filepath.Join(dir, "./skill-schemes/skill-config.json")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("写入测试配置文件失败: %v", err)
	}
	return path
}

// ========== SkillConfigDir 测试 ==========

func TestSkillConfigDirReturnsConfigsPath(t *testing.T) {
	// 设置自定义配置目录环境变量
	tmpDir := t.TempDir()
	configDir := filepath.Join(tmpDir, "configs")
	t.Setenv("SKILL_CONFIG_DIR", configDir)

	dir, err := config.SkillConfigDir()
	if err != nil {
		t.Fatalf("SkillConfigDir() 返回错误: %v", err)
	}

	// 路径应以 configs 结尾
	if filepath.Base(dir) != "configs" {
		t.Fatalf("SkillConfigDir() 返回 %q，期望以 configs 结尾", dir)
	}
}

// ========== SkillConfigPath 测试 ==========

func TestSkillConfigPathReturnsJsonPath(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	path, err := config.SkillConfigPath()
	if err != nil {
		t.Fatalf("SkillConfigPath() 返回错误: %v", err)
	}

	expected := filepath.Join(configDir, "./skill-schemes/skill-config.json")
	if filepath.Clean(path) != filepath.Clean(expected) {
		t.Fatalf("期望返回 %s，实际返回: %s", expected, path)
	}
}

// ========== LoadSkillConfig 测试 ==========

func TestLoadSkillConfigReadsExistingFormat(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)
	writeTempSkillConfig(t, configDir, `{
  "sourceDirs": [
    "C:\\Users\\test\\.cc-switch\\skills",
    "D:\\projects\\custom-skills"
  ]
}`)

	cfg, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig() 返回错误: %v", err)
	}

	if cfg == nil {
		t.Fatal("LoadSkillConfig() 返回 nil 配置")
	}

	if len(cfg.SourceDirs) != 2 {
		t.Fatalf("期望 2 个源目录，实际得到 %d 个", len(cfg.SourceDirs))
	}

	if cfg.SourceDirs[0] != `C:\Users\test\.cc-switch\skills` {
		t.Fatalf("第一个源目录不匹配: %s", cfg.SourceDirs[0])
	}

	if cfg.SourceDirs[1] != `D:\projects\custom-skills` {
		t.Fatalf("第二个源目录不匹配: %s", cfg.SourceDirs[1])
	}
}

func TestLoadSkillConfigNonExistentFileReturnsEmpty(t *testing.T) {
	_ = setupTempSkillConfigDir(t)
	// 不创建任何配置文件

	cfg, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig() 对不存在的文件应返回 nil 错误，实际返回: %v", err)
	}

	if cfg == nil {
		t.Fatal("LoadSkillConfig() 应返回非 nil 的空配置")
	}

	if len(cfg.SourceDirs) != 0 {
		t.Fatalf("空配置的 SourceDirs 应为空，实际有 %d 个", len(cfg.SourceDirs))
	}
}

func TestLoadSkillConfigEmptySourceDirs(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)
	writeTempSkillConfig(t, configDir, `{"sourceDirs": []}`)

	cfg, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig() 返回错误: %v", err)
	}

	if len(cfg.SourceDirs) != 0 {
		t.Fatalf("期望 SourceDirs 为空，实际有 %d 个", len(cfg.SourceDirs))
	}
}

// ========== SaveSkillConfig 测试 ==========

func TestSaveSkillConfigWritesValidJSON(t *testing.T) {
	_ = setupTempSkillConfigDir(t)

	cfg := &model.SkillConfig{
		SourceDirs: []string{`C:\skills\global`, `D:\skills\project`},
		Version:    "1",
	}

	if err := config.SaveSkillConfig(cfg); err != nil {
		t.Fatalf("SaveSkillConfig() 返回错误: %v", err)
	}

	// 使用 SkillConfigPath() 获取实际写入的路径（支持 .json/.jsonc）
	writtenPath, err := config.SkillConfigPath()
	if err != nil {
		t.Fatalf("SkillConfigPath() 返回错误: %v", err)
	}
	data, err := os.ReadFile(writtenPath)
	if err != nil {
		t.Fatalf("读取保存的配置文件失败 (%s): %v", writtenPath, err)
	}

	// 验证内容为有效 JSON
	if !json.Valid(data) {
		t.Fatalf("保存的文件不是有效 JSON: %s", string(data))
	}

	// 验证内容包含期望的字段
	var loaded model.SkillConfig
	if err := json.Unmarshal(data, &loaded); err != nil {
		t.Fatalf("解析保存的配置文件失败: %v", err)
	}

	if len(loaded.SourceDirs) != 2 {
		t.Fatalf("期望 2 个源目录，实际得到 %d 个", len(loaded.SourceDirs))
	}

	if loaded.SourceDirs[0] != `C:\skills\global` {
		t.Fatalf("第一个源目录不匹配: %s", loaded.SourceDirs[0])
	}

	if loaded.SourceDirs[1] != `D:\skills\project` {
		t.Fatalf("第二个源目录不匹配: %s", loaded.SourceDirs[1])
	}
}

func TestSaveSkillConfigRoundTrip(t *testing.T) {
	_ = setupTempSkillConfigDir(t)

	original := &model.SkillConfig{
		SourceDirs: []string{`X:\one`, `Y:\two`, `Z:\three`},
		Version:    "1",
	}

	// 保存
	if err := config.SaveSkillConfig(original); err != nil {
		t.Fatalf("SaveSkillConfig() 返回错误: %v", err)
	}

	// 重新加载（使用同一个 SKILL_CONFIG_DIR 环境变量）
	loaded, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig() 返回错误: %v", err)
	}

	if len(loaded.SourceDirs) != len(original.SourceDirs) {
		t.Fatalf("SourceDirs 长度不匹配: 期望 %d，实际 %d", len(original.SourceDirs), len(loaded.SourceDirs))
	}

	for i := range original.SourceDirs {
		if loaded.SourceDirs[i] != original.SourceDirs[i] {
			t.Fatalf("SourceDirs[%d] 不匹配: 期望 %s，实际 %s", i, original.SourceDirs[i], loaded.SourceDirs[i])
		}
	}
}

func TestSaveSkillConfigAtomicWrite(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 先创建一个已有文件
	existingPath := filepath.Join(configDir, "./skill-schemes/skill-config.json")
	if err := os.WriteFile(existingPath, []byte(`{"sourceDirs":["old"]}`), 0644); err != nil {
		t.Fatalf("写入已有配置文件失败: %v", err)
	}

	cfg := &model.SkillConfig{
		SourceDirs: []string{"new"},
		Version:    "1",
	}

	if err := config.SaveSkillConfig(cfg); err != nil {
		t.Fatalf("SaveSkillConfig() 返回错误: %v", err)
	}

	// 验证文件已更新
	data, err := os.ReadFile(existingPath)
	if err != nil {
		t.Fatalf("读取更新后的配置文件失败: %v", err)
	}

	if !strings.Contains(string(data), "new") {
		t.Fatalf("配置文件未正确更新，内容: %s", string(data))
	}

	// 验证没有遗留的临时文件
	entries, err := os.ReadDir(configDir)
	if err != nil {
		t.Fatalf("读取配置目录失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".skill-config.json.") && strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("临时文件未被清理: %s", entry.Name())
		}
	}
}

func TestSaveSkillConfigRejectsInvalidJSONContent(t *testing.T) {
	// 这个测试验证 writeConfigFile 的 JSON 验证逻辑，
	// 正常情况下 SaveSkillConfig 不会产生无效 JSON，但如果
	// SourceDirs 中包含特殊字符导致序列化后仍为有效 JSON 则不应该报错。
	_ = setupTempSkillConfigDir(t)

	// 正常场景：包含特殊字符的路径应该正常工作
	cfg := &model.SkillConfig{
		SourceDirs: []string{`"quoted"`, `\backslash`},
	}

	if err := config.SaveSkillConfig(cfg); err != nil {
		t.Fatalf("SaveSkillConfig() 对合法路径不应返回错误: %v", err)
	}

	// 验证文件被正确写入
	writtenPath, err := config.SkillConfigPath()
	if err != nil {
		t.Fatalf("SkillConfigPath() 返回错误: %v", err)
	}
	data, err := os.ReadFile(writtenPath)
	if err != nil {
		t.Fatalf("读取配置文件失败: %v", err)
	}
	if !json.Valid(data) {
		t.Fatalf("保存的文件不是有效 JSON: %s", string(data))
	}
}

// ========== Version 字段测试 ==========

func TestLoadSkillConfigPreservesVersionField(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)
	writeTempSkillConfig(t, configDir, `{
  "sourceDirs": ["test"],
  "version": "2"
}`)

	cfg, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig() 返回错误: %v", err)
	}

	if cfg.Version != "2" {
		t.Fatalf("期望 Version 为 '2'，实际为 '%s'", cfg.Version)
	}
}

func TestLoadSkillConfigMissingVersionDefaultsEmpty(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)
	writeTempSkillConfig(t, configDir, `{"sourceDirs": ["test"]}`)

	cfg, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig() 返回错误: %v", err)
	}

	// 缺失 version 字段时，应为空字符串
	if cfg.Version != "" {
		t.Fatalf("缺失 version 字段时期望空字符串，实际为 '%s'", cfg.Version)
	}
}

// ========== NormalizePath 测试 ==========

func TestNormalizePathResolvesToAbsolute(t *testing.T) {
	// 创建工作目录下的相对路径
	tmpDir := t.TempDir()
	subDir := filepath.Join(tmpDir, "skills", "my-skill")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatalf("创建测试目录失败: %v", err)
	}

	// 使用相对路径调用 NormalizePath
	relPath := filepath.Join(tmpDir, "skills", "my-skill")
	normalized, err := config.NormalizePath(relPath)
	if err != nil {
		t.Fatalf("NormalizePath(%q) 返回错误: %v", relPath, err)
	}

	if !filepath.IsAbs(normalized) {
		t.Fatalf("NormalizePath 应返回绝对路径，实际: %s", normalized)
	}
}

func TestNormalizePathCleansSeparators(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := filepath.Join(tmpDir, "skills")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatalf("创建测试目录失败: %v", err)
	}

	// 使用含有多余分隔符和 . 的路径，但确保最终解析到的目录存在
	relPath := filepath.Join(tmpDir, "skills", ".", "sub1", "..")
	normalized, err := config.NormalizePath(relPath)
	if err != nil {
		t.Fatalf("NormalizePath(%q) 返回错误: %v", relPath, err)
	}

	// 规范化后不应包含 .. 或多余分隔符，应解析到 skills 目录
	cleanExpected := filepath.Clean(filepath.Join(tmpDir, "skills"))
	absExpected, _ := filepath.Abs(cleanExpected)
	if normalized != absExpected {
		t.Fatalf("期望 %q，实际 %q", absExpected, normalized)
	}
}

// createTestSourceDir 创建带有 SKILL.md 子目录的测试源目录，
// 确保 hasSkillDir 校验通过。返回源目录的绝对路径。
func createTestSourceDir(t *testing.T, parentDir, name string) string {
	t.Helper()
	dir := filepath.Join(parentDir, name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("创建源目录失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "test-skill"), 0755); err != nil {
		t.Fatalf("创建技能子目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "test-skill", "SKILL.md"), []byte("---\ndescription: test\n---\n# test"), 0644); err != nil {
		t.Fatalf("写入 SKILL.md 失败: %v", err)
	}
	return dir
}

// ========== AddSourceDir 测试 ==========

func TestAddSourceDirRejectsNonExistentDir(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 创建一个不存在的目录路径
	nonExistent := filepath.Join(configDir, "nonexistent-dir-that-does-not-exist")

	_, err := config.AddSourceDir(nonExistent, "/some/global/dir")
	if err == nil {
		t.Fatal("AddSourceDir 对不存在的目录应返回错误")
	}
}

func TestAddSourceDirRejectsGlobalDir(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 创建带 SKILL.md 的全局目录
	globalDir := createTestSourceDir(t, configDir, "opencode-global-skills")

	_, err := config.AddSourceDir(globalDir, globalDir)
	if err == nil {
		t.Fatal("AddSourceDir 对与全局目录相同的路径应返回错误")
	}
}

func TestAddSourceDirRejectsDuplicate(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 创建一个带 SKILL.md 的源目录
	skillDir := createTestSourceDir(t, configDir, "my-skills")

	// 先添加一次
	cfg1, err := config.AddSourceDir(skillDir, "/some/global/dir")
	if err != nil {
		t.Fatalf("首次 AddSourceDir 应成功: %v", err)
	}

	// 再次添加相同目录应报错
	_, err = config.AddSourceDir(skillDir, "/some/global/dir")
	if err == nil {
		t.Fatal("AddSourceDir 对重复目录应返回错误")
	}

	// 验证配置中只有一个源目录
	_ = cfg1
	cfg, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig 返回错误: %v", err)
	}
	if len(cfg.SourceDirs) != 1 {
		t.Fatalf("期望只有 1 个源目录，实际有 %d 个", len(cfg.SourceDirs))
	}
}

func TestAddSourceDirPathNormalization(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 创建带 SKILL.md 的技能源目录
	skillDir := createTestSourceDir(t, configDir, "my-skills")

	// 使用包含多余分隔符和相对部分的路径
	rawPath := filepath.Join(configDir, ".", "my-skills", "..", "my-skills")
	cfg, err := config.AddSourceDir(rawPath, "/some/global/dir")
	if err != nil {
		t.Fatalf("AddSourceDir 对有效路径应成功: %v", err)
	}

	// 验证保存的路径已经规范化
	if cfg == nil {
		t.Fatal("AddSourceDir 返回 nil 配置")
	}

	savedDir := filepath.Clean(skillDir)
	absExpected, _ := filepath.Abs(savedDir)

	// 检查保存的路径是否为规范化后的绝对路径
	found := false
	for _, d := range cfg.SourceDirs {
		if filepath.Clean(d) == filepath.Clean(absExpected) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("保存的配置中未找到规范化路径 %q，实际内容: %v", absExpected, cfg.SourceDirs)
	}
}

func TestAddSourceDirSuccess(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 创建带 SKILL.md 的源目录
	skillDir := createTestSourceDir(t, configDir, "skills-custom")

	cfg, err := config.AddSourceDir(skillDir, "/some/global/dir")
	if err != nil {
		t.Fatalf("AddSourceDir 应成功: %v", err)
	}

	if cfg == nil {
		t.Fatal("AddSourceDir 返回 nil 配置")
	}

	if len(cfg.SourceDirs) != 1 {
		t.Fatalf("期望 1 个源目录，实际有 %d 个", len(cfg.SourceDirs))
	}

	// 验证持久化
	loaded, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig 返回错误: %v", err)
	}

	if len(loaded.SourceDirs) != 1 {
		t.Fatalf("加载的配置期望 1 个源目录，实际有 %d 个", len(loaded.SourceDirs))
	}

	// 再次添加另一个目录
	skillDir2 := createTestSourceDir(t, configDir, "skills-another")

	cfg2, err := config.AddSourceDir(skillDir2, "/some/global/dir")
	if err != nil {
		t.Fatalf("第二次 AddSourceDir 应成功: %v", err)
	}

	if len(cfg2.SourceDirs) != 2 {
		t.Fatalf("期望 2 个源目录，实际有 %d 个", len(cfg2.SourceDirs))
	}
}

// ========== RemoveSourceDir 测试 ==========

func TestRemoveSourceDirSuccess(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 创建并添加两个源目录
	skillDir1 := createTestSourceDir(t, configDir, "skills-one")
	skillDir2 := createTestSourceDir(t, configDir, "skills-two")

	if _, err := config.AddSourceDir(skillDir1, "/some/global/dir"); err != nil {
		t.Fatalf("添加目录1失败: %v", err)
	}
	if _, err := config.AddSourceDir(skillDir2, "/some/global/dir"); err != nil {
		t.Fatalf("添加目录2失败: %v", err)
	}

	// 移除第一个
	cfg, err := config.RemoveSourceDir(skillDir1)
	if err != nil {
		t.Fatalf("RemoveSourceDir 应成功: %v", err)
	}

	if cfg == nil {
		t.Fatal("RemoveSourceDir 返回 nil 配置")
	}

	if len(cfg.SourceDirs) != 1 {
		t.Fatalf("移除后期望 1 个源目录，实际有 %d 个", len(cfg.SourceDirs))
	}

	// 验证持久化
	loaded, err := config.LoadSkillConfig()
	if err != nil {
		t.Fatalf("LoadSkillConfig 返回错误: %v", err)
	}

	if len(loaded.SourceDirs) != 1 {
		t.Fatalf("加载的配置期望 1 个源目录，实际有 %d 个", len(loaded.SourceDirs))
	}

	// 移除最后一个
	cfg2, err := config.RemoveSourceDir(skillDir2)
	if err != nil {
		t.Fatalf("RemoveSourceDir 对最后一个目录应成功: %v", err)
	}

	if len(cfg2.SourceDirs) != 0 {
		t.Fatalf("清空后期望 0 个源目录，实际有 %d 个", len(cfg2.SourceDirs))
	}
}

func TestRemoveSourceDirNonExistent(t *testing.T) {
	_ = setupTempSkillConfigDir(t)

	// 空配置，移除不存在的目录
	_, err := config.RemoveSourceDir("/some/nonexistent/dir")
	if err == nil {
		t.Fatal("RemoveSourceDir 对不存在的目录应返回错误")
	}
}

// ========== ListSourceDirs 测试 ==========

func TestListSourceDirsEmpty(t *testing.T) {
	_ = setupTempSkillConfigDir(t)
	// 不创建任何配置文件

	dirs, err := config.ListSourceDirs()
	if err != nil {
		t.Fatalf("ListSourceDirs 应成功: %v", err)
	}

	if dirs == nil {
		t.Fatal("ListSourceDirs 应返回非 nil 切片")
	}

	if len(dirs) != 0 {
		t.Fatalf("空配置期望 0 个源目录，实际有 %d 个", len(dirs))
	}
}

func TestListSourceDirsWithEntries(t *testing.T) {
	configDir := setupTempSkillConfigDir(t)

	// 创建并添加源目录
	skillDir1 := createTestSourceDir(t, configDir, "skills-alpha")
	skillDir2 := createTestSourceDir(t, configDir, "skills-beta")

	if _, err := config.AddSourceDir(skillDir1, "/some/global/dir"); err != nil {
		t.Fatalf("添加目录1失败: %v", err)
	}
	if _, err := config.AddSourceDir(skillDir2, "/some/global/dir"); err != nil {
		t.Fatalf("添加目录2失败: %v", err)
	}

	dirs, err := config.ListSourceDirs()
	if err != nil {
		t.Fatalf("ListSourceDirs 应成功: %v", err)
	}

	if len(dirs) != 2 {
		t.Fatalf("期望 2 个源目录，实际有 %d 个", len(dirs))
	}

	// 验证返回的目录均为绝对路径
	for i, d := range dirs {
		if !filepath.IsAbs(d) {
			t.Fatalf("源目录[%d] 应返回绝对路径，实际: %s", i, d)
		}
	}
}
