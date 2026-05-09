package main

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

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

	err := wailsApp.Run()
	if err != nil {
		println("启动失败:", err.Error())
	}
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
