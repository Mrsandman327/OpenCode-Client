//go:build !devtools || !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// 正式版或非 Windows 构建：不附加任何 WebView2 调试参数。
var debugWindowsOptions = application.WindowsOptions{}
