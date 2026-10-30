package main

import (
	"embed"

	"oc-manager/internal/logger"
	"oc-manager/internal/portable"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	logger.CreateSysLog()
	defer logger.Log.Close()

	// 便携数据目录：业务代码通过 portable helper 定位，子进程用 portable.ChildEnvFrom() 注入。
	// 刻意不改进程级 XDG 环境变量——否则 libibus 找不到 ~/.config/ibus/bus，
	// GTK/WebView 里的中文等输入法会整体失效。
	if err := portable.Init(); err != nil {
		logger.Printf("[portable] 便携数据目录初始化失败: %v", err)
	}

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

	// 初始窗口用保守尺寸，真正的自适应放到 WindowRuntimeReady 之后：
	// 窗口创建前 app.Screen 的缓存不可靠（GetPrimary 可能为 nil），
	// 且 Windows 的 WorkArea 是物理像素，直接用会按缩放倍数放大。
	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "OC Manager",
		Width:            1024,
		Height:           640,
		MinWidth:         960,
		MinHeight:        560,
		BackgroundColour: application.NewRGB(255, 255, 255),
		URL:              "/",
		ZoomControlEnabled: true,
		InitialPosition:  application.WindowCentered,
	})

	// 系统托盘：单击切换窗口显示，右键菜单（显示主窗口/退出）。
	setupSystemTray(app, window)

	// 全局快捷键：Shift+X 在任意界面唤起/隐藏主窗口（与托盘单击行为一致）。
	// 注意：全局快捷键会拦截该组合键的常规输入（Shift+X 即大写 X），如与日常输入冲突，
	// 可改为 "Ctrl+Shift+X"（此处按需求保留 Shift+X）。
	if err := app.GlobalShortcut.Register("Shift+X", func() {
		if window.IsVisible() {
			window.Hide()
		} else {
			window.Show()
			window.Focus()
		}
	}); err != nil {
		logger.Printf("[shortcut] 注册全局快捷键 Shift+X 失败: %v", err)
	} else {
		logger.Printf("[shortcut] 全局快捷键 Shift+X 已注册（唤起/隐藏主窗口）")
	}

	// 页面运行时（DOM）就绪后：先按当前屏幕工作区调整窗口（此时屏幕信息才可靠），
	// 再通知前端开始初始化（替代 v2 的 OnDomReady）。
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(event *application.WindowEvent) {
		if screen, err := window.GetScreen(); err == nil && screen != nil {
			workW, workH := screenWorkAreaDIP(screen)
			window.SetSize(
				clampInt(int(float64(workW)*0.80), 960, 1600),
				clampInt(int(float64(workH)*0.85), 560, 1000),
			)
			window.Center()
		}
		myApp.emitAppReady()
	})

	if err := app.Run(); err != nil {
		println("启动失败:", err.Error())
	}
}

// clampInt 把 v 限制在 [min, max] 区间内。
func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// screenWorkAreaDIP 返回屏幕工作区的 DIP 尺寸。
// Windows 的 WorkArea/PhysicalWorkArea 都是物理像素，必须除以 ScaleFactor；
// 其他平台若没有 PhysicalWorkArea，则 WorkArea 本身已是 DIP，直接使用。
func screenWorkAreaDIP(s *application.Screen) (int, int) {
	scale := float64(s.ScaleFactor)
	if scale <= 0 {
		scale = 1
	}
	if s.PhysicalWorkArea.Width > 0 && s.PhysicalWorkArea.Height > 0 {
		return int(float64(s.PhysicalWorkArea.Width) / scale), int(float64(s.PhysicalWorkArea.Height) / scale)
	}
	return s.WorkArea.Width, s.WorkArea.Height
}
