// Package logger 封装 oc-manager 的运行日志写入与分级输出。
package logger

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
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

func NewSysLog() (*SysLog, error) {
	filePath := fmt.Sprintf("./log/sys-%s_%09d.log", time.Now().Format("20060102_150405"), time.Now().Nanosecond())
	// 确保目录存在，如果不存在则创建它
	dir, _ := filepath.Split(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
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
