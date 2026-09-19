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

	// 主窗口引用：供单实例回调激活使用（闭包按引用捕获，在 application.New 之后赋值）。
	var window *application.WebviewWindow

	app := application.New(application.Options{
		Name: "OC Manager",
		Services: []application.Service{
			application.NewService(myApp),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		// 单实例模式：防止多开。第二次启动时把启动信息发给第一实例后自动退出；
		// 第一实例收到通知后显示并聚焦主窗口（若窗口在托盘中则一并恢复）。
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.linsn.ocmanager",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if window == nil {
					return
				}
				window.Show()
				window.Focus()
			},
		},
	})

	// 回注 v3 应用引用，并同时注入 service 层的事件发射器（SSE 桌面通道使用）。
	myApp.setApplication(app)

	// 创建主窗口（v3 多窗口 API）。
	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "OC Manager",
		Width:            1280,
		Height:           820,
		MinWidth:         960,
		MinHeight:        640,
		BackgroundColour: application.NewRGB(255, 255, 255),
		URL:              "/",
	})

	// 系统托盘：单击切换窗口显示，右键菜单（显示主窗口/退出）。
	setupSystemTray(app, window)

	// 页面运行时（DOM）就绪后通知前端开始初始化（替代 v2 的 OnDomReady）。
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(event *application.WindowEvent) {
		myApp.emitAppReady()
	})

	if err := app.Run(); err != nil {
		println("启动失败:", err.Error())
	}
}
