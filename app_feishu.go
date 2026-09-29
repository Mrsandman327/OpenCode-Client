// app_feishu.go —— 飞书通道接入 OC Manager 生命周期
//
// 职责边界：把 feishu 包的客户端与桥接层接到 App 的启动/关闭生命周期上，
// 并把状态透给前端。本文件不含任何业务逻辑——
// 那些都在 service/feishu 里，那一层不需要知道 Wails 存在。

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"

	"oc-manager/service/feishu"
)

// FeishuConfig 是飞书通道的配置。
//
// 凭据**不**放进这里：AppID/Secret 从磁盘配置读，
// 因为它们会经由前端绑定/状态接口暴露给界面。
type FeishuConfig struct {
	// Enabled 为 false 时不启动通道。
	Enabled bool `json:"enabled"`
	// AppID / AppSecret 是飞书应用凭据。
	AppID     string `json:"appID"`
	AppSecret string `json:"appSecret"`
	// AllowAllUsers 为 true 时放行所有用户（仅启动时告警）。
	AllowAllUsers bool `json:"allowAllUsers"`
	// AdminUserIDs 是管理员 open_id，任何时候都放行。
	AdminUserIDs []string `json:"adminUserIDs"`
	// DefaultProject 是新建会话时的默认项目目录。
	DefaultProject string `json:"defaultProject"`
	// DefaultModel 是新建会话时的默认模型。
	DefaultModel string `json:"defaultModel"`
	// Projects 是菜单下拉里可切换的项目目录；为空则不渲染该下拉。
	Projects []string `json:"projects"`
	// Models 是菜单下拉里可切换的模型（provider/model 形态）。
	Models []string `json:"models"`
}

// FeishuStatus 是给前端看的通道状态。
type FeishuStatus struct {
	Enabled bool   `json:"enabled"`
	Running bool   `json:"running"`
	State   string `json:"state"`
	// Configured 为 true 表示凭据已填。
	Configured bool `json:"configured"`
	// OpenAccess 为 true 表示当前处于「放行所有人」状态。
	OpenAccess bool `json:"openAccess"`
	// WhitelistCount 是白名单人数。
	WhitelistCount int `json:"whitelistCount"`
	// LastError 是最近一次错误（成功启动后清空）。
	LastError string `json:"lastError,omitempty"`
}

// feishuRuntime 持有运行中的通道组件。
type feishuRuntime struct {
	mu     sync.Mutex
	client *feishu.Client
	bridge *feishu.Bridge
	status FeishuStatus
}

var feishuRT = &feishuRuntime{}

// feishuConfigPath 返回配置文件路径。
//
// 放在用户配置目录下而非程序目录：程序目录可能是只读的，
// 而且升级程序时不该连带丢掉用户的白名单与会话映射。
func feishuConfigPath() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "oc-manager", "feishu.json")
}

// feishuDataDir 返回运行期数据目录（会话映射、白名单）。
func feishuDataDir() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "oc-manager", "feishu")
}

// LoadFeishuConfig 读配置。文件不存在返回零值，不报错——
// 「没配过」是正常状态，不是错误。
func LoadFeishuConfig() FeishuConfig {
	var cfg FeishuConfig
	raw, err := os.ReadFile(feishuConfigPath())
	if err != nil {
		return cfg
	}
	// 解析失败也返回零值：让用户看到「未配置」并去修文件，
	// 比启动时 panic 更可操作
	_ = json.Unmarshal(raw, &cfg)
	return cfg
}

// SaveFeishuConfig 写配置。
func SaveFeishuConfig(cfg FeishuConfig) error {
	path := feishuConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// GetFeishuConfig 返回当前配置（供前端展示与编辑）。
func (a *App) GetFeishuConfig() FeishuConfig {
	return LoadFeishuConfig()
}

// GetFeishuStatus 返回通道状态。
func (a *App) GetFeishuStatus() FeishuStatus {
	feishuRT.mu.Lock()
	defer feishuRT.mu.Unlock()
	return feishuRT.status
}

// StartFeishu 按配置启动飞书通道。
//
// 幂等：已在运行时先停再起。配置不完整或未启用时返回 nil（不算错误）——
// 用户没配飞书是正常状态，不该在启动路径上报错。
func (a *App) StartFeishu(ctx context.Context, cfg FeishuConfig) error {
	feishuRT.mu.Lock()
	defer feishuRT.mu.Unlock()

	// 先停掉旧的：重复 Start 会造成两个长连接同时收消息，
	// 同一条消息被处理两次
	if feishuRT.client != nil {
		_ = feishuRT.client.Stop(context.Background())
		feishuRT.client = nil
		feishuRT.bridge = nil
	}

	feishuRT.status = FeishuStatus{
		Enabled:    cfg.Enabled,
		Configured: cfg.AppID != "" && cfg.AppSecret != "",
		OpenAccess: cfg.AllowAllUsers,
	}

	if !cfg.Enabled {
		feishuRT.status.State = string(feishu.StateIdle)
		return nil
	}
	if cfg.AppID == "" || cfg.AppSecret == "" {
		feishuRT.status.State = string(feishu.StateIdle)
		feishuRT.status.LastError = "未配置 app_id / app_secret，通道未启动"
		return nil
	}

	client, err := feishu.New(feishu.Config{AppID: cfg.AppID, AppSecret: cfg.AppSecret})
	if err != nil {
		feishuRT.status.State = string(feishu.StateFailed)
		feishuRT.status.LastError = err.Error()
		return err
	}

	// 启动时打安全告警：放行态是最容易漏看的安全配置，
	// 而漏看的后果是任何人都能在服务器上执行工具
	if feishu.ShouldWarnOpenAccess(feishu.AccessPolicy{AllowAllUsers: cfg.AllowAllUsers}) {
		fmt.Println("⚠️ " + feishu.OpenAccessWarning(len(cfg.AdminUserIDs)))
	}

	dataDir := feishuDataDir()
	sessions := feishu.NewSessionMap(filepath.Join(dataDir, "sessions.json"))
	whitelist := feishu.NewWhitelist(filepath.Join(dataDir, "whitelist.json"))

	bridge := feishu.NewBridge(
		feishu.NewRealOpenCode(),
		client,
		sessions,
		whitelist,
		feishu.BridgeConfig{
			AllowAllUsers:  cfg.AllowAllUsers,
			AdminUserIDs:   cfg.AdminUserIDs,
			DefaultProject: cfg.DefaultProject,
			DefaultModel:   cfg.DefaultModel,
			Projects:       cfg.Projects,
			Models:         cfg.Models,
		},
	)

	client.OnMessage(func(ctx context.Context, msg *types.NormalizedMessage) {
		bridge.HandleMessage(ctx, feishu.IncomingMessage{
			ChatID:  msg.ChatID,
			UserID:  msg.UserID,
			Text:    stripBotMention(msg),
			IsGroup: msg.ChatType == "group",
		})
	})
	client.OnCardAction(func(ctx context.Context, ev *types.CardActionEvent) {
		bridge.HandleCardAction(ctx, feishu.CardAction{
			ChatID:    ev.ChatID,
			UserID:    ev.Operator.OpenID,
			MessageID: ev.MessageID,
			Value:     ev.Action.Value,
			Option:    ev.Action.Option,
			FormValue: ev.Action.FormValue,
			FormName:  ev.Action.Name,
		})
	})
	client.OnState(func(state feishu.State) {
		feishuRT.mu.Lock()
		feishuRT.status.State = string(state)
		feishuRT.status.Running = state == feishu.StateReady
		feishuRT.mu.Unlock()
		a.emitFeishuStatus()
	})

	// 启动失败不阻断应用：飞书是可选通道，opencode 本体照常用。
	// 但必须把错误记进状态，否则用户只会看到「没反应」。
	if err := client.StartAsync(ctx); err != nil {
		feishuRT.status.State = string(feishu.StateFailed)
		feishuRT.status.LastError = err.Error()
		return err
	}

	feishuRT.client = client
	feishuRT.bridge = bridge
	feishuRT.status.LastError = ""
	feishuRT.status.WhitelistCount = whitelist.Len()
	return nil
}

// StopFeishu 停止通道。可重复调用。
func (a *App) StopFeishu() error {
	feishuRT.mu.Lock()
	client := feishuRT.client
	feishuRT.client = nil
	feishuRT.bridge = nil
	feishuRT.status.Running = false
	feishuRT.status.State = string(feishu.StateIdle)
	feishuRT.mu.Unlock()

	if client == nil {
		return nil
	}
	// 用独立的 ctx：关停时传入的 ctx 可能已取消
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return client.Stop(ctx)
}

// ApplyFeishuConfig 保存配置并按新配置重启通道。
//
// 保存与重启必须一起做：只保存不重启，用户会以为配置已生效。
func (a *App) ApplyFeishuConfig(cfg FeishuConfig) error {
	if err := SaveFeishuConfig(cfg); err != nil {
		return err
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return a.StartFeishu(ctx, cfg)
}

// emitFeishuStatus 把状态推给前端。
func (a *App) emitFeishuStatus() {
	if a.app == nil {
		return
	}
	st := a.GetFeishuStatus()
	a.app.Event.Emit("feishu-status", st)
}

// stripBotMention 去掉群聊里的 @机器人 前缀。
//
// 不去掉的话，「@bot /help」会被当成普通消息发进 OpenCode，
// 用户会看到机器人把自己的 @ 复读回来。
func stripBotMention(msg *types.NormalizedMessage) string {
	text := msg.Content
	for _, m := range msg.Mentions {
		if m.IsBot {
			text = strings.ReplaceAll(text, m.Key, "")
			if m.Name != "" {
				text = strings.ReplaceAll(text, m.Name, "")
			}
		}
	}
	return strings.TrimSpace(text)
}
