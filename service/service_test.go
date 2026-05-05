package service

import (
	"strings"
	"testing"
)

func TestGetWebSessionNil(t *testing.T) {
	origHost, origPort := LastCfgHost, LastCfgPort
	t.Cleanup(func() {
		LastCfgHost = origHost
		LastCfgPort = origPort
	})
	LastCfgHost = defaultHostname
	LastCfgPort = 1

	WebSessMu.Lock()
	WebSess = nil
	WebSessMu.Unlock()
	if sess := getWebSession(); sess != nil {
		t.Fatal("expected nil webSession when no serve is running")
	}
}

func TestBuildTreeJSONEmpty(t *testing.T) {
	result := buildTreeJSON(nil, nil)
	if result != "[]" {
		t.Fatalf("empty tree should be [], got %s", result)
	}
}

func TestBuildTreeJSONGroups(t *testing.T) {
	projects := []ProjectInfo{
		{ID: "global", Name: "全局项目", Worktree: "/"},
	}
	sessions := []treeSession{
		{ID: "ses_1", Title: "测试会话1", ProjectID: "global", Directory: "D:\\test"},
		{ID: "ses_2", Title: "测试会话2", ProjectID: "global", Directory: "D:\\test"},
		{ID: "ses_3", Title: "测试会话3", ProjectID: "global", Directory: "C:\\other"},
	}

	result := buildTreeJSON(projects, sessions)

	for _, want := range []string{`"type":"project"`, `"type":"directory"`, `"type":"session"`, `ses_1`, `ses_2`, `ses_3`, `D:\\test`, `C:\\other`} {
		if !strings.Contains(result, want) {
			t.Fatalf("tree missing %q: %s", want, result)
		}
	}
}
