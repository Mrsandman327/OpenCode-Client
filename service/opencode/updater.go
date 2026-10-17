// 本文件实现「OpenCode 自动更新」：后台下载 → 解压 → 就绪 → 一键替换（含回滚）。
//
// 设计要点：
//   - 下载源为官方直链 https://opencode.ai/files/bin/{版本}/{资产}（不经 npm）；
//   - 下载/解压在后台 goroutine 完成，期间不阻塞界面；状态经 GetUpdateStatus 轮询；
//   - 下载支持断点续传（.part 保留已下载字节；服务端按 Range 续传）；
//   - 「就绪待更新」状态持久化到 tools/.update/state.json，应用重启后仍可完成更新；
//   - 应用更新（ApplyUpdate）：停服 → 备份 → 替换 → 校验新二进制 → 重启；
//     任一步失败自动回滚到备份并尽量恢复原服务；
//   - 代理链：应用显式配置 > 环境变量 > 系统代理自动探测（见 internal/sysproxy）> 直连；
//     版本检查（CheckLatestVersion）例外：固定直连，不使用任何代理（与 v1 口径一致）；
//   - 更新对象仅限便携二进制（tools/opencode[.exe]）；系统 PATH 安装不处理。
package opencode

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"oc-manager/internal/executil"
	"oc-manager/internal/sysproxy"
	"oc-manager/model"
)

const (
	// updateBaseURL 官方二进制分发地址（实测：200 OK + 支持 Range）。
	updateBaseURL = "https://opencode.ai/files/bin"
	// updateDirName 更新缓冲目录名（与二进制同级：tools/.update）。
	updateDirName = ".update"
	// updateNewBinName 解压产物的文件名（应用时移动到正式位置）。
	updateNewBinName = "opencode.new"
	// updateStateName 状态持久化文件名。
	updateStateName = "state.json"
	// updateProgressTick 下载进度落内存的节流间隔。
	updateProgressTick = 300 * time.Millisecond
)

// versionRe 版本号字符集白名单（版本直接拼进 URL，必须防路径注入）。
var versionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.\-+]*$`)

// normalizeVersion 归一化版本号：去 "v" 前缀、去空白。
// 预发布后缀（如 0.0.0-dev-202609280537）原样保留，交给 compareVersions 处理。
func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	return strings.TrimSpace(v)
}

// toolsDir 程序目录下的 tools/（与 resolveOpencodeBin 的便携约定一致）。
func toolsDir() string {
	exePath, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exePath), "tools")
}

// updateDir 更新缓冲目录 tools/.update。
func updateDir() string {
	td := toolsDir()
	if td == "" {
		return ""
	}
	return filepath.Join(td, updateDirName)
}

// installedBinaryName 便携二进制文件名（按平台）。
func installedBinaryName() string {
	if runtime.GOOS == "windows" {
		return "opencode.exe"
	}
	return "opencode"
}

// installedBinaryPath 便携二进制完整路径。
func installedBinaryPath() string {
	td := toolsDir()
	if td == "" {
		return ""
	}
	return filepath.Join(td, installedBinaryName())
}

// platformAssetName 当前平台的官方资产文件名。仅支持 win/linux 的 x64。
func platformAssetName() (string, error) {
	switch runtime.GOOS {
	case "windows":
		if runtime.GOARCH == "amd64" {
			return "opencode-windows-x64.zip", nil
		}
	case "linux":
		if runtime.GOARCH == "amd64" {
			return "opencode-linux-x64.tar.gz", nil
		}
	}
	return "", fmt.Errorf("当前平台暂不支持自动更新（%s/%s）", runtime.GOOS, runtime.GOARCH)
}

// ============================
// 任务状态（内存 + 持久化）
// ============================

var updateManager = struct {
	mu     sync.Mutex
	status model.UpdateStatus
	cancel chan struct{} // 非 nil 表示下载在途
	loaded bool          // 是否已从磁盘恢复
}{}

// errUpdateCancelled 用户主动取消下载（不进入失败状态）。
var errUpdateCancelled = errors.New("更新已取消")

// ensureUpdateLoaded 首次调用时从磁盘恢复状态（幂等）。
func ensureUpdateLoaded() {
	updateManager.mu.Lock()
	defer updateManager.mu.Unlock()
	if updateManager.loaded {
		return
	}
	updateManager.loaded = true
	updateManager.status = model.UpdateStatus{Phase: model.UpdatePhaseIdle}

	raw, err := os.ReadFile(filepath.Join(updateDir(), updateStateName))
	if err != nil {
		return
	}
	var saved model.UpdateStatus
	if json.Unmarshal(raw, &saved) != nil {
		return
	}
	switch saved.Phase {
	case model.UpdatePhaseReady:
		// 就绪态：解压产物仍在才恢复（被手动清理则回到 idle）
		if _, err := os.Stat(filepath.Join(updateDir(), updateNewBinName)); err == nil {
			updateManager.status = saved
		}
	case model.UpdatePhaseDownloading, model.UpdatePhasePreparing, model.UpdatePhaseApplying:
		// 进程中断：转为可重试状态；已下载字节以 .part 实际大小为准（支持续传）
		if asset, aerr := platformAssetName(); aerr == nil {
			if fi, ferr := os.Stat(filepath.Join(updateDir(), asset+".part")); ferr == nil {
				saved.Downloaded = fi.Size()
			}
		}
		updateManager.status = model.UpdateStatus{
			Phase:      model.UpdatePhaseFailed,
			Version:    saved.Version,
			Downloaded: saved.Downloaded,
			Total:      saved.Total,
			Error:      "上次下载未完成，可重试继续",
		}
	case model.UpdatePhaseFailed:
		updateManager.status = saved
	}
}

// persistUpdateStateLocked 状态落盘（持锁调用；失败静默——持久化是增强非硬需求）。
func persistUpdateStateLocked() {
	dir := updateDir()
	if dir == "" {
		return
	}
	raw, err := json.Marshal(updateManager.status)
	if err != nil {
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, updateStateName), raw, 0o644)
}

// GetUpdateStatus 返回当前更新任务状态（首次调用时从磁盘恢复）。
func GetUpdateStatus() model.UpdateStatus {
	ensureUpdateLoaded()
	updateManager.mu.Lock()
	defer updateManager.mu.Unlock()
	return updateManager.status
}

// StartUpdate 启动后台下载（不阻塞）；已有任务或已就绪时返回当前状态。
func StartUpdate(version string, proxy model.ProxyConfig) model.UpdateStatus {
	version = normalizeVersion(version)
	ensureUpdateLoaded()
	updateManager.mu.Lock()
	defer updateManager.mu.Unlock()

	if updateManager.cancel != nil {
		return updateManager.status // 已有下载在途
	}
	if updateManager.status.Phase == model.UpdatePhaseReady && updateManager.status.Version == version {
		return updateManager.status // 已就绪
	}
	if version == "" || !versionRe.MatchString(version) {
		return setFailedLocked(version, "非法的版本号")
	}
	if _, err := os.Stat(installedBinaryPath()); err != nil {
		return setFailedLocked(version, "未找到便携版 "+installedBinaryName()+"（tools 目录），请手动更新")
	}
	asset, err := platformAssetName()
	if err != nil {
		return setFailedLocked(version, err.Error())
	}
	if err := os.MkdirAll(updateDir(), 0o755); err != nil {
		return setFailedLocked(version, "创建更新目录失败: "+err.Error())
	}

	updateManager.status = model.UpdateStatus{Phase: model.UpdatePhaseDownloading, Version: version}
	cancel := make(chan struct{})
	updateManager.cancel = cancel
	persistUpdateStateLocked()
	go runUpdateTask(version, asset, proxy, cancel)
	return updateManager.status
}

// setFailedLocked 置为失败状态并落盘（持锁调用）。
func setFailedLocked(version, msg string) model.UpdateStatus {
	updateManager.status = model.UpdateStatus{Phase: model.UpdatePhaseFailed, Version: version, Error: msg}
	persistUpdateStateLocked()
	return updateManager.status
}

// CancelUpdate 取消后台下载/就绪任务（保留 .part 以便重试续传）。
func CancelUpdate() model.UpdateStatus {
	ensureUpdateLoaded()
	updateManager.mu.Lock()
	defer updateManager.mu.Unlock()
	if updateManager.cancel != nil {
		close(updateManager.cancel)
		updateManager.cancel = nil
	}
	updateManager.status = model.UpdateStatus{Phase: model.UpdatePhaseIdle}
	persistUpdateStateLocked()
	return updateManager.status
}

// runUpdateTask 后台任务：下载 → 解压 → 标记就绪。
func runUpdateTask(version, asset string, proxy model.ProxyConfig, cancel chan struct{}) {
	archivePath := filepath.Join(updateDir(), asset)
	if err := downloadArchive(version, asset, archivePath, proxy, cancel); err != nil {
		finishUpdateError(version, cancel, err)
		return
	}

	updateManager.mu.Lock()
	updateManager.status.Phase = model.UpdatePhasePreparing
	updateManager.status.Error = ""
	persistUpdateStateLocked()
	updateManager.mu.Unlock()

	newBin := filepath.Join(updateDir(), updateNewBinName)
	if err := extractBinary(archivePath, newBin); err != nil {
		finishUpdateError(version, cancel, fmt.Errorf("解压失败: %w", err))
		return
	}

	updateManager.mu.Lock()
	defer updateManager.mu.Unlock()
	select {
	case <-cancel:
		return // 已被取消：不覆盖
	default:
	}
	updateManager.status = model.UpdateStatus{
		Phase:      model.UpdatePhaseReady,
		Version:    version,
		Downloaded: updateManager.status.Downloaded,
		Total:      updateManager.status.Total,
	}
	updateManager.cancel = nil
	persistUpdateStateLocked()
}

// finishUpdateError 记录失败（取消导致的结束不写失败态）。
func finishUpdateError(version string, cancel chan struct{}, err error) {
	updateManager.mu.Lock()
	defer updateManager.mu.Unlock()
	select {
	case <-cancel:
		return // 已取消
	default:
	}
	status := model.UpdateStatus{Phase: model.UpdatePhaseFailed, Version: version, Error: err.Error()}
	if errors.Is(err, errUpdateCancelled) {
		status.Error = "下载已取消"
	}
	updateManager.status = status
	updateManager.cancel = nil
	persistUpdateStateLocked()
}

// setDownloadProgress 更新下载进度（仅 downloading 阶段生效）。
func setDownloadProgress(downloaded, total int64) {
	updateManager.mu.Lock()
	defer updateManager.mu.Unlock()
	if updateManager.status.Phase != model.UpdatePhaseDownloading {
		return
	}
	updateManager.status.Downloaded = downloaded
	updateManager.status.Total = total
}

// ============================
// 版本检查
// ============================

// CheckLatestVersion 查询 opencode 最新版本（v2 渠道：npm @opencode/cli）。
//
// 版本检查固定直连：不使用任何代理（不读 HTTP_PROXY/HTTPS_PROXY 环境变量，
// 也不探测系统代理）。与 v1 口径一致——代理仅用于「下载更新」
// （见 newUpdateHTTPClient 与 internal/sysproxy）。
func CheckLatestVersion(currentVersion string) model.VersionCheckResult {
	result := model.VersionCheckResult{CurrentVersion: currentVersion, IsLatest: true}

	current := normalizeVersion(currentVersion)
	if current == "" {
		result.Error = "无法识别的当前版本号: " + currentVersion
		return result
	}

	// 复制默认 Transport 并清空 Proxy：保留默认超时/连接池，但不使用任何代理
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	client := &http.Client{Transport: transport}

	resp, err := client.Get("https://registry.npmjs.org/@opencode/cli/latest")
	if err != nil {
		result.Error = "获取最新版本信息失败"
		return result
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		result.Error = "获取最新版本信息失败"
		return result
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		result.Error = "读取版本信息失败"
		return result
	}
	var payload struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Version == "" {
		result.Error = "解析版本信息失败"
		return result
	}

	latest := normalizeVersion(payload.Version)
	result.LatestVersion = payload.Version
	// 语义化比较：预发布版本低于同号正式版（如 2.0.0-beta < 2.0.0）
	result.IsLatest = compareVersions(current, latest) >= 0
	return result
}

// ============================
// 版本工具（保留自原 app_version.go）
// ============================

// parseVersion 解析 "1.2.3-beta.4" → ([1,2,3], "beta.4")。
// 内部先做 normalizeVersion，故 "v2.0.15" 也能正确解析。
// 缺失的段按 0 处理；非数字段（如 "2.0.18-rc1" 里的 "rc1"）截断解析。
func parseVersion(v string) ([3]int, string) {
	v = normalizeVersion(v)
	var nums [3]int
	rest := v
	if i := strings.IndexAny(rest, "-+"); i >= 0 {
		rest = rest[:i]
	}
	parts := strings.Split(rest, ".")
	for i := 0; i < 3 && i < len(parts); i++ {
		n, err := strconv.Atoi(strings.TrimSpace(parts[i]))
		if err != nil {
			break
		}
		nums[i] = n
	}
	pre := ""
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		pre = v[i+1:]
	}
	return nums, pre
}

// compareVersions 按语义化版本比较：a<b 返回 -1，a==b 返回 0，a>b 返回 1。
// 预发布版本小于同号正式版本（2.0.0-beta < 2.0.0）。
func compareVersions(a, b string) int {
	an, ap := parseVersion(a)
	bn, bp := parseVersion(b)
	for i := 0; i < 3; i++ {
		if an[i] != bn[i] {
			if an[i] < bn[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case ap == bp:
		return 0
	case ap == "":
		return 1 // a 是正式版，b 是预发布版 → a 更新
	case bp == "":
		return -1
	case ap < bp:
		return -1
	default:
		return 1
	}
}

// ============================
// 下载
// ============================

// newUpdateHTTPClient 构造下载客户端：按代理配置走代理、无总超时（大文件）、
// 重定向仅允许官方域。
//
// 代理优先级：应用内显式配置（ProxyEnabled）> 环境变量（HTTP_PROXY/HTTPS_PROXY）
// > 系统代理（自动探测，见 detectSystemProxyURL）> 直连。
func newUpdateHTTPClient(proxy model.ProxyConfig) *http.Client {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout: 15 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	if proxy.ProxyEnabled {
		host := strings.TrimSpace(proxy.ProxyHost)
		if host == "" {
			host = "127.0.0.1"
		}
		port := strings.TrimSpace(proxy.ProxyPort)
		if port == "" {
			port = "7897"
		}
		if u, err := url.Parse("http://" + host + ":" + port); err == nil {
			transport.Proxy = http.ProxyURL(u)
		}
	} else {
		// 未显式启用代理：环境变量优先，其次系统代理（Clash 等「系统代理」模式），最后直连。
		transport.Proxy = sysproxy.ProxyFunc()
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			h := strings.ToLower(req.URL.Hostname())
			// 允许的重定向目标域：
			//   - opencode.ai / *.opencode.ai：本项目的下载源（v2 分发直链）
			//   - github.com / *.github.com 及 *.githubusercontent.com：兼容 v1 渠道
			//     （Releases 下载会 302 到 release-assets.githubusercontent.com）
			// 其余一律拒绝，防止被恶意重定向。
			allowed := func(host string) bool {
				if host == "opencode.ai" || strings.HasSuffix(host, ".opencode.ai") {
					return true
				}
				if host == "github.com" || strings.HasSuffix(host, ".github.com") {
					return true
				}
				if host == "githubusercontent.com" || strings.HasSuffix(host, ".githubusercontent.com") {
					return true
				}
				return false
			}
			if !allowed(h) {
				return fmt.Errorf("下载被重定向到非官方域: %s", req.URL.Host)
			}
			if len(via) >= 5 {
				return errors.New("下载重定向次数过多")
			}
			return nil
		},
	}
}

// downloadArchive 下载资产到 dest（中间写 dest+".part"，支持断点续传）。
func downloadArchive(version, asset, dest string, proxy model.ProxyConfig, cancel chan struct{}) error {
	part := dest + ".part"
	var offset int64
	if fi, err := os.Stat(part); err == nil {
		offset = fi.Size()
		if offset == 0 {
			_ = os.Remove(part)
		}
	}

	urlStr := fmt.Sprintf("%s/%s/%s", updateBaseURL, version, asset)
	client := newUpdateHTTPClient(proxy)
	req, err := http.NewRequest(http.MethodGet, urlStr, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "oc-manager-updater")
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("连接下载服务器失败: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		if offset > 0 {
			offset = 0 // 服务端不支持续传：从头开始
			_ = os.Remove(part)
		}
	case http.StatusPartialContent:
		// 续传成功，沿用 offset
	case http.StatusNotFound:
		return fmt.Errorf("版本 %s 在分发服务器上不存在（HTTP 404）", version)
	default:
		return fmt.Errorf("下载失败（HTTP %d）", resp.StatusCode)
	}

	total := int64(0)
	if resp.ContentLength >= 0 {
		total = offset + resp.ContentLength
	}
	setDownloadProgress(offset, total)

	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	written := offset
	lastTick := time.Now()
	buf := make([]byte, 256*1024)
	for {
		select {
		case <-cancel:
			_ = f.Close()
			return errUpdateCancelled
		default:
		}
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				_ = f.Close()
				return werr
			}
			written += int64(n)
			if time.Since(lastTick) >= updateProgressTick {
				setDownloadProgress(written, total)
				lastTick = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			_ = f.Close()
			return fmt.Errorf("下载中断: %w", rerr)
		}
	}
	setDownloadProgress(written, total)
	if total > 0 && written != total {
		_ = f.Close()
		return fmt.Errorf("下载不完整：%d/%d 字节", written, total)
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(part, dest)
}

// ============================
// 解压
// ============================

// extractBinary 从归档提取 opencode 二进制到 dest（0755）。
// 只按已知文件名提取（不信任归档内路径，天然防目录穿越）。
func extractBinary(archivePath, dest string) error {
	if strings.HasSuffix(strings.ToLower(archivePath), ".zip") {
		return extractFromZip(archivePath, dest)
	}
	return extractFromTarGz(archivePath, dest)
}

// isBinaryEntry 归档条目是否是目标二进制（按 basename 匹配）。
func isBinaryEntry(name string) bool {
	base := strings.ToLower(filepath.Base(name))
	return base == "opencode.exe" || base == "opencode"
}

// writeBinaryFile 写目标文件（权限 0755；Windows 上 chmod 无实际作用但无害）。
func writeBinaryFile(dest string, r io.Reader) error {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, r); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Chmod(dest, 0o755)
	return nil
}

// extractFromZip 从 zip 提取二进制（包内布局实测：根目录单个 opencode.exe）。
func extractFromZip(archivePath, dest string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !isBinaryEntry(f.Name) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		err = writeBinaryFile(dest, rc)
		_ = rc.Close()
		return err
	}
	return errors.New("归档中未找到 opencode 二进制")
}

// extractFromTarGz 从 tar.gz 提取二进制（包内布局：根目录单个 opencode）。
func extractFromTarGz(archivePath, dest string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg || !isBinaryEntry(hdr.Name) {
			continue
		}
		return writeBinaryFile(dest, tr)
	}
	return errors.New("归档中未找到 opencode 二进制")
}

// ============================
// 应用更新（停服 → 备份 → 替换 → 校验 → 重启；失败自动回滚）
// ============================

// ApplyUpdate 完成更新。hostname/port/password/proxy 用于更新后重启服务
// （与 StartOpenCodeWeb 同参；在服务原本运行的前提下）。
func ApplyUpdate(hostname string, port int, password string, proxy model.ProxyConfig) model.UpdateStatus {
	ensureUpdateLoaded()
	updateManager.mu.Lock()
	if updateManager.status.Phase != model.UpdatePhaseReady {
		st := updateManager.status
		updateManager.mu.Unlock()
		return st
	}
	version := updateManager.status.Version
	updateManager.status.Phase = model.UpdatePhaseApplying
	persistUpdateStateLocked()
	updateManager.mu.Unlock()

	finish := func(st model.UpdateStatus) model.UpdateStatus {
		updateManager.mu.Lock()
		updateManager.status = st
		persistUpdateStateLocked()
		updateManager.mu.Unlock()
		return st
	}
	applyFailed := func(msg string, rolledBack bool) model.UpdateStatus {
		return finish(model.UpdateStatus{Phase: model.UpdatePhaseFailed, Version: version, Error: msg, RolledBack: rolledBack})
	}

	newBin := filepath.Join(updateDir(), updateNewBinName)
	binPath := installedBinaryPath()
	if _, err := os.Stat(newBin); err != nil {
		return applyFailed("就绪的更新文件已丢失，请重新下载", false)
	}

	// 1) 检查 / 停止服务
	wasRunning := false
	if running, desc := findRunningOpencodeService(); running {
		WebSessMu.Lock()
		ownedByUs := WebSess != nil
		WebSessMu.Unlock()
		if !ownedByUs {
			return applyFailed("检测到外部启动的 OpenCode 服务（"+desc+"），请先关闭后再完成更新", false)
		}
		if res := StopOpenCodeWeb(); res.Error != "" {
			return applyFailed("停止服务失败: "+res.Error, false)
		}
		wasRunning = true
	}

	restart := func() {
		if wasRunning {
			_ = StartOpenCodeWeb(port, hostname, password, proxy)
		}
	}

	// 2) 备份 + 替换
	bak := binPath + ".bak"
	_ = os.Remove(bak)
	if err := os.Rename(binPath, bak); err != nil {
		restart()
		return applyFailed("备份旧版本失败: "+err.Error(), false)
	}
	if err := os.Rename(newBin, binPath); err != nil {
		_ = os.Rename(bak, binPath) // 回滚
		restart()
		return applyFailed("替换二进制失败: "+err.Error(), true)
	}
	_ = os.Chmod(binPath, 0o755)

	// 3) 校验新二进制版本
	ver, verr := probeBinaryVersion(binPath)
	if verr != nil || normalizeVersion(ver) != version {
		_ = os.Remove(binPath)
		_ = os.Rename(bak, binPath)
		restart()
		msg := "新版本校验失败，已回滚到旧版本"
		if verr != nil {
			msg += "（" + verr.Error() + "）"
		} else {
			msg += "（期望 " + version + "，实际 " + normalizeVersion(ver) + "）"
		}
		return applyFailed(msg, true)
	}

	// 4) 重启服务
	if wasRunning {
		if res := StartOpenCodeWeb(port, hostname, password, proxy); res.Error != "" {
			// 新版本启动失败：回滚并恢复旧版本服务
			_ = os.Remove(binPath)
			_ = os.Rename(bak, binPath)
			if rres := StartOpenCodeWeb(port, hostname, password, proxy); rres.Error != "" {
				return applyFailed("新版本启动失败，已回滚但旧版本服务启动异常: "+rres.Error, true)
			}
			return applyFailed("新版本启动失败，已回滚: "+res.Error, true)
		}
	}

	// 5) 成功：清理状态与临时文件（保留 .bak 供手动回退）
	_ = os.Remove(filepath.Join(updateDir(), updateStateName))
	return finish(model.UpdateStatus{Phase: model.UpdatePhaseDone, Version: version})
}

// probeBinaryVersion 执行 `opencode --version` 并解析版本号（输出形如 "opencode v2.0.30"）。
func probeBinaryVersion(binPath string) (string, error) {
	cmd := exec.Command(binPath, "--version")
	executil.SetHideWindow(cmd, true)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) == 0 {
		return "", errors.New("无法解析版本输出")
	}
	return fields[len(fields)-1], nil
}
