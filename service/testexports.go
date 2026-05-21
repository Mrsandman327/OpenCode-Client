// Package service 测试辅助桥接——为 test/ 目录下的外部测试导出内部符号。
// 函数名中的 Test 前缀标识其仅用于测试场景。

package service

// TestGetWebSessionNilCheck 包装 getWebSession 并以布尔值返回 nil 检查结果，
// 避免 interface{} 包装带来的 nil 陷阱。
func TestGetWebSessionNilCheck() bool {
	return getWebSession() == nil
}

// TestBuildTreeJSONEmpty 以 nil 参数调用 buildTreeJSON 用于空树测试。
func TestBuildTreeJSONEmpty() string {
	return buildTreeJSON(nil, nil)
}

// TestBuildTreeJSON 包装 buildTreeJSON，接受匿名结构体输入以绕过 treeSession 未导出限制。
func TestBuildTreeJSON(projects []ProjectInfo, sessions []struct {
	ID, Title, ProjectID, Directory string
	UpdatedAt                       int64
}) string {
	ts := make([]treeSession, len(sessions))
	for i, s := range sessions {
		ts[i] = treeSession{
			ID:        s.ID,
			Title:     s.Title,
			ProjectID: s.ProjectID,
			Directory: s.Directory,
			Time:      sessionTime{Updated: s.UpdatedAt},
		}
	}
	return buildTreeJSON(projects, ts)
}

// 包级变量引用，供外部测试读写。
var (
	TestLastCfgHost     = &LastCfgHost
	TestLastCfgPort     = &LastCfgPort
	TestDefaultHostname = defaultHostname
	TestWebSessMu       = &WebSessMu
	TestSetWebSessNil   = func() { WebSess = nil }
)

// TestRunGitCommand 导出 git 命令执行器供测试仓库搭建使用。
func TestRunGitCommand(dir string, args ...string) (string, error) {
	return runGitCommand(dir, args...)
}
