//go:build windows

package opencode

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"

	"oc-manager/internal/executil"
)

// serviceProcessJSON 是 PowerShell CIM 查询的输出结构。
type serviceProcessJSON struct {
	Name        string  `json:"Name"`
	CommandLine *string `json:"CommandLine"`
}

// listProcesses 在 Windows 上通过 PowerShell 的 CIM 查询枚举名称以 opencode
// 开头的进程（含命令行）。失败时返回错误（调用方按"检测失败放行"处理）。
func listProcesses() ([]serviceProcess, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	// 说明：
	//   - 强制 UTF-8 输出，避免中文/本地代码页导致的解析问题；
	//   - Name LIKE 'opencode%' 由过滤器完成，减少数据量；
	//   - ConvertTo-Json -Compress 输出紧凑 JSON（单个结果不是数组，下方兼容）。
	script := `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
		`Get-CimInstance Win32_Process -Filter "Name LIKE 'opencode%'" | ` +
		`Select-Object Name,CommandLine | ConvertTo-Json -Compress`

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	executil.SetHideWindow(cmd, true)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	s := strings.TrimSpace(strings.TrimPrefix(string(out), "\uFEFF"))
	if s == "" || s == "null" {
		return nil, nil
	}

	var items []serviceProcessJSON
	if strings.HasPrefix(s, "[") {
		if err := json.Unmarshal([]byte(s), &items); err != nil {
			return nil, err
		}
	} else {
		var one serviceProcessJSON
		if err := json.Unmarshal([]byte(s), &one); err != nil {
			return nil, err
		}
		items = []serviceProcessJSON{one}
	}

	procs := make([]serviceProcess, 0, len(items))
	for _, it := range items {
		cmdline := ""
		if it.CommandLine != nil {
			cmdline = *it.CommandLine
		}
		procs = append(procs, serviceProcess{Name: it.Name, Cmdline: cmdline})
	}
	return procs, nil
}
