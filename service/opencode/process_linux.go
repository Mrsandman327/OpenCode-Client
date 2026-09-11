//go:build linux

package opencode

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// killByPort 根据监听端口找到 PID 并终止进程树；找不到则按命令行兜底 pkill。
func killByPort(port int) {
	pid := pidForPort(port)
	if pid > 0 {
		killProcTree(pid)
		return
	}
	_ = exec.Command("pkill", "-f", fmt.Sprintf("opencode.*--port %d", port)).Run()
}

// listOpenCodePids 用 pgrep 枚举 opencode serve 进程 PID。
func listOpenCodePids() []int {
	out, err := exec.Command("pgrep", "-f", "opencode serve").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if pid, e := strconv.Atoi(line); e == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// netstatListeningPorts 通过 /proc/{pid}/fd 的 socket inode 与 /proc/net/tcp 的 LISTEN 行
// 建立映射，返回目标 PID 的监听端口列表（不依赖外部命令，无需 root）。
func netstatListeningPorts(pidSet map[int]bool) []int {
	// 收集 pid → socket inode 映射
	inodeToPid := make(map[string]int)
	for pid := range pidSet {
		fdDir := fmt.Sprintf("/proc/%d/fd", pid)
		entries, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, ent := range entries {
			link, err := os.Readlink(fdDir + "/" + ent.Name())
			if err != nil {
				continue
			}
			if strings.HasPrefix(link, "socket:[") {
				inode := strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")
				inodeToPid[inode] = pid
			}
		}
	}

	file, err := os.Open("/proc/net/tcp")
	if err != nil {
		return nil
	}
	defer file.Close()

	var ports []int
	scanner := bufio.NewScanner(file)
	scanner.Scan() // 跳过表头
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		if fields[3] != "0A" { // 0A = LISTEN
			continue
		}
		if _, ok := inodeToPid[fields[9]]; !ok {
			continue
		}
		localAddr := strings.Split(fields[1], ":")
		if len(localAddr) != 2 {
			continue
		}
		port, e := strconv.ParseInt(localAddr[1], 16, 32)
		if e != nil || port <= 0 {
			continue
		}
		ports = append(ports, int(port))
	}
	return ports
}

// killProcTree 终止进程：先 SIGTERM 优雅退出，3 秒超时后 SIGKILL。
func killProcTree(pid int) {
	_ = syscall.Kill(pid, syscall.SIGTERM)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return // 进程已退出
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

// pidForPort 通过 /proc/net/tcp + /proc/{pid}/fd 查找监听指定端口的 PID。
func pidForPort(port int) int {
	file, err := os.Open("/proc/net/tcp")
	if err != nil {
		return 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Scan() // 表头
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || fields[3] != "0A" {
			continue
		}
		localAddr := strings.Split(fields[1], ":")
		if len(localAddr) != 2 {
			continue
		}
		p, _ := strconv.ParseInt(localAddr[1], 16, 32)
		if int(p) != port {
			continue
		}
		inode := fields[9]
		procEntries, _ := os.ReadDir("/proc")
		for _, proc := range procEntries {
			if !proc.IsDir() {
				continue
			}
			pid, err := strconv.Atoi(proc.Name())
			if err != nil || pid <= 0 {
				continue
			}
			fdDir := fmt.Sprintf("/proc/%d/fd", pid)
			fdEntries, err := os.ReadDir(fdDir)
			if err != nil {
				continue
			}
			for _, fd := range fdEntries {
				link, err := os.Readlink(fdDir + "/" + fd.Name())
				if err != nil {
					continue
				}
				if link == "socket:["+inode+"]" {
					return pid
				}
			}
		}
		return 0
	}
	return 0
}

// launchTerminal 启动外部终端模拟器打开 opencode；依次探测常见终端。
func launchTerminal(args []string) (*exec.Cmd, error) {
	cmdLine := "exec " + quoteArgs(args)
	for _, term := range []string{"x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal"} {
		path, err := exec.LookPath(term)
		if err != nil {
			continue
		}
		switch term {
		case "gnome-terminal", "konsole":
			// 新版 gnome-terminal/konsole 用 -- 分隔符
			return exec.Command(path, "--", "bash", "-lc", cmdLine), nil
		default:
			// x-terminal-emulator / xfce4-terminal 用 -e
			return exec.Command(path, "-e", "bash", "-lc", cmdLine), nil
		}
	}
	return nil, fmt.Errorf("未找到可用的终端模拟器（尝试了 x-terminal-emulator/gnome-terminal/konsole/xfce4-terminal）")
}

// quoteArgs 对参数做 shell 安全转义后拼接为单条命令字符串。
func quoteArgs(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, strconv.Quote(a))
	}
	return strings.Join(quoted, " ")
}
