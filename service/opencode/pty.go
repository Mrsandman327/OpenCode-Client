package opencode

// PTY 终端接入。
//
// 背景与边界：
//   - 浏览器的 WebSocket 构造函数不支持自定义 Authorization 头，而 OpenCode 的
//     /api/pty/{id}/connect 必须带 Basic 认证；connect-token 端点实测返回 403。
//     因此前端**不能**直连 PTY，必须由本进程（Go 后端）带认证中转。
//   - 输出通道采用「拉取」而不是「事件推送」：前端定时调用 PtyRead 取增量。
//     这样桌面模式（Wails 绑定）与浏览器模式（/api/app-call）走同一条路径，
//     不需要为两种运行环境各写一套事件订阅逻辑。
//   - 输出一律以 base64 原样传输，前端解码成 Uint8Array 再写入 xterm，
//     避免把字节流转成字符串时切断多字节字符（中文/emoji）导致乱码。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// ptyMaxPendingBytes 单个会话待取输出的上限（4MB）。
	// 超过后丢弃最旧的块并标记 truncated：终端刷屏（如 dir /s）时宁可丢开头，
	// 也不能让内存无限增长。
	ptyMaxPendingBytes = 4 << 20
	// ptyMaxReadLimit 单条 WebSocket 消息的读取上限，防止异常数据撑爆内存。
	ptyMaxReadLimit = 32 << 20
	// ptyReadChunkLimit 单次 PtyRead 最多返回的字节数，避免一次响应过大。
	ptyReadChunkLimit = 256 << 10
	// ptyHTTPTimeout 创建/删除/调整尺寸等控制请求的超时。
	ptyHTTPTimeout = 15 * time.Second
	// ptyIdleReapAfter 会话多久没有被读取就判定为「客户端已消失」并回收。
	// 前端每 40ms 拉取一次，正常使用时不可能出现 5 分钟的空档；
	// 出现只可能是页面被关闭/刷新或 WebView 崩溃，此时必须结束进程，
	// 否则就会留下用户看不到、也无法管理的 shell。
	ptyIdleReapAfter = 5 * time.Minute
	// ptyReapInterval 回收扫描周期。
	ptyReapInterval = 30 * time.Second
)

// PtyInfo 是创建成功后返回给前端的会话描述。
type PtyInfo struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
	PID     int    `json:"pid"`
	Status  string `json:"status"`
}

// PtyReadResult 是 PtyRead 的返回值。
// Chunks 为 base64 编码的原始字节，按产生顺序排列；前端依次写入 xterm。
type PtyReadResult struct {
	Chunks    []string `json:"chunks"`
	Alive     bool     `json:"alive"`
	Truncated bool     `json:"truncated"`
	ExitCode  int      `json:"exitCode"`
	Error     string   `json:"error"`
}

// ptySession 是后端持有的一条终端会话：一个上游 WebSocket 连接 + 一段待取输出缓冲。
type ptySession struct {
	id      string
	dir     string
	title   string
	command string
	cwd     string
	pid     int

	conn   *websocket.Conn
	cancel context.CancelFunc

	mu           sync.Mutex
	pending      [][]byte // 尚未被前端取走的输出块
	pendingBytes int
	truncated    bool
	alive        bool
	exitErr      string
	lastAccess   time.Time // 最近一次被读取的时间（用于回收失去客户端的会话）
}

var (
	ptyMu       sync.Mutex
	ptySessions = map[string]*ptySession{}
	ptyReaper   sync.Once
)

// ========== 对外方法 ==========

// PtyCreate 在指定目录创建 PTY 并建立上游 WebSocket 连接。
// dir 为终端工作目录（文件浏览器根目录），会同时作为 location[directory] 传参，
// 否则列/连都会落到 OpenCode 的默认 location（用户 home）而找不到该 PTY。
func PtyCreate(dir, command, title string) (PtyInfo, error) {
	sess := getWebSession()
	if sess == nil {
		return PtyInfo{}, errors.New("opencode 服务未启动")
	}
	if strings.TrimSpace(dir) == "" {
		return PtyInfo{}, errors.New("终端工作目录不能为空")
	}
	if command == "" {
		// 由后端按平台决定 shell：Windows 用 PowerShell，类 Unix 用 $SHELL。
		// 前端不要硬编码 shell 名，否则在另一平台会直接创建失败。
		command = defaultShellCommand()
	}
	if title == "" {
		title = shellDisplayName(command)
	}

	info, err := createPtyHTTP(sess, dir, command, title)
	if err != nil {
		return PtyInfo{}, err
	}

	ps := &ptySession{
		id:      info.ID,
		dir:     dir,
		title:   info.Title,
		command: info.Command,
		cwd:     info.Cwd,
		pid:     info.PID,
		alive:   true,
		lastAccess: time.Now(),
	}

	if err := connectPtyUpstream(ps, sess); err != nil {
		// 连接失败就把刚创建的上游 PTY 一并删掉，避免留下无法观察的孤儿进程。
		_ = deletePtyHTTP(sess, info.ID, dir)
		return PtyInfo{}, err
	}

	ptyMu.Lock()
	ptySessions[info.ID] = ps
	ptyMu.Unlock()

	// 启动空闲回收（只启动一次）：页面被直接关闭/刷新时不会有 PtyDelete，
	// 靠这里兜底结束那些已经没人读取的终端进程。
	startPtyReaper()

	return info, nil
}

// PtyRead 取走该会话自上次调用以来累积的输出。
// 没有新输出时返回空 Chunks，Alive 反映上游连接是否仍在。
func PtyRead(id string) (PtyReadResult, error) {
	ptyMu.Lock()
	ps := ptySessions[id]
	ptyMu.Unlock()
	if ps == nil {
		return PtyReadResult{}, fmt.Errorf("终端不存在: %s", id)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	// 记录访问时间，供空闲回收判断客户端是否还在
	ps.lastAccess = time.Now()

	res := PtyReadResult{Alive: ps.alive, Truncated: ps.truncated, Error: ps.exitErr}
	ps.truncated = false

	total := 0
	for _, chunk := range ps.pending {
		res.Chunks = append(res.Chunks, base64.StdEncoding.EncodeToString(chunk))
		total += len(chunk)
		if total >= ptyReadChunkLimit {
			break
		}
	}
	// 只清空已取走的部分：超出单次上限的剩余块留到下次读取。
	if len(res.Chunks) > 0 {
		if len(res.Chunks) >= len(ps.pending) {
			ps.pending = nil
			ps.pendingBytes = 0
		} else {
			for i := 0; i < len(res.Chunks); i++ {
				ps.pendingBytes -= len(ps.pending[i])
			}
			ps.pending = ps.pending[len(res.Chunks):]
		}
	}
	return res, nil
}

// PtyInput 把按键数据写入上游 PTY。data 是 xterm 产生的 UTF-8 文本。
func PtyInput(id, data string) error {
	ps := getPtySession(id)
	if ps == nil {
		return fmt.Errorf("终端不存在: %s", id)
	}
	if ps.conn == nil {
		return errors.New("终端连接已关闭")
	}
	ctx, cancel := context.WithTimeout(context.Background(), ptyHTTPTimeout)
	defer cancel()
	return ps.conn.Write(ctx, websocket.MessageText, []byte(data))
}

// PtyResize 同步终端行列数。
// 注意 v2 的请求体结构是 {"size":{"rows":..,"cols":..}}，不是平铺的 rows/cols。
func PtyResize(id string, rows, cols int) error {
	ps := getPtySession(id)
	if ps == nil {
		return fmt.Errorf("终端不存在: %s", id)
	}
	if rows <= 0 || cols <= 0 {
		return nil
	}
	sess := getWebSession()
	if sess == nil {
		return errors.New("opencode 服务未启动")
	}
	body, _ := json.Marshal(map[string]any{
		"size": map[string]int{"rows": rows, "cols": cols},
	})
	_, err := ptyRequest(sess, http.MethodPut, "/api/pty/"+url.PathEscape(id), ps.dir, body)
	return err
}

// PtyDelete 关闭上游连接并删除 PTY（连同其进程）。
// 这是「关闭标签即杀进程」的实现点，确保前端看不到的进程不会继续运行。
func PtyDelete(id string) error {
	ptyMu.Lock()
	ps := ptySessions[id]
	delete(ptySessions, id)
	ptyMu.Unlock()

	if ps != nil {
		ps.mu.Lock()
		ps.alive = false
		ps.pending = nil
		ps.pendingBytes = 0
		ps.mu.Unlock()
		if ps.cancel != nil {
			ps.cancel()
		}
		if ps.conn != nil {
			_ = ps.conn.Close(websocket.StatusNormalClosure, "closed by client")
		}
	}

	sess := getWebSession()
	if sess == nil {
		return nil // 服务已经没了，进程自然也没了
	}
	dir := ""
	if ps != nil {
		dir = ps.dir
	}
	return deletePtyHTTP(sess, id, dir)
}

// PtyCloseAll 关闭本进程持有的全部 PTY。应用退出时调用，避免留下孤儿终端。
func PtyCloseAll() {
	ptyMu.Lock()
	ids := make([]string, 0, len(ptySessions))
	for id := range ptySessions {
		ids = append(ids, id)
	}
	ptyMu.Unlock()
	for _, id := range ids {
		_ = PtyDelete(id)
	}
}

// ========== 内部实现 ==========

func getPtySession(id string) *ptySession {
	ptyMu.Lock()
	defer ptyMu.Unlock()
	return ptySessions[id]
}

// startPtyReaper 启动空闲会话回收协程（进程内只启动一次）。
func startPtyReaper() {
	ptyReaper.Do(func() {
		go func() {
			ticker := time.NewTicker(ptyReapInterval)
			defer ticker.Stop()
			for range ticker.C {
				reapIdlePty()
			}
		}()
	})
}

// reapIdlePty 结束长时间无人读取的终端。
// 前端以 40ms 为周期拉取输出，5 分钟没有读取只可能是页面已经关闭或崩溃。
func reapIdlePty() {
	cutoff := time.Now().Add(-ptyIdleReapAfter)
	ptyMu.Lock()
	stale := make([]string, 0, 4)
	for id, ps := range ptySessions {
		ps.mu.Lock()
		idle := ps.lastAccess.Before(cutoff)
		ps.mu.Unlock()
		if idle {
			stale = append(stale, id)
		}
	}
	ptyMu.Unlock()

	for _, id := range stale {
		_ = PtyDelete(id)
	}
}

// defaultShellCommand 返回当前平台的默认 shell。
// Windows 默认 CMD（启动快、无配置文件干扰），需要 PowerShell 时由前端显式指定；
// 类 Unix 优先用登录 shell（$SHELL），环境变量缺失时（从桌面启动器拉起常见）
// 按常见路径逐个探测。
func defaultShellCommand() string {
	if runtime.GOOS == "windows" {
		return "cmd.exe"
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		if info, err := os.Stat(shell); err == nil && !info.IsDir() {
			return shell
		}
	}
	for _, candidate := range []string{"/bin/bash", "/bin/zsh", "/usr/bin/bash", "/usr/bin/zsh", "/bin/sh"} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return "/bin/sh"
}

// PtyShell 是前端「新建终端」下拉里的一个可选项。
type PtyShell struct {
	Command string `json:"command"`
	Label   string `json:"label"`
	Default bool   `json:"default"`
}

// PtyShells 返回当前平台可选的 shell 列表。
// Windows 提供 CMD 与 PowerShell；类 Unix 只有系统默认 shell 一个选项。
func PtyShells() []PtyShell {
	if runtime.GOOS == "windows" {
		return []PtyShell{
			{Command: "cmd.exe", Label: "CMD", Default: true},
			{Command: "powershell.exe", Label: "PowerShell"},
		}
	}
	def := defaultShellCommand()
	return []PtyShell{{Command: def, Label: shellDisplayName(def), Default: true}}
}

// shellDisplayName 把 shell 可执行文件路径转成标签上显示的名字。
func shellDisplayName(command string) string {
	base := filepath.Base(command)
	switch strings.ToLower(base) {
	case "powershell.exe", "powershell":
		return "PowerShell"
	case "pwsh", "pwsh.exe":
		return "PowerShell 7"
	case "cmd.exe", "cmd":
		return "CMD"
	case "":
		return "终端"
	}
	return base
}

// shellArgs 返回启动该 shell 需要的参数。
// PowerShell 去掉 logo 与 profile（横幅会污染首屏、profile 脚本可能很慢）；
// 类 Unix shell 不传参，交互式启动本身就会加载 rc 文件。
func shellArgs(command string) []string {
	switch strings.ToLower(filepath.Base(command)) {
	case "powershell.exe", "powershell":
		return []string{"-NoLogo", "-NoProfile"}
	}
	return []string{}
}

// createPtyHTTP 调用 POST /api/pty 创建上游终端。
func createPtyHTTP(sess *webSession, dir, command, title string) (PtyInfo, error) {
	payload := map[string]any{
		"command": command,
		"args":    shellArgs(command),
		"cwd":     dir,
		"title":   title,
		// 前端按 UTF-8 处理输出，显式声明终端类型让 shell 开启颜色与行编辑。
		"env": map[string]string{"TERM": "xterm-256color"},
	}
	body, _ := json.Marshal(payload)

	data, err := ptyRequest(sess, http.MethodPost, "/api/pty", dir, body)
	if err != nil {
		return PtyInfo{}, err
	}

	var resp struct {
		Data struct {
			ID      string   `json:"id"`
			Title   string   `json:"title"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
			Cwd     string   `json:"cwd"`
			Status  string   `json:"status"`
			PID     int      `json:"pid"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return PtyInfo{}, fmt.Errorf("解析 PTY 创建响应失败: %w", err)
	}
	if resp.Data.ID == "" {
		return PtyInfo{}, fmt.Errorf("PTY 创建失败: %s", strings.TrimSpace(string(data)))
	}
	return PtyInfo{
		ID:      resp.Data.ID,
		Title:   resp.Data.Title,
		Command: resp.Data.Command,
		Cwd:     resp.Data.Cwd,
		PID:     resp.Data.PID,
		Status:  resp.Data.Status,
	}, nil
}

// deletePtyHTTP 调用 DELETE /api/pty/{id} 结束上游终端进程。
func deletePtyHTTP(sess *webSession, id, dir string) error {
	_, err := ptyRequest(sess, http.MethodDelete, "/api/pty/"+url.PathEscape(id), dir, nil)
	return err
}

// connectPtyUpstream 建立到上游 PTY 的 WebSocket 连接，并启动输出读取协程。
func connectPtyUpstream(ps *ptySession, sess *webSession) error {
	host := sess.hostname
	if host == "" {
		host = defaultHostname
	}
	query := url.Values{}
	if ps.dir != "" {
		// 深对象（deepObject）：location[directory]=<目录>
		query.Set("location[directory]", ps.dir)
	}
	wsURL := fmt.Sprintf("ws://%s:%d/api/pty/%s/connect?%s",
		host, sess.port, url.PathEscape(ps.id), query.Encode())

	header := http.Header{}
	// 复用包内的 Basic 认证构造，避免与其它 API 调用出现口径差异。
	if v := basicAuthValue(sess.password); v != "" {
		header.Set("Authorization", v)
	}

	ctx, cancel := context.WithCancel(context.Background())
	// 连接建立本身要有超时，否则服务无响应时会一直挂住前端调用。
	dialCtx, dialCancel := context.WithTimeout(ctx, ptyHTTPTimeout)
	conn, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{HTTPHeader: header})
	dialCancel()
	if err != nil {
		cancel()
		return fmt.Errorf("连接 PTY 失败（请确认 OpenCode 服务版本支持 /api/pty）: %w", err)
	}
	conn.SetReadLimit(ptyMaxReadLimit)

	ps.conn = conn
	ps.cancel = cancel
	go ptyPump(ps)
	return nil
}

// ptyPump 持续读取上游输出，直到连接断开。
//
// 上游帧格式（实测）：
//   - text   帧：终端输出字节（ANSI 序列 + 文本），原样送前端
//   - binary 帧：控制帧，形如 0x00 + {"cursor":N}，仅用于 TUI 光标同步，
//     直接写进 xterm 会输出乱码，因此丢弃
func ptyPump(ps *ptySession) {
	ctx := context.Background()
	for {
		typ, data, err := ps.conn.Read(ctx)
		if err != nil {
			ps.mu.Lock()
			ps.alive = false
			if ps.exitErr == "" && !errors.Is(err, context.Canceled) {
				ps.exitErr = describePtyClose(err)
			}
			ps.mu.Unlock()
			return
		}
		if typ == websocket.MessageBinary {
			continue // 控制帧，不送终端
		}
		if len(data) == 0 {
			continue
		}
		ps.appendOutput(data)
	}
}

// appendOutput 把一段输出放进待取缓冲，并在超过上限时丢弃最旧的块。
func (ps *ptySession) appendOutput(data []byte) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	// 复制一份：上游复用读缓冲区时不能直接持有切片。
	chunk := bytes.Clone(data)
	ps.pending = append(ps.pending, chunk)
	ps.pendingBytes += len(chunk)

	for ps.pendingBytes > ptyMaxPendingBytes && len(ps.pending) > 1 {
		ps.pendingBytes -= len(ps.pending[0])
		ps.pending = ps.pending[1:]
		ps.truncated = true
	}
}

// ptyRequest 统一处理带 Basic 认证与 location 参数的 PTY 控制请求。
func ptyRequest(sess *webSession, method, path, dir string, body []byte) ([]byte, error) {
	base := fmt.Sprintf("http://%s:%d", sess.hostname, sess.port)
	// 深对象参数：location[directory] 必须 URL 编码成 location%5Bdirectory%5D。
	query := url.Values{}
	if dir != "" {
		query.Set("location[directory]", dir)
	}
	target := base + path
	if encoded := query.Encode(); encoded != "" {
		target += "?" + encoded
	}

	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, target, reader)
	if err != nil {
		return nil, err
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	applyAuth(req, sess.password)

	client := &http.Client{Timeout: ptyHTTPTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(data))
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return nil, fmt.Errorf("PTY 请求失败 %s %s: HTTP %d %s", method, path, resp.StatusCode, msg)
	}
	return data, nil
}

// describePtyClose 把 WebSocket 关闭原因转成可读文本。
func describePtyClose(err error) string {
	if status := websocket.CloseStatus(err); status != -1 {
		if status == websocket.StatusNormalClosure {
			return "终端已退出"
		}
		return fmt.Sprintf("终端连接关闭(%d)", status)
	}
	return "终端连接中断: " + err.Error()
}
