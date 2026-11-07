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

// NormLoose 宽松规范化路径：清理多余分隔符、转为绝对路径；
// 路径存在时解析符号链接，不存在（或无法解析）时退回绝对路径本身。
//
// 与 Norm 的区别只在于「允许路径不存在」。用于配置文件中记录的历史路径等
// 不保证在当前系统仍存在的场景（例如技能来源目录被移动/删除、配置从其他机器同步过来），
// 这些条目必须仍能参与比较与删除，否则会永久卡在配置里无法清理。
func NormLoose(path string) (string, error) {
	cleaned := filepath.Clean(path)
	abs, err := filepath.Abs(cleaned)
	if err != nil {
		return "", fmt.Errorf("解析绝对路径失败: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved, nil
	}
	return abs, nil
}

// Norm 规范化路径：清理多余分隔符、转为绝对路径、解析符号链接。
// 用于把用户输入的目录路径统一成可比较的规范形式。
// 要求路径必须存在（EvalSymlinks 对不存在的路径会报错）；
// 需要容忍路径不存在时用 NormLoose。
func Norm(path string) (string, error) {
	loose, err := NormLoose(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(loose)
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
