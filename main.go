package main

import (
	"embed"
	"net/http"
	"strings"
	"time"

	"oc-manager/internal/logger"
	"oc-manager/internal/portable"
	"oc-manager/service/filebrowser"

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

	// 静态资源 handler：默认走 embed 的前端资源；
	// /files/raw 交给 filebrowser 处理，支持视频/音频的 Range 请求。
	staticAssets := application.AssetFileServerFS(assets)

	// 主窗口引用：供单实例回调激活使用（闭包按引用捕获，在 application.New 之后赋值）。
	var window *application.WebviewWindow

	app := application.New(application.Options{
		Name: "OC Manager",
		Services: []application.Service{
			application.NewService(myApp),
		},
		Assets: application.AssetOptions{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/files/raw") {
					filebrowser.ServeRawFile(w, r)
					return
				}
				staticAssets.ServeHTTP(w, r)
			}),
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
		adaptWindowToScreen(window, 0.80, 0.85, 960, 560, 1600, 1000)
		myApp.emitAppReady()
	})

	// IME 候选窗锚定修复（Wails #6595 的临时规避）。
	// 现象：从其他程序切回窗口后，下一次中文输入法组合的候选窗出现在屏幕左上角
	// 而不是光标处，必须点一下界面再点输入框才恢复。
	// 根因：Wails 在 WM_ACTIVATE / WM_SETFOCUS 处理里同步调用 MoveFocus(PROGRAMMATIC)，
	// 而 Windows 此时仍在窗口激活过程中，导致 WebView2 的 TSF/IME 输入状态损坏。
	// 这里在窗口重新获得焦点、激活序列结束后再聚焦一次 WebView，给输入法一次
	// 重建上输入下文的机会。延迟期间用 IsFocused 再确认，避免用户已切走时把窗口抢回前台。
	windowFocusLost := false
	window.OnWindowEvent(events.Common.WindowLostFocus, func(event *application.WindowEvent) {
		windowFocusLost = true
	})
	window.OnWindowEvent(events.Common.WindowFocus, func(event *application.WindowEvent) {
		if !windowFocusLost {
			return // 首次获得焦点（启动/首次显示）不需要额外处理
		}
		windowFocusLost = false
		time.AfterFunc(120*time.Millisecond, func() {
			if window != nil && window.IsFocused() {
				window.Focus()
			}
		})
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

// adaptWindowToScreen 按窗口「当前所在屏幕」的工作区比例调整窗口尺寸并居中。
//
// 必须在 WindowRuntimeReady 之后调用，原因有两个：
//  1. 窗口创建前 app.Screen 的缓存不可靠（GetPrimary 可能返回 nil）；
//  2. 多显示器场景下窗口可能落在副屏，用主屏尺寸会算错，GetScreen 拿到的才是实际所在屏幕。
//
// 各参数为「工作区宽/高的占比」与尺寸上下限（DIP）。拿不到屏幕信息时保持原尺寸返回 false。
func adaptWindowToScreen(win *application.WebviewWindow, ratioW, ratioH float64,
	minWidth, minHeight, maxWidth, maxHeight int) bool {
	if win == nil {
		return false
	}
	screen, err := win.GetScreen()
	if err != nil || screen == nil {
		return false
	}
	workW, workH := screenWorkAreaDIP(screen)
	if workW <= 0 || workH <= 0 {
		return false
	}
	win.SetSize(
		clampInt(int(float64(workW)*ratioW), minWidth, maxWidth),
		clampInt(int(float64(workH)*ratioH), minHeight, maxHeight),
	)
	win.Center()
	return true
}
