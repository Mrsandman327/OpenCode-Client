//go:build devtools && windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// 调试版：给 WebView2 打开远程调试端口，供外部 CDP/DevTools 连接。
// 只在带 devtools build tag 的 Windows 构建中生效，正式发布不包含。
var debugWindowsOptions = application.WindowsOptions{
	AdditionalBrowserArgs: []string{"--remote-debugging-port=9222"},
}
