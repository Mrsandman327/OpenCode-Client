// Package reveal 提供「在系统文件管理器中打开路径」的跨平台实现。
//
// 两种语义：
//   - 目录：直接打开该目录；
//   - 文件：打开其所在目录并选中该文件（Windows / macOS 原生支持；
//     Linux 走 FileManager1 的 D-Bus 接口，桌面环境不支持时回退为打开父目录）。
package reveal

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Open 在系统文件管理器中打开 path。
// isDir 表示调用方认为的目标类型；实际以磁盘上的类型为准
// （右键菜单拿到的是渲染时的类型，理论上不会过期，但仍以磁盘为准更稳妥）。
func Open(path string, isDir bool) error {
	if path == "" {
		return fmt.Errorf("路径不能为空")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("解析路径失败: %w", err)
	}
	// 目标不存在时直接报错：否则资源管理器会打开一个默认位置，看起来像「点了没反应」
	if _, err := os.Lstat(abs); err != nil {
		return fmt.Errorf("路径不存在: %w", err)
	}
	if info, err := os.Stat(abs); err == nil {
		isDir = info.IsDir()
	}
	if isDir {
		return openDir(abs)
	}
	return revealFile(abs)
}

// openDir 打开目录本身。
func openDir(dir string) error {
	switch runtime.GOOS {
	case "windows":
		return start("explorer", dir)
	case "darwin":
		return start("open", dir)
	default:
		return start("xdg-open", dir)
	}
}

// revealFile 打开文件所在目录并选中文件。
func revealFile(file string) error {
	switch runtime.GOOS {
	case "windows":
		// explorer 的选中参数写作 /select,<路径>。
		// 这里拆成两个参数传递：Go 会为含空格的参数补引号，
		// 而 explorer 对「/select, 与被引号包裹的路径分开」的解析最稳定。
		return start("explorer", "/select,", file)
	case "darwin":
		return start("open", "-R", file)
	default:
		// Linux：优先用 FileManager1（Nautilus / Dolphin / Nemo / Thunar 等均实现）
		// 在文件管理器中选中文件；接口不可用（无 dbus-send 或桌面环境不支持）时
		// 回退为打开父目录，保证动作仍有可见结果。
		if err := showItemsLinux(file); err == nil {
			return nil
		}
		return start("xdg-open", filepath.Dir(file))
	}
}

// showItemsLinux 通过 D-Bus 调用文件管理器的 ShowItems 选中文件。
// dbus-send 是短命进程，这里用 Run 等待其退出以获取失败信息（用于决定是否回退）。
func showItemsLinux(file string) error {
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(file)}).String()
	cmd := exec.Command("dbus-send",
		"--session",
		"--dest=org.freedesktop.FileManager1",
		"--type=method_call",
		"/org/freedesktop/FileManager1",
		"org.freedesktop.FileManager1.ShowItems",
		"array:string:"+uri,
		"string:",
	)
	return cmd.Run()
}

// start 启动系统命令并立即返回，不等待其结束
// （explorer/open/xdg-open 都可能常驻，等待会阻塞调用方）。
//
// 注意：绝对不能给 explorer 设置 HideWindow（SW_HIDE）。
// explorer.exe 是 GUI 进程，窗口显示状态取自 STARTUPINFO，隐藏启动会导致
// 窗口根本不出现、表现为「点了没反应」；它本身也不产生控制台，无需隐藏。
func start(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	return cmd.Start()
}
