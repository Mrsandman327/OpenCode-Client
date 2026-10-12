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
	"strings"
	"sync"
	"sync/atomic"
	"time"

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
	exePath, err := os.Executable()
	if err != nil {
		return cfg
	}
	configPath := filepath.Join(filepath.Dir(exePath), "configs", "file-types", "search-exclude.json")
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

// scanFileForMatches 扫描单个文件，返回命中行（含行号）；第二个返回值表示该文件是否达到上限。
// 二进制文件（前 8KB 含 \0）返回 nil。
func scanFileForMatches(absPath string, pattern *regexp.Regexp, maxMatches int) ([]model.FileSearchLineMatch, bool) {
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
		if pattern.Match(line) {
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

	// 1) 编译匹配器（字面量模式先 QuoteMeta 转义；全词模式用 \b 包裹）
	src := query
	if !useRegex {
		src = regexp.QuoteMeta(query)
	}
	if wholeWord {
		src = `\b(?:` + src + `)\b`
	}
	if !caseSensitive {
		src = "(?i)" + src
	}
	pattern, err := regexp.Compile(src)
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
		if atomic.LoadInt32(&truncated) == 1 {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(absPath string) {
			defer wg.Done()
			defer func() { <-sem }()
			if atomic.LoadInt32(&truncated) == 1 {
				return
			}
			matches, _ := scanFileForMatches(absPath, pattern, cfg.MaxFileMatches)
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

	// 5) 汇总（相对路径排序，稳定输出）
	if files == nil {
		files = []model.FileSearchFileResult{}
	}
	result.Files = files
	result.FileCount = len(files)
	result.MatchCount = matchCnt
	result.ScannedFiles = scanned
	result.Truncated = atomic.LoadInt32(&truncated) == 1
	result.ElapsedMs = time.Since(start).Milliseconds()
	return result, nil
}
