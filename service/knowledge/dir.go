// Package knowledge 实现知识库的本地存储层：
// 元数据索引 + 分类树 + 以 Markdown（frontmatter）格式保存的条目文件。
package knowledge

import (
	"fmt"
	"os"
	"path/filepath"
)

// writeProbeName 是写权限探测文件名，探测结束后立即删除。
const writeProbeName = ".write-probe"

// VaultDir 返回知识库数据目录：优先使用 exe 同级的 vault/，
// 若该目录不可写（权限失败）则回退到用户配置目录下的 oc-manager/vault。
func VaultDir() (string, error) {
	fallbackBase, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("获取用户配置目录失败: %w", err)
	}
	exeDir, err := executableDir()
	if err != nil {
		return resolveFallbackDir(fallbackBase)
	}
	return resolveVaultDir(exeDir, fallbackBase)
}

// executableDir 返回当前可执行文件所在目录（解析符号链接）。
func executableDir() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}
	return filepath.Dir(exePath), nil
}

// resolveVaultDir 在 exeDir 下优先使用 vault/ 子目录，不可写时回退到 fallbackBase。
func resolveVaultDir(exeDir, fallbackBase string) (string, error) {
	primary := filepath.Join(exeDir, "vault")
	if ensureWritableDir(primary) {
		return primary, nil
	}
	return resolveFallbackDir(fallbackBase)
}

// resolveFallbackDir 返回兜底数据目录 <fallbackBase>/oc-manager/vault 并确保其存在。
func resolveFallbackDir(fallbackBase string) (string, error) {
	dir := filepath.Join(fallbackBase, "oc-manager", "vault")
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return "", fmt.Errorf("创建知识库兜底目录失败: %w", err)
	}
	return dir, nil
}

// ensureWritableDir 确保目录存在且可写：创建目录后写入探测文件并立即删除。
func ensureWritableDir(dir string) bool {
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return false
	}
	probe := filepath.Join(dir, writeProbeName)
	file, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, filePerm)
	if err != nil {
		return false
	}
	_ = file.Close()
	_ = os.Remove(probe)
	return true
}
