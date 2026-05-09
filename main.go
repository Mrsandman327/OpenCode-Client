package main

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/bin/appicon.png
var trayIconData []byte

func main() {
	wailsApp := application.New(application.Options{
		Name:        "oc-manager",
		Description: "OpenCode管理中心",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Windows: application.WindowsOptions{
			WebviewUserDataPath: webviewUserDataPath(),
		},
	})

	app := NewApp(wailsApp)
	wailsApp.RegisterService(application.NewService(app))

	window := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "OpenCode管理中心",
		Width:            1280,
		Height:           820,
		MinWidth:         960,
		MinHeight:        640,
		BackgroundColour: application.NewRGB(255, 255, 255),
	})
	window.Center()
	window.Show()

	// ========== 系统托盘 ==========
	setupSystemTray(wailsApp, window)

	err := wailsApp.Run()
	if err != nil {
		println("启动失败:", err.Error())
	}
}

// setupSystemTray 创建系统托盘：图标、右键菜单、窗口附加、关闭隐藏。
func setupSystemTray(wailsApp *application.App, window application.Window) {
	systray := wailsApp.SystemTray.New()

	// 设置托盘图标
	iconData := trayIconData
	if len(iconData) == 0 {
		iconData = icons.DefaultWindowsIcon
	}
	if runtime.GOOS == "darwin" {
		systray.SetTemplateIcon(iconData)
	} else {
		systray.SetIcon(iconData)
	}
	systray.SetTooltip("OpenCode管理中心")

	// 创建右键菜单
	menu := wailsApp.NewMenu()
	menu.Add("显示/隐藏").OnClick(func(ctx *application.Context) {
		if window.IsVisible() {
			window.Hide()
		} else {
			window.Show().Focus()
		}
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(ctx *application.Context) {
		wailsApp.Quit()
	})
	systray.SetMenu(menu)

	// 点击托盘图标切换窗口显示
	systray.AttachWindow(window).WindowOffset(5)

	// 窗口关闭时隐藏到托盘，而非退出
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		window.Hide()
		e.Cancel()
	})
}

func webviewUserDataPath() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}

	path := filepath.Join(base, "OC Manager", "WebView2")
	if err := os.MkdirAll(path, 0o700); err != nil {
		panic(fmt.Errorf("创建 WebView2 用户数据目录失败: %w", err))
	}
	return path
}
