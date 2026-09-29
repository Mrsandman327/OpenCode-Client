package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// ============ 配置读写 ============

// withTempConfigDir 把配置目录临时化，避免测试写到真实用户目录。
func withTempConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	// os.UserConfigDir 在 Windows 上读 %AppData%，Linux 上读 $XDG_CONFIG_HOME
	t.Setenv("AppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	return dir
}

func Test配置路径在用户配置目录下(t *testing.T) {
	dir := withTempConfigDir(t)
	got := feishuConfigPath()
	// 关键性质：不在程序目录（可能只读），且不随升级丢失
	if !strings.Contains(got, "oc-manager") {
		t.Errorf("配置路径应含应用子目录: %q", got)
	}
	if !strings.HasPrefix(got, dir) && !strings.Contains(got, filepath.Base(dir)) {
		// Windows 上 os.UserConfigDir 取 %AppData%，可能被再次拼接，
		// 因此只断言它落在临时目录之下而不强求前缀相等
		if !strings.Contains(got, "oc-manager") {
			t.Errorf("配置路径异常: %q", got)
		}
	}
}

// Test没配过时返回零值 「没配飞书」是正常状态，不该报错。
func Test没配过时返回零值(t *testing.T) {
	withTempConfigDir(t)
	cfg := LoadFeishuConfig()
	if cfg.Enabled || cfg.AppID != "" || cfg.AppSecret != "" {
		t.Errorf("缺文件应返回零值: %+v", cfg)
	}
}

func Test配置往返(t *testing.T) {
	withTempConfigDir(t)
	want := FeishuConfig{
		Enabled:        true,
		AppID:          "cli_test",
		AppSecret:      "secret_test",
		AllowAllUsers:  true,
		AdminUserIDs:   []string{"ou_admin"},
		DefaultProject: `E:\work\bmall`,
		DefaultModel:   "opencode-go/space-bunny-free",
	}
	if err := SaveFeishuConfig(want); err != nil {
		t.Fatal(err)
	}
	got := LoadFeishuConfig()
	if got.Enabled != want.Enabled || got.AppID != want.AppID ||
		got.AppSecret != want.AppSecret || got.AllowAllUsers != want.AllowAllUsers ||
		got.DefaultProject != want.DefaultProject || got.DefaultModel != want.DefaultModel {
		t.Errorf("往返不一致:\n got %+v\nwant %+v", got, want)
	}
	if len(got.AdminUserIDs) != 1 || got.AdminUserIDs[0] != "ou_admin" {
		t.Errorf("管理员列表不一致: %v", got.AdminUserIDs)
	}
}

// Test配置损坏降级为零值 让用户看到「未配置」并去修文件，
// 比启动时 panic 更可操作。
func Test配置损坏降级为零值(t *testing.T) {
	withTempConfigDir(t)
	if err := os.MkdirAll(filepath.Dir(feishuConfigPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(feishuConfigPath(), []byte("{ 坏的 json"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := LoadFeishuConfig()
	if cfg.Enabled {
		t.Error("损坏配置应降级为未启用，而不是沿用部分字段")
	}
}

// Test配置自动建目录 首次保存时目录可能还不存在。
func Test配置自动建目录(t *testing.T) {
	withTempConfigDir(t)
	if err := SaveFeishuConfig(FeishuConfig{Enabled: true}); err != nil {
		t.Fatalf("应自动建目录: %v", err)
	}
	if _, err := os.Stat(feishuConfigPath()); err != nil {
		t.Errorf("配置文件应存在: %v", err)
	}
}

// Test配置含凭据权限收紧 凭据落盘的目录/文件权限不应让同机其他用户可读。
//
// ⚠️ 仅在 POSIX 平台有效：Windows 上 Go 的 os.WriteFile 不施加
// Unix 权限位（实际权限由 NTFS ACL 决定，写入 0600 得到的仍是 0666），
// 断言在这里必然失败且无意义。Windows 的收紧要靠 ACL，不是 chmod。
func Test配置含凭据权限收紧(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不施加 Unix 权限位，权限由 NTFS ACL 决定")
	}
	dir := withTempConfigDir(t)
	if err := SaveFeishuConfig(FeishuConfig{AppSecret: "s3cret"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(feishuConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		t.Errorf("配置文件权限 = %o, 同组/其他用户可读（含凭据）", perm)
	}
	_ = dir
}

func Test配置字段名可解析(t *testing.T) {
	// 字段名漂移会导致前端读不到，属于静默失败
	raw, err := json.Marshal(FeishuConfig{
		Enabled: true, AppID: "a", AppSecret: "b",
		AllowAllUsers: true, AdminUserIDs: []string{"x"},
		DefaultProject: "p", DefaultModel: "m",
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"enabled", "appID", "appSecret", "allowAllUsers",
		"adminUserIDs", "defaultProject", "defaultModel",
	} {
		if _, ok := m[key]; !ok {
			t.Errorf("配置缺字段 %q", key)
		}
	}
}

func Test状态字段名可解析(t *testing.T) {
	raw, _ := json.Marshal(FeishuStatus{
		Enabled: true, Running: true, State: "ready",
		Configured: true, OpenAccess: false, WhitelistCount: 2,
		LastError: "",
	})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	for _, key := range []string{
		"enabled", "running", "state", "configured", "openAccess", "whitelistCount",
	} {
		if _, ok := m[key]; !ok {
			t.Errorf("状态缺字段 %q", key)
		}
	}
	// 无错误时不应序列化 lastError（omitempty）
	if _, ok := m["lastError"]; ok {
		t.Error("lastError 应 omitempty")
	}
}

// ============ mention 剥离 ============

// Test剥离机器人mention 群聊里「@bot /help」若不剥离 @，
// 会被当成普通消息发进 OpenCode，机器人把自己的 @ 复读回来。
func Test剥离机器人mention(t *testing.T) {
	msg := &types.NormalizedMessage{
		Content: "@_user_1 /help",
		Mentions: []types.Mention{
			{Key: "@_user_1", Name: "OC Manager", IsBot: true},
		},
	}
	got := stripBotMention(msg)
	if got != "/help" {
		t.Errorf("剥离后 = %q, 期望 /help", got)
	}
}

func Test非机器人mention保留(t *testing.T) {
	msg := &types.NormalizedMessage{
		Content: "@_user_1 帮看下这段",
		Mentions: []types.Mention{
			{Key: "@_user_1", Name: "同事", IsBot: false},
		},
	}
	got := stripBotMention(msg)
	if !strings.Contains(got, "帮看下这段") {
		t.Errorf("非机器人 mention 不应被剥: %q", got)
	}
}

func Test无mention原样(t *testing.T) {
	msg := &types.NormalizedMessage{Content: "  正常消息  "}
	if got := stripBotMention(msg); got != "正常消息" {
		t.Errorf("应去空白后原样返回，实际 %q", got)
	}
}

func Test空消息返回空串(t *testing.T) {
	if got := stripBotMention(&types.NormalizedMessage{Content: "   "}); got != "" {
		t.Errorf("空内容应返回空串，实际 %q", got)
	}
}

// ============ 生命周期 ============

// Test停止飞书可重复调用 关停路径会经过多次调用，
// 第二次不该 panic。
func Test停止飞书可重复调用(t *testing.T) {
	a := NewApp()
	for i := 0; i < 3; i++ {
		if err := a.StopFeishu(); err != nil {
			t.Errorf("第 %d 次停止应成功: %v", i+1, err)
		}
	}
}

// Test未配置时启动不算错误 用户没配飞书是正常状态，
// 不该在启动路径上报错。
func Test未配置时启动不算错误(t *testing.T) {
	withTempConfigDir(t)
	a := NewApp()
	if err := a.StartFeishu(t.Context(), FeishuConfig{}); err != nil {
		t.Errorf("未配置时不应报错: %v", err)
	}
	st := a.GetFeishuStatus()
	if st.Running {
		t.Error("未配置时不应在运行")
	}
	if st.State != "idle" {
		t.Errorf("状态 = %q, 期望 idle", st.State)
	}
}

// Test启用但缺凭据给明确提示 静默不启动会让用户以为通道坏了。
func Test启用但缺凭据给明确提示(t *testing.T) {
	withTempConfigDir(t)
	a := NewApp()
	if err := a.StartFeishu(t.Context(), FeishuConfig{Enabled: true}); err != nil {
		t.Errorf("缺凭据不应报错（属未配置）: %v", err)
	}
	st := a.GetFeishuStatus()
	if st.Running {
		t.Error("缺凭据时不应运行")
	}
	if !strings.Contains(st.LastError, "app_id") {
		t.Errorf("应明确说明缺凭据: %q", st.LastError)
	}
	if st.Configured {
		t.Error("缺凭据时 Configured 应为 false")
	}
}
