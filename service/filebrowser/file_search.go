package filebrowser

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"oc-manager/internal/portable"
	"oc-manager/model"
)

// ============================================================
// 文件内容搜索（类 VSCode 全局搜索）
// 设计要点（性能）：
//   1) 跳过策略优先：目录排除 / 类型排除（引用 file-preview-types.json 的类型名）/
//      glob 排除 / 大文件上限 / 二进制检测（前 8KB 含 \0）；
//   2) Walk 单遍收集候选，worker pool 并行扫描（NumCPU）；
//   3) 结果上限（单文件匹配数 / 命中文件数）防爆炸，超限返回 truncated 标记。
// 排除规则配置文件：<exe目录>/configs/file-types/search-exclude.json（每次搜索读取，改完即生效；
// 缺失/解析失败回退内置默认）。
// ============================================================

// FileSearchConfig 表示内容搜索的排除规则配置。
// 全部规则以配置文件为准，代码不提供内置默认：
//   <exe目录>/configs/file-types/search-exclude.json
// 文件缺失或解析失败时按"零值"执行：不排除任何目录/类型/glob；上限字段 0 表示不限制。
type FileSearchConfig struct {
	ExcludeDirs      []string `json:"excludeDirs"`
	ExcludeTypeNames []string `json:"excludeTypeNames"`
	ExcludeFileGlobs []string `json:"excludeFileGlobs"`
	MaxFileSizeKB    int      `json:"maxFileSizeKB"`
	MaxFileMatches   int      `json:"maxFileMatches"`
	MaxFiles         int      `json:"maxFiles"`
}

// loadFileSearchConfig 从配置文件读取搜索排除规则（每次搜索读取，改完立即生效）。
// 不提供内置默认值：一切以配置文件为准；文件缺失/解析失败时返回零值配置。
func loadFileSearchConfig() FileSearchConfig {
	var cfg FileSearchConfig
	exeDir := portable.ExeDir()
	if exeDir == "" {
		return cfg
	}
	configPath := filepath.Join(exeDir, "configs", "file-types", "search-exclude.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg
}

// buildExcludeExtSet 把 excludeTypeNames 映射为扩展名集合（引用 file-preview-types.json 的类型定义）。
func buildExcludeExtSet(typeNames []string) map[string]bool {
	excludeType := make(map[string]bool, len(typeNames))
	for _, n := range typeNames {
		excludeType[strings.ToLower(strings.TrimSpace(n))] = true
	}
	out := make(map[string]bool)
	for ext, item := range loadFilePreviewConfig() {
		if excludeType[strings.ToLower(item.Name)] {
			out[strings.ToLower(ext)] = true
		}
	}
	return out
}

// matchAnyGlob 大小写不敏感地按 glob 匹配文件名（Windows 文件系统语义）。
func matchAnyGlob(globs []string, name string) bool {
	lower := strings.ToLower(name)
	for _, g := range globs {
		if ok, _ := path.Match(strings.ToLower(strings.TrimSpace(g)), lower); ok {
			return true
		}
	}
	return false
}

// ============================================================
// 匹配器：把查询编译成「正则」或「字面量」两条路径。
// 纯 ASCII 且忽略大小写时，用「整文件小写化 + bytes.Index」，
// 避免对每一行都跑一次正则（大多数文件根本不含查询）。
// ============================================================

type searchMatcher struct {
	re      *regexp.Regexp
	literal []byte // 大小写敏感的字面量
	folded  []byte // 小写化后的字面量（忽略大小写）
}

// newSearchMatcher 按查询与选项选择匹配策略。
// 正则或全词模式必须走 regexp（\b 与跨字符语义无法用 bytes 近似）；
// 其余情况尽量走字面量路径。
func newSearchMatcher(query string, caseSensitive, useRegex, wholeWord bool) (*searchMatcher, error) {
	if useRegex || wholeWord {
		src := query
		if !useRegex {
			src = regexp.QuoteMeta(src)
		}
		if wholeWord {
			src = `\b(?:` + src + `)\b`
		}
		if !caseSensitive {
			src = "(?i)" + src
		}
		re, err := regexp.Compile(src)
		if err != nil {
			return nil, err
		}
		return &searchMatcher{re: re}, nil
	}
	if caseSensitive {
		return &searchMatcher{literal: []byte(query)}, nil
	}
	// 忽略大小写：只有纯 ASCII 查询能安全折叠；
	// 含非 ASCII 时回退正则，因为 Unicode 的 (?i) 折叠规则不止 A-Z。
	for i := 0; i < len(query); i++ {
		if query[i] >= utf8.RuneSelf {
			re, err := regexp.Compile("(?i)" + regexp.QuoteMeta(query))
			if err != nil {
				return nil, err
			}
			return &searchMatcher{re: re}, nil
		}
	}
	return &searchMatcher{folded: []byte(strings.ToLower(query))}, nil
}

// foldBufPool 复用「小写化后的整文件内容」缓冲区，避免每个文件都分配一份等长内存。
var foldBufPool = sync.Pool{New: func() any {
	b := make([]byte, 0, 64<<10)
	return &b
}}

// foldInto 把小写化结果写入 dst（只处理 ASCII A-Z），返回结果切片。
func foldInto(dst, src []byte) []byte {
	if cap(dst) < len(src) {
		dst = make([]byte, len(src))
	} else {
		dst = dst[:len(src)]
	}
	for i, b := range src {
		if 'A' <= b && b <= 'Z' {
			b += 'a' - 'A'
		}
		dst[i] = b
	}
	return dst
}

// scan 在文件内容里查找匹配。
// 先用一次整文件判断做预筛：没有命中就直接返回，不进入逐行定位。
func (m *searchMatcher) scan(data []byte, maxMatches int) ([]model.FileSearchLineMatch, bool) {
	if m.folded != nil {
		bp := foldBufPool.Get().(*[]byte)
		defer foldBufPool.Put(bp)
		lower := foldInto((*bp)[:0], data)
		*bp = lower
		if !bytes.Contains(lower, m.folded) {
			return nil, false
		}
		return scanLiteral(data, lower, m.folded, maxMatches)
	}
	if m.literal != nil {
		if !bytes.Contains(data, m.literal) {
			return nil, false
		}
		return scanLiteral(data, data, m.literal, maxMatches)
	}
	if !m.re.Match(data) {
		return nil, false
	}
	return scanRegexLines(data, m.re, maxMatches)
}

// scanLiteral 用 bytes.Index 定位匹配，再回溯到行边界取整行文本。
// original 与 haystack 等长：folded 模式下 haystack 是小写化文本，用它定位，
// 行文本仍从 original 取，保证展示的是原文。
// 同一行有多个匹配时只输出一次（与原有逐行行为一致）。
func scanLiteral(original, haystack, needle []byte, maxMatches int) ([]model.FileSearchLineMatch, bool) {
	if len(needle) == 0 {
		return nil, false
	}
	var out []model.FileSearchLineMatch
	lineNo, lineStart, at := 1, 0, 0
	lastLine := -1
	for {
		i := bytes.Index(haystack[at:], needle)
		if i < 0 {
			break
		}
		pos := at + i
		// 把行号与行首推进到匹配所在行
		for {
			nl := bytes.IndexByte(original[lineStart:pos], '\n')
			if nl < 0 {
				break
			}
			lineNo++
			lineStart += nl + 1
		}
		if lineNo != lastLine {
			lineEnd := len(original)
			if e := bytes.IndexByte(original[pos:], '\n'); e >= 0 {
				lineEnd = pos + e
			}
			line := original[lineStart:lineEnd]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			text := string(line)
			if len(text) > 500 {
				text = text[:500] + "…"
			}
			out = append(out, model.FileSearchLineMatch{Line: lineNo, Text: text})
			lastLine = lineNo
			if maxMatches > 0 && len(out) >= maxMatches {
				return out, true
			}
		}
		at = pos + len(needle)
	}
	return out, false
}

// scanRegexLines 逐行跑正则。仅用于正则/全词模式，
// 这类查询无法用字面量定位（\b、分组、跨字符语义）。
func scanRegexLines(data []byte, re *regexp.Regexp, maxMatches int) ([]model.FileSearchLineMatch, bool) {
	var out []model.FileSearchLineMatch
	lineNo := 0
	rest := data
	for len(rest) > 0 {
		lineNo++
		idx := bytes.IndexByte(rest, '\n')
		var line []byte
		if idx < 0 {
			line = rest
			rest = nil
		} else {
			line = rest[:idx]
			rest = rest[idx+1:]
		}
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if re.Match(line) {
			text := string(line)
			if len(text) > 500 {
				text = text[:500] + "…"
			}
			out = append(out, model.FileSearchLineMatch{Line: lineNo, Text: text})
			if maxMatches > 0 && len(out) >= maxMatches {
				return out, true
			}
		}
	}
	return out, false
}

// activeSearchCancel 指向当前搜索的取消标志。
// Wails 调用是并发的：连续输入会叠加多个扫描，新搜索开始时应让旧的尽快退出。
var activeSearchCancel atomic.Pointer[atomic.Bool]

// beginSearch 为本次搜索创建取消标志，并取消上一次未完成的搜索。
func beginSearch() *atomic.Bool {
	cancel := &atomic.Bool{}
	if prev := activeSearchCancel.Swap(cancel); prev != nil {
		prev.Store(true)
	}
	return cancel
}

// scanFileForMatches 扫描单个文件，返回命中行（含行号）；第二个返回值表示该文件是否达到上限。
// 二进制文件（前 8KB 含 \0）返回 nil。
func scanFileForMatches(absPath string, matcher *searchMatcher, maxMatches int) ([]model.FileSearchLineMatch, bool) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, false
	}
	probe := data
	if len(probe) > 8192 {
		probe = probe[:8192]
	}
	if bytes.IndexByte(probe, 0) >= 0 {
		return nil, false // 二进制文件跳过
	}
	return matcher.scan(data, maxMatches)
}

// SearchBrowserFiles 在指定目录内做内容搜索。
// query 为空时返回空结果；useRegex=true 时按正则解释 query。
func SearchBrowserFiles(rootDir, relPath, query string, caseSensitive, useRegex, wholeWord bool) (model.FileBrowserSearchResult, error) {
	start := time.Now()
	result := model.FileBrowserSearchResult{Query: query}
	query = strings.TrimSpace(query)
	if query == "" {
		return result, nil
	}
	absDir, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return result, err
	}
	result.RootDir = rootAbs

	cfg := loadFileSearchConfig()

	// 本次搜索的取消标志：新搜索开始时会取消上一次未完成的扫描，
	// 避免连续输入时多个全量扫描同时占用 CPU。
	cancel := beginSearch()

	// 1) 编译匹配器（字面量模式先 QuoteMeta 转义；全词模式用 \b 包裹）
	matcher, err := newSearchMatcher(query, caseSensitive, useRegex, wholeWord)
	if err != nil {
		return result, fmt.Errorf("正则表达式无效: %w", err)
	}

	// 2) 排除规则准备
	excludeDirSet := make(map[string]bool, len(cfg.ExcludeDirs))
	for _, d := range cfg.ExcludeDirs {
		excludeDirSet[strings.ToLower(strings.TrimSpace(d))] = true
	}
	excludeExtSet := buildExcludeExtSet(cfg.ExcludeTypeNames)

	// 3) Walk 单遍收集候选文件（应用目录/类型/glob/大小过滤）
	var candidates []string
	collectLimit := 100000 // 候选收集防呆上限（正常项目远达不到；仅防异常目录拖死）
	if cfg.MaxFiles > 0 {
		collectLimit = cfg.MaxFiles * 40
	}
	_ = filepath.WalkDir(absDir, func(p string, d fs.DirEntry, err error) error {
		if cancel.Load() {
			return fs.SkipAll // 已被新搜索取代，尽快退出
		}
		if err != nil {
			return nil // 单点错误忽略（权限等），不中断整体搜索
		}
		if d.IsDir() {
			if p != absDir && excludeDirSet[strings.ToLower(d.Name())] {
				return filepath.SkipDir
			}
			return nil
		}
		if len(candidates) >= collectLimit {
			return fs.SkipAll
		}
		name := d.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext != "" && excludeExtSet[ext] {
			result.SkippedFiles++
			return nil
		}
		if matchAnyGlob(cfg.ExcludeFileGlobs, name) {
			result.SkippedFiles++
			return nil
		}
		if cfg.MaxFileSizeKB > 0 {
			if info, e := d.Info(); e == nil && info.Size() > int64(cfg.MaxFileSizeKB)*1024 {
				result.SkippedFiles++
				return nil
			}
		}
		candidates = append(candidates, p)
		return nil
	})

	// 4) worker pool 并行扫描
	var (
		mu        sync.Mutex
		files     []model.FileSearchFileResult
		matchCnt  int
		scanned   int
		truncated int32
		wg        sync.WaitGroup
	)
	sem := make(chan struct{}, runtime.NumCPU())
	for _, p := range candidates {
		if atomic.LoadInt32(&truncated) == 1 || cancel.Load() {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(absPath string) {
			defer wg.Done()
			defer func() { <-sem }()
			if atomic.LoadInt32(&truncated) == 1 || cancel.Load() {
				return
			}
			matches, _ := scanFileForMatches(absPath, matcher, cfg.MaxFileMatches)
			mu.Lock()
			scanned++
			if len(matches) > 0 {
				rel := absPath
				if r, e := filepath.Rel(rootAbs, absPath); e == nil {
					rel = "/" + filepath.ToSlash(r)
				}
				files = append(files, model.FileSearchFileResult{Path: absPath, RelPath: rel, Matches: matches})
				matchCnt += len(matches)
				if cfg.MaxFiles > 0 && len(files) >= cfg.MaxFiles {
					atomic.StoreInt32(&truncated, 1)
				}
			}
			mu.Unlock()
		}(p)
	}
	wg.Wait()

	// 5) 汇总：按相对路径排序，保证同样输入的结果顺序稳定
	//（files 是并发 append 的，不排序顺序会随 goroutine 完成顺序抖动）
	if files == nil {
		files = []model.FileSearchFileResult{}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].RelPath < files[j].RelPath })
	result.Files = files
	result.FileCount = len(files)
	result.MatchCount = matchCnt
	result.ScannedFiles = scanned
	result.Truncated = atomic.LoadInt32(&truncated) == 1
	result.ElapsedMs = time.Since(start).Milliseconds()
	return result, nil
}
