//go:build linux

package opencode

import (
	"os"
	"path/filepath"
	"strings"
)

// listProcesses 在 Linux 上通过 /proc 枚举名称以 opencode 开头的进程（含命令行）。
// 失败时返回错误（调用方按"检测失败放行"处理）。
func listProcesses() ([]serviceProcess, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var procs []serviceProcess
	for _, e := range entries {
		pid := e.Name()
		if len(pid) == 0 || pid[0] < '0' || pid[0] > '9' {
			continue // 只看数字命名的 PID 目录
		}
		// 进程名：/proc/<pid>/comm
		nameBytes, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if err != nil {
			continue // 进程可能已退出
		}
		name := strings.TrimSpace(string(nameBytes))
		if !strings.HasPrefix(strings.ToLower(name), "opencode") {
			continue
		}
		// 命令行：/proc/<pid>/cmdline（NUL 分隔）
		cmdBytes, err := os.ReadFile(filepath.Join("/proc", pid, "cmdline"))
		if err != nil {
			continue
		}
		parts := strings.Split(strings.TrimRight(string(cmdBytes), "\x00"), "\x00")
		cmdline := strings.Join(parts, " ")
		procs = append(procs, serviceProcess{Name: name, Cmdline: cmdline})
	}
	return procs, nil
}
