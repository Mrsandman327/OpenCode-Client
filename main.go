package main

import (
	"embed"

	"oc-manager/internal/logger"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	logger.CreateSysLog()
	defer logger.Log.Close()

	// 先创建业务 App 实例，再交给 v3 注册为 Service。
	// v3 应用实例在 application.New 之后回注给业务 App（事件/对话框/浏览器需要）。
	myApp := NewApp()

	app := application.New(application.Options{
		Name: "OC Manager",
		Services: []application.Service{
			application.NewService(myApp),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

	// 回注 v3 应用引用，并同时注入 service 层的事件发射器（SSE 桌面通道使用）。
	myApp.setApplication(app)

	// 创建主窗口（v3 多窗口 API）。
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "OC Manager",
		Width:            1280,
		Height:           820,
		MinWidth:         960,
		MinHeight:        640,
		BackgroundColour: application.NewRGB(255, 255, 255),
		URL:              "/",
	})

	// 页面运行时（DOM）就绪后通知前端开始初始化（替代 v2 的 OnDomReady）。
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(event *application.WindowEvent) {
		myApp.emitAppReady()
	})

	if err := app.Run(); err != nil {
		println("启动失败:", err.Error())
	}
}
