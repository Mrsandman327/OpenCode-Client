// session_map.go —— 飞书会话 ↔ OpenCode 会话的映射
//
// 每个飞书会话（私聊或群）绑定一个 OpenCode 会话，绑定关系需持久化：
// 重启后继续上次对话是基本预期，否则每次重启都要重新 `/new`。
//
// 「当前项目」与「绑定会话」是**两件独立的事**：
// `/clear` 与 `/switch_project` 都会解除会话绑定，但用户切换过的项目
// 应当保留——否则 `/new_session` 会退回默认项目，让用户以为切换没生效。
//
// 并发安全：飞书事件与卡片回调在不同 goroutine 触发，同一 chat 的
// 绑定可能被并发读写。
package feishu

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ChatSession 是一个飞书会话的绑定状态。
type ChatSession struct {
	// SessionID 是绑定的 OpenCode 会话；空表示尚未创建。
	SessionID string `json:"sessionID"`
	// ProjectPath 是该会话工作的项目目录。
	ProjectPath string `json:"projectPath"`
	// Model 是该会话使用的模型。
	Model string `json:"model,omitempty"`
	// UpdatedAt 是最后一次活跃时间（毫秒）。
	UpdatedAt int64 `json:"updatedAt"`
}

// maxPersistedSessions 是持久化上限，防止文件无限增长。
// 与 bot 侧一致取 200。
const maxPersistedSessions = 200

// SessionMap 管理 chatID → 会话 的映射，并负责持久化。
type SessionMap struct {
	mu    sync.Mutex
	items map[string]*ChatSession
	path  string
}

// NewSessionMap 建映射。path 为空则不持久化（仅内存）。
func NewSessionMap(path string) *SessionMap {
	m := &SessionMap{
		items: make(map[string]*ChatSession),
		path:  path,
	}
	m.load()
	return m
}

// Get 返回该 chat 的绑定状态副本；不存在时返回一个空状态（不写回）。
func (m *SessionMap) Get(chatID string) ChatSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.items[chatID]; ok {
		return *s
	}
	return ChatSession{}
}

// Bound 返回该 chat 是否已绑定会话。
func (m *SessionMap) Bound(chatID string) bool {
	return m.Get(chatID).SessionID != ""
}

// Set 覆盖该 chat 的绑定并持久化。
func (m *SessionMap) Set(chatID string, s ChatSession) {
	s.UpdatedAt = time.Now().UnixMilli()
	m.mu.Lock()
	m.items[chatID] = &s
	m.mu.Unlock()
	m.save()
}

// Bind 绑定一个 OpenCode 会话。
func (m *SessionMap) Bind(chatID, sessionID, projectPath, model string) {
	m.Set(chatID, ChatSession{
		SessionID:   sessionID,
		ProjectPath: projectPath,
		Model:       model,
	})
}

// Unbind 解除绑定（`/clear` 语义：只断绑定，不删服务端会话）。
//
// **保留 ProjectPath**：解绑的是会话，不是「我正在这个项目工作」这件事。
// 丢掉它会让 `/new_session` 退回默认项目，用户切过的项目白切。
func (m *SessionMap) Unbind(chatID string) {
	m.mu.Lock()
	s, ok := m.items[chatID]
	if ok {
		keep := *s
		keep.SessionID = ""
		m.items[chatID] = &keep
	} else {
		m.items[chatID] = &ChatSession{}
	}
	m.mu.Unlock()
	m.save()
}

// SetProject 记录当前项目，**不**影响会话绑定。
//
// `/switch_project` 用它：换项目即换工作目录，此时不该继续用旧会话
// （agent 会在旧目录读写而用户以为已切过去），但项目本身要记住。
func (m *SessionMap) SetProject(chatID, projectPath string) {
	m.mu.Lock()
	s, ok := m.items[chatID]
	var cur ChatSession
	if ok {
		cur = *s
	}
	cur.ProjectPath = projectPath
	cur.UpdatedAt = time.Now().UnixMilli()
	m.items[chatID] = &cur
	m.mu.Unlock()
	m.save()
}

// Project 返回该 chat 记住的项目路径（可能为空）。
func (m *SessionMap) Project(chatID string) string {
	return m.Get(chatID).ProjectPath
}

// Len 当前记录数（含已解绑但记住了项目的）。
func (m *SessionMap) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.items)
}

// load 从磁盘恢复。文件缺失或损坏都降级为空，不阻断启动——
// 映射丢失只是丢历史会话，不该让整个程序起不来。
func (m *SessionMap) load() {
	if m.path == "" {
		return
	}
	raw, err := os.ReadFile(m.path)
	if err != nil {
		return
	}
	var items map[string]*ChatSession
	if err := json.Unmarshal(raw, &items); err != nil {
		return
	}
	if items != nil {
		m.items = items
	}
}

// save 落盘。写失败不向上抛：绑定已在内存中生效，
// 只是重启后不持久——为此中断当前对话不值得。
func (m *SessionMap) save() {
	if m.path == "" {
		return
	}
	m.mu.Lock()
	// 超出上限时丢掉最久未活跃的
	if len(m.items) > maxPersistedSessions {
		m.pruneLocked()
	}
	snapshot := make(map[string]*ChatSession, len(m.items))
	for k, v := range m.items {
		cp := *v
		snapshot[k] = &cp
	}
	m.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(m.path), 0o755); err != nil {
		return
	}
	raw, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return
	}
	// 先写临时文件再改名：避免写一半崩溃留下损坏的映射文件
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, m.path)
}

// pruneLocked 裁剪到上限，保留最近活跃的。调用方必须已持锁。
func (m *SessionMap) pruneLocked() {
	type kv struct {
		id string
		at int64
	}
	all := make([]kv, 0, len(m.items))
	for k, v := range m.items {
		all = append(all, kv{id: k, at: v.UpdatedAt})
	}
	// 按时间倒序
	for i := 0; i < len(all); i++ {
		for j := i + 1; j < len(all); j++ {
			if all[j].at > all[i].at {
				all[i], all[j] = all[j], all[i]
			}
		}
	}
	for i := maxPersistedSessions; i < len(all); i++ {
		delete(m.items, all[i].id)
	}
}
