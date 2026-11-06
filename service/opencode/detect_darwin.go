//go:build darwin

package opencode

import (
	"os/exec"
	"strings"
)

// listProcesses 在 macOS 上枚举进程名称与命令行，供启动前拦截使用。
//
// 分两步查询，避免 `comm` 和 `command` 混在一行时被空格干扰：
//  1. `ps -axo pid=,comm=` 拿 PID 和可执行文件路径；
//  2. 只对名称以 opencode 开头的进程，再用 `ps -p <pid> -o command=` 拿完整命令行。
//
// 枚举失败时返回错误，调用方按「检测失败放行」处理。
func listProcesses() ([]serviceProcess, error) {
	out, err := exec.Command("ps", "-axo", "pid=,comm=").Output()
	if err != nil {
		return nil, err
	}

	var procs []serviceProcess
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// 输出形如 "  1234 /usr/local/bin/opencode"；
		// comm 是最后一列且可能含空格，所以只按第一个空白拆出 PID。
		fields := strings.SplitN(line, " ", 2)
		if len(fields) < 2 {
			continue
		}
		pid := strings.TrimSpace(fields[0])
		comm := strings.TrimSpace(fields[1])
		if pid == "" || comm == "" {
			continue
		}

		// comm 可能是 /usr/local/bin/opencode，取 basename 后比较进程名。
		name := comm
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		if !strings.HasPrefix(strings.ToLower(name), "opencode") {
			continue
		}

		// 只对命中的进程再查完整命令行，避免对每个系统进程多一次 ps 调用。
		cmdline := ""
		if b, err := exec.Command("ps", "-p", pid, "-o", "command=").Output(); err == nil {
			cmdline = strings.TrimSpace(string(b))
		}

		procs = append(procs, serviceProcess{Name: name, Cmdline: cmdline})
	}
	return procs, nil
}
