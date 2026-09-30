// Package main OpenCode 服务端版本检查。
//
// 背景：v1 时代 OC Manager 通过 GitHub Releases 的 latest 接口判断 opencode
// 是否有新版本。opencode v2 起发行渠道变了，该接口已不再可靠：
//
//   - https://api.github.com/repos/anomalyco/opencode/releases/latest → v1.18.33
//     （Releases 仍只发布 v1 线，v2 只打 git tag，不发 Release）
//   - npm opencode-ai 的 latest → 1.18.33（该包根本没有 2.x）
//   - npm @opencode/cli 的 latest → 2.0.18  ← v2 实际发布渠道
//
// 若沿用旧实现，v2 用户每次检查都会被告知「发现新版本 v1.18.33」——
// 提示的反而是一个比自己更低的版本。因此这里改为以 @opencode/cli 为准，
// 并保留 GitHub Releases 作为非 npm 安装方式的兜底（且要求主版本号匹配，
// 避免把 v2 用户指向 v1 的 tag）。
package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"oc-manager/model"
)

const (
	// npmLatestURL 是 v2 的权威发布渠道（npm dist-tag latest）。
	npmLatestURL = "https://registry.npmjs.org/@opencode/cli/latest"
	// githubLatestURL 兜底：非 npm 安装（curl 安装脚本 / 独立二进制）时使用。
	githubLatestURL = "https://api.github.com/repos/anomalyco/opencode/releases/latest"
	// versionProbeTimeout 版本探测的网络超时。
	versionProbeTimeout = 8 * time.Second
)

// fetchNpmLatestVersion 读取 @opencode/cli 的 latest 版本。
func fetchNpmLatestVersion(client *http.Client) (string, error) {
	resp, err := client.Get(npmLatestURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &httpStatusError{status: resp.StatusCode}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	var payload struct {
		Version string `json:"version"`
		Name    string `json:"name"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", err
	}
	if payload.Version == "" {
		return "", errEmptyVersion
	}
	return payload.Version, nil
}

// fetchGithubLatestTag 读取 GitHub Releases 的 latest tag（含 "v" 前缀）。
func fetchGithubLatestTag(client *http.Client) (string, error) {
	req, err := http.NewRequest(http.MethodGet, githubLatestURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "oc-manager-version-check")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &httpStatusError{status: resp.StatusCode}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	var release struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &release); err != nil {
		return "", err
	}
	if release.TagName == "" {
		return "", errEmptyVersion
	}
	return release.TagName, nil
}

// checkOpenCodeVersion 查询 opencode 最新版本并与当前版本比较。
// 拆成包级函数以便单元测试（App.CheckOpenCodeVersion 只做转发）。
func checkOpenCodeVersion(currentVersion string) model.VersionCheckResult {
	result := model.VersionCheckResult{CurrentVersion: currentVersion, IsLatest: true}

	current := normalizeVersion(currentVersion)
	if current == "" {
		result.Error = "无法识别的当前版本号: " + currentVersion
		return result
	}

	client := &http.Client{Timeout: versionProbeTimeout}
	latest, err := fetchNpmLatestVersion(client)
	if err != nil {
		// 兜底：GitHub Releases。注意该源可能只含 v1，
		// 故必须校验主版本号与当前一致，否则宁可判定为「无法获取」。
		tag, tagErr := fetchGithubLatestTag(client)
		if tagErr != nil {
			result.Error = "获取最新版本信息失败"
			return result
		}
		tagVersion := normalizeVersion(tag)
		if !sameMajor(current, tagVersion) {
			result.Error = "无法获取与当前版本（" + current + "）对应的最新版本信息"
			return result
		}
		latest = tagVersion
	}

	result.LatestVersion = latest
	result.IsLatest = compareVersions(current, latest) >= 0
	return result
}

// normalizeVersion 归一化版本号：去 "v" 前缀、去空白。
// 预发布后缀（如 0.0.0-dev-202609280537）原样保留，交给 compareVersions 处理。
func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	return strings.TrimSpace(v)
}

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

// sameMajor 判断两个版本号主版本号是否相同。任一为空时返回 false。
func sameMajor(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	an, _ := parseVersion(a)
	bn, _ := parseVersion(b)
	return an[0] == bn[0]
}

// httpStatusError 用状态码表示的探测错误。
type httpStatusError struct{ status int }

func (e *httpStatusError) Error() string {
	return "HTTP " + strconv.Itoa(e.status)
}

// errEmptyVersion 响应里没有版本字段。
var errEmptyVersion = errors.New("响应中缺少版本字段")
