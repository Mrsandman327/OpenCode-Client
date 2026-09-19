package main

import (
	_ "embed"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// 托盘图标：使用 PNG 格式（64x64）以兼容全平台——
// Windows 的 setIcon 支持 PNG/ICO，而 Linux（SNI/D-Bus）只解析 PNG。
//
//go:embed build/trayicon.png
var trayIcon []byte

// quitting 标记应用正在退出（托盘菜单「退出」时置位）。
// 关闭按钮的拦截逻辑据此放行真正的退出流程，避免"退出"被当成"隐藏到托盘"。
var quitting atomic.Bool

// setupSystemTray 创建系统托盘并配置桌面交互行为：
//   - 单击托盘图标：切换主窗口显示/隐藏（AttachWindow 的智能默认行为）
//   - 右键托盘图标：弹出菜单（显示主窗口 / 退出应用）
//   - 鼠标悬停：显示提示文字
//   - 点击窗口关闭按钮：隐藏到托盘（不退出应用，可从托盘恢复）
func setupSystemTray(app *application.App, win *application.WebviewWindow) {
	tray := app.SystemTray.New()
	tray.SetIcon(trayIcon)
	tray.SetTooltip("OC Manager - OpenCode 工作台")
	tray.AttachWindow(win)

	// 右键菜单
	menu := app.Menu.New()
	menu.Add("显示主窗口").OnClick(func(ctx *application.Context) {
		win.Show()
		win.Focus()
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(ctx *application.Context) {
		quitting.Store(true) // 放行关闭拦截，让应用真正退出
		app.Quit()
	})
	tray.SetMenu(menu)

	// 关闭按钮拦截：隐藏到托盘而非退出应用。
	// 使用 RegisterHook（同步 hook）：它在 wails 内部的关闭监听器之前执行，
	// Cancel() 后 HandleWindowEvent 会提前 return，内部关闭流程不会执行。
	win.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if quitting.Load() {
			return // 正在退出：放行关闭
		}
		event.Cancel()
		win.Hide()
	})
}
