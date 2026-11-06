// Package logger 封装 oc-manager 的运行日志写入与分级输出。
package logger

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"oc-manager/internal/portable"
)

var (
	Log *SysLog
)

type SysLog struct {
	file   *os.File
	logger *log.Logger
}

func CreateSysLog() error {
	if Log != nil {
		Log.Close()
		Log = nil
	}
	logger, err := NewSysLog()
	Log = logger
	if err != nil {
		return err
	}
	return nil
}

// logDirectory 返回日志目录。
//
// 不能使用相对路径 "./log"：macOS 从 Finder 启动时工作目录是 "/"，
// Linux 从桌面启动器启动时也可能是 "/" 或 home，都会导致日志目录创建失败。
// 优先放到便携目录 <exeDir>/agentdatas/log；可执行文件路径不可用时回退用户缓存目录。
func logDirectory() string {
	if root := portable.Root(); root != "" {
		return filepath.Join(root, "log")
	}
	if cache, err := os.UserCacheDir(); err == nil && cache != "" {
		return filepath.Join(cache, "oc-manager", "log")
	}
	return "./log"
}

func NewSysLog() (*SysLog, error) {
	logDir := logDirectory()
	// 确保目录存在，如果不存在则创建它
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil, err
	}
	filePath := filepath.Join(logDir,
		fmt.Sprintf("sys-%s_%09d.log", time.Now().Format("20060102_150405"), time.Now().Nanosecond()))
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o666)
	if err != nil {
		return nil, err
	}
	logger := log.New(file, "", log.Ldate|log.Lmicroseconds)

	return &SysLog{
		file:   file,
		logger: logger,
	}, nil
}

func (l *SysLog) Close() error {
	err := l.file.Close()
	if err != nil {
		l.file = nil
	}
	return err
}

func (l *SysLog) Printf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	l.logger.Println(msg)
}

// Printf 包级日志函数：Log 未初始化（如测试环境）时静默跳过，避免调用方反复判空。
func Printf(format string, args ...any) {
	if Log != nil {
		Log.Printf(format, args...)
	}
}
