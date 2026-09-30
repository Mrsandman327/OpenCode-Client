//go:build feishu

// app_feishu.go —— 飞书通道接入 OC Manager 生命周期
//
// 职责边界：把 feishu 包的客户端与桥接层接到 App 的启动/关闭生命周期上，
// 并把状态透给前端。本文件不含任何业务逻辑——
// 那些都在 service/feishu 里，那一层不需要知道 Wails 存在。
//
// 编译期可拆：本文件（连同对飞书 SDK / service/feishu 的全部依赖）
// 只在 `-tags feishu` 时参与编译。不带该 tag 时，本文件整体不编译，
// 核心通过 optional_channel.go 的中立接口与空注册表照常工作。

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"

	"oc-manager/internal/logger"
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
// setFeishuStatus 在短临界区内更新状态。
//
// 单独抽出来是为了强调一条铁律：**绝不持锁跨越任何外部调用**。
// 曾因违反它把整个 GUI 卡死——见 StartFeishu 的注释。
func setFeishuStatus(fn func(s *FeishuStatus)) {
	feishuRT.mu.Lock()
	defer feishuRT.mu.Unlock()
	fn(&feishuRT.status)
}

func (a *App) StartFeishu(ctx context.Context, cfg FeishuConfig) error {
	// ⚠️ 本函数**不在**任何全局锁下执行外部调用。
	//
	// 曾经的写法是「全程持锁 + defer Unlock」，而 client.StartAsync
	// 里的 c.setState(StateConnecting) 会**同 goroutine 同步**回调 OnState，
	// 回调里又取同一把锁 —— sync.Mutex 不可重入，直接自死锁。
	// 后果是 ServiceStartup 永不返回 → app.Run() 不完成 → 主窗口不显示，
	// 进程表现为「Not Responding、CPU 0 秒」。
	//
	// 教训：状态回调是**外部代码**，它随时可能回调回来拿你的锁。

	// 先摘出旧的（短临界区）：重复 Start 会造成两个长连接同时收消息，
	// 同一条消息被处理两次
	feishuRT.mu.Lock()
	old := feishuRT.client
	oldBridge := feishuRT.bridge
	feishuRT.client = nil
	feishuRT.bridge = nil
	feishuRT.mu.Unlock()
	// 旧桥接层也要收：它持有事件订阅与心跳定时器（见 StopFeishu 的注释）
	if oldBridge != nil {
		oldBridge.Close()
	}
	if old != nil {
		_ = old.Stop(context.Background())
	}

	setFeishuStatus(func(s *FeishuStatus) {
		*s = FeishuStatus{
			Enabled:    cfg.Enabled,
			Configured: cfg.AppID != "" && cfg.AppSecret != "",
			OpenAccess: cfg.AllowAllUsers,
		}
	})

	if !cfg.Enabled {
		setFeishuStatus(func(s *FeishuStatus) { s.State = string(feishu.StateIdle) })
		return nil
	}
	if cfg.AppID == "" || cfg.AppSecret == "" {
		setFeishuStatus(func(s *FeishuStatus) {
			s.State = string(feishu.StateIdle)
			s.LastError = "未配置 app_id / app_secret，通道未启动"
		})
		return nil
	}

	client, err := feishu.New(feishu.Config{AppID: cfg.AppID, AppSecret: cfg.AppSecret})
	if err != nil {
		setFeishuStatus(func(s *FeishuStatus) {
			s.State = string(feishu.StateFailed)
			s.LastError = err.Error()
		})
		return err
	}

	// 启动时打安全告警：放行态是最容易漏看的安全配置，
	// 而漏看的后果是任何人都能在服务器上执行工具
	if feishu.ShouldWarnOpenAccess(feishu.AccessPolicy{AllowAllUsers: cfg.AllowAllUsers}) {
		// 走 logger 而非 fmt.Println：GUI 构建无控制台（-H windowsgui），
		// Println 的输出无处可去。安全告警丢不得。
		logger.Printf("[feishu] ⚠️ %s", feishu.OpenAccessWarning(len(cfg.AdminUserIDs)))
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
	// 回调由 SDK 在 StartAsync 内部**同 goroutine 同步**触发，
	// 因此这里绝不能依赖调用方持锁 —— 调用方已经不持锁了，但这条
	// 约束要保留：任何在 StartFeishu 里新增的持锁区都可能重蹈覆辙。
	client.OnState(func(state feishu.State) {
		setFeishuStatus(func(s *FeishuStatus) {
			s.State = string(state)
			s.Running = state == feishu.StateReady
		})
		a.emitFeishuStatus()
	})

	// 启动失败不阻断应用：飞书是可选通道，opencode 本体照常用。
	// 但必须把错误记进状态，否则用户只会看到「没反应」。
	// 注意：这里**不持锁**。StartAsync 会同步触发 OnState，
	// 持锁调用就是自死锁（见函数头注释）。
	if err := client.StartAsync(ctx); err != nil {
		setFeishuStatus(func(s *FeishuStatus) {
			s.State = string(feishu.StateFailed)
			s.LastError = err.Error()
		})
		return err
	}

	feishuRT.mu.Lock()
	feishuRT.client = client
	feishuRT.bridge = bridge
	feishuRT.status.LastError = ""
	feishuRT.status.WhitelistCount = whitelist.Len()
	feishuRT.mu.Unlock()
	return nil
}

// StopFeishu 停止通道。可重复调用。
func (a *App) StopFeishu() error {
	feishuRT.mu.Lock()
	client := feishuRT.client
	bridge := feishuRT.bridge
	feishuRT.client = nil
	feishuRT.bridge = nil
	feishuRT.status.Running = false
	feishuRT.status.State = string(feishu.StateIdle)
	feishuRT.mu.Unlock()

	// **先收桥接层**再停客户端。顺序反了会漏事件：
	// 桥接层持有 OpenCode 事件订阅（自己会重连）与心跳定时器，
	// 不收就等于进程退出前一直在重连并往一个已停的飞书连接发卡片。
	if bridge != nil {
		bridge.Close()
	}
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

// ============ OptionalChannel 适配（自注册） ============

// feishuChannel 把飞书启停逻辑适配成核心的 OptionalChannel 接口。
type feishuChannel struct{ app *App }

// Name 实现 OptionalChannel。
func (c *feishuChannel) Name() string { return "feishu" }

// AutoStart 实现 OptionalChannel：读自己的配置，已启用且凭据齐全才启动。
// 「没配过」不是错误，因此只有配置满足条件时才尝试。
func (c *feishuChannel) AutoStart(ctx context.Context) error {
	cfg := LoadFeishuConfig()
	if !cfg.Enabled || cfg.AppID == "" || cfg.AppSecret == "" {
		return nil
	}
	return c.app.StartFeishu(ctx, cfg)
}

// Shutdown 实现 OptionalChannel。
func (c *feishuChannel) Shutdown() error { return c.app.StopFeishu() }

// init 自注册工厂：带 feishu tag 编译时，核心即可构造出本通道；
// 不带 tag 时本文件不参与编译，注册表里没有飞书。
func init() {
	registerOptionalChannel(func(a *App) OptionalChannel {
		return &feishuChannel{app: a}
	})
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
