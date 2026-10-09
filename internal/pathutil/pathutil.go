// Package pathutil 提供跨平台的路径规范化与路径归属比较工具。
// 统一原先散落在 config/skill、service/filebrowser、service/projectconfig
// 等处的路径归一化与「子路径」判定逻辑，避免各处实现漂移。
package pathutil

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

// Norm 规范化路径：清理多余分隔符、转为绝对路径、解析符号链接。
// 用于把用户输入的目录路径统一成可比较的规范形式。
func Norm(path string) (string, error) {
	cleaned := filepath.Clean(path)
	abs, err := filepath.Abs(cleaned)
	if err != nil {
		return "", fmt.Errorf("解析绝对路径失败: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("解析符号链接失败: %w", err)
	}
	return resolved, nil
}

// compareKey 返回用于路径比较的归一化形式：
// 清理多余分隔符、剥离 Windows 长路径前缀（\\?\），Windows 下再统一为小写。
// 不做 Abs / EvalSymlinks——调用方需自行保证两侧路径形式一致（均绝对或均相对）。
func compareKey(p string) string {
	cleaned := filepath.Clean(p)
	cleaned = strings.TrimPrefix(cleaned, `\\?\`)
	if runtime.GOOS == "windows" {
		cleaned = strings.ToLower(cleaned)
	}
	return cleaned
}

// Equal 比较两个路径是否相等（Windows 下不区分大小写）。
func Equal(a, b string) bool {
	return compareKey(a) == compareKey(b)
}

// IsSub 判断 child 是否位于 parent 目录下（或与 parent 相等）。
// 前缀匹配带分隔符边界判断，避免 /a/bc 被误判为 /a/b 的子路径。
func IsSub(child, parent string) bool {
	c := compareKey(child)
	p := compareKey(parent)
	if !strings.HasPrefix(c, p) {
		return false
	}
	if len(c) == len(p) {
		return true
	}
	// 边界：父路径之后必须紧跟分隔符（兼容不同风格的斜杠）
	sep := c[len(p)]
	return sep == filepath.Separator || sep == '/'
}
