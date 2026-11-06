//go:build darwin

package opencode

import (
	"os/exec"
	"strings"
)

// listProcesses 在 macOS 上枚举进程名称与命令行，供启动前拦截使用。
//
// 实现方式：调用 `ps -axo comm=,command=`：
//   - comm 是进程可执行文件路径（可能带目录）；
//   - command 是完整命令行（包含参数）。
//
// ps 的 comm 列不含空格，因此用第一个空白分隔的字段作为路径是安全的；
// 后续字段拼接回完整命令行，用于匹配 service / serve 子命令。
//
// 枚举失败时返回错误，调用方按「检测失败放行」处理。
func listProcesses() ([]serviceProcess, error) {
	out, err := exec.Command("ps", "-axo", "comm=,command=").Output()
	if err != nil {
		return nil, err
	}

	var procs []serviceProcess
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}

		// comm 可能是 /usr/local/bin/opencode，取 basename 后比较进程名。
		name := fields[0]
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		if !strings.HasPrefix(strings.ToLower(name), "opencode") {
			continue
		}

		procs = append(procs, serviceProcess{
			Name:    name,
			Cmdline: strings.Join(fields[1:], " "),
		})
	}
	return procs, nil
}
