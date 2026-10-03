//go:build windows

package opencode

import (
	"fmt"
	"os"
	"os/exec"

	"oc-manager/internal/executil"
)

// launchTerminal 启动外部终端打开 opencode；优先 Windows Terminal，回退 cmd /c start。
// env 为追加到子进程的环境变量（如 OPENCODE_SERVER_PASSWORD）。
func launchTerminal(args []string, env []string) (*exec.Cmd, error) {
	var cmd *exec.Cmd
	if c, err := findWindowsTerminal(args...); err == nil {
		cmd = c
	} else {
		// 使用解析后的 opencode 路径（args[0]）替代写死的命令名；
		// "" 是 start 的窗口标题占位符，避免带空格的路径被误当成标题。
		cmdArgs := append([]string{"/c", "start", ""}, args...)
		cmd = exec.Command("cmd", cmdArgs...)
	}
	executil.SetHideWindow(cmd, false)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
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
