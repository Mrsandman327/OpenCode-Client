//go:build windows

package opencode

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"oc-manager/internal/executil"
)

// killByPort 根据监听端口找到 PID 并终止进程树。
func killByPort(port int) {
	find := exec.Command("cmd", "/c",
		fmt.Sprintf("netstat -ano | findstr :%d | findstr LISTENING", port))
	executil.SetHideWindow(find, true)
	out, err := find.Output()
	if err != nil {
		return
	}
	fields := strings.Fields(string(out))
	if len(fields) < 5 {
		return
	}
	pid, err := strconv.Atoi(fields[len(fields)-1])
	if err != nil || pid <= 0 {
		return
	}
	killProcTree(pid)
}

// listOpenCodePids 枚举本机 opencode.exe 进程 PID（tasklist CSV 输出）。
func listOpenCodePids() []int {
	cmd := exec.Command("tasklist", "/FI", "IMAGENAME eq opencode.exe", "/FO", "CSV", "/NH")
	executil.SetHideWindow(cmd, true)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "opencode.exe") {
			continue
		}
		fields := strings.Split(line, ",")
		if len(fields) < 2 {
			continue
		}
		pidStr := strings.Trim(fields[1], "\"")
		if pid, e := strconv.Atoi(pidStr); e == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// netstatListeningPorts 解析 netstat -ano 的 LISTENING 行，返回目标 PID 的监听端口列表。
func netstatListeningPorts(pidSet map[int]bool) []int {
	cmd := exec.Command("netstat", "-ano")
	executil.SetHideWindow(cmd, true)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	re := regexp.MustCompile(`^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$`)
	var ports []int
	for _, line := range strings.Split(string(out), "\n") {
		m := re.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pid, e1 := strconv.Atoi(m[3])
		port, e2 := strconv.Atoi(m[2])
		if e1 != nil || e2 != nil || !pidSet[pid] || port <= 0 {
			continue
		}
		ports = append(ports, port)
	}
	return ports
}

// killProcTree 终止进程树（taskkill /T 包含子进程）。
func killProcTree(pid int) {
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	executil.SetHideWindow(kill, true)
	_ = kill.Run()
}

// launchTerminal 启动外部终端打开 opencode；优先 Windows Terminal，回退 cmd /c start。
func launchTerminal(args []string) (*exec.Cmd, error) {
	if cmd, err := findWindowsTerminal(args...); err == nil {
		executil.SetHideWindow(cmd, false)
		return cmd, nil
	}
	cmdArgs := append([]string{"/c", "start", "opencode"}, args[1:]...)
	cmd := exec.Command("cmd", cmdArgs...)
	executil.SetHideWindow(cmd, false)
	return cmd, nil
}

func findWindowsTerminal(args ...string) (*exec.Cmd, error) {
	for _, name := range []string{"wt", "WindowsTerminal"} {
		wtPath, err := exec.LookPath(name)
		if err == nil {
			wtArgs := []string{"-d", ".", "--"}
			wtArgs = append(wtArgs, args...)
			return exec.Command(wtPath, wtArgs...), nil
		}
	}
	for _, p := range []string{
		os.ExpandEnv("${LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe"),
		os.ExpandEnv("${ProgramFiles}\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\wt.exe"),
	} {
		if _, err := os.Stat(p); err == nil {
			wtArgs := append([]string{"-d", "."}, args...)
			return exec.Command(p, wtArgs...), nil
		}
	}
	return nil, fmt.Errorf("Windows Terminal 未安装")
}
