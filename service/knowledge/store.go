package knowledge

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

const (
	// timeLayout 条目时间字段格式（与前端契约一致）。
	timeLayout = "2006-01-02 15:04"
	// markdownExt 条目文件扩展名。
	markdownExt = ".md"
	// filePerm 文件权限。
	filePerm = 0o644
	// dirPerm 目录权限。
	dirPerm = 0o755
)

// nowFunc 是包内时间源，测试可替换以获得确定性。
var nowFunc = time.Now

// Store 是知识库的本地文件存储。
type Store struct {
	dir string
}

var (
	defaultOnce  sync.Once
	defaultStore *Store
	defaultErr   error
)

// Default 返回默认知识库存储（懒加载，目录解析失败时返回错误）。
func Default() (*Store, error) {
	defaultOnce.Do(func() {
		defaultStore, defaultErr = NewStore()
	})
	return defaultStore, defaultErr
}

// NewStore 解析真实数据目录并创建存储实例。
func NewStore() (*Store, error) {
	dir, err := VaultDir()
	if err != nil {
		return nil, err
	}
	return NewStoreWithDir(dir), nil
}

// NewStoreWithDir 用指定目录创建存储实例（测试或自定义场景）。
func NewStoreWithDir(dir string) *Store {
	return &Store{dir: dir}
}

// Dir 返回存储根目录。
func (s *Store) Dir() string {
	return s.dir
}

// List 返回所有条目的元数据（不含正文），按更新时间倒序。
func (s *Store) List() ([]model.KnowledgeEntry, error) {
	entries, err := s.readIndex()
	if err != nil {
		return nil, err
	}
	result := make([]model.KnowledgeEntry, 0, len(entries))
	for _, entry := range entries {
		entry.Content = ""
		result = append(result, entry)
	}
	return result, nil
}

// Get 读取单个条目（含正文）。
func (s *Store) Get(id string) (*model.KnowledgeEntry, error) {
	if !validID(id) {
		return nil, fmt.Errorf("非法的知识库条目 ID: %q", id)
	}
	entry, err := s.readEntryFile(id)
	if err != nil {
		return nil, err
	}
	return &entry, nil
}

// Save 新建或更新条目并返回最终 ID。
// ID 为空时生成新 ID；否则沿用该 ID（条目已存在时保留原创建时间）。
// 标题、说明、内容三者均为必填，任一为空（去除首尾空白后）即拒绝且不写入任何文件。
// 说明是用户手填的独立字段，不再从正文自动提取。
func (s *Store) Save(entry model.KnowledgeEntry) (string, error) {
	if strings.TrimSpace(entry.Title) == "" {
		return "", fmt.Errorf("标题不能为空")
	}
	if strings.TrimSpace(entry.Summary) == "" {
		return "", fmt.Errorf("说明不能为空")
	}
	if strings.TrimSpace(entry.Content) == "" {
		return "", fmt.Errorf("内容不能为空")
	}
	if err := s.ensureDir(); err != nil {
		return "", err
	}
	now := nowFunc()
	id, err := s.resolveID(entry.ID, now)
	if err != nil {
		return "", err
	}

	created := now.Format(timeLayout)
	if existing, err := s.readEntryFile(id); err == nil && existing.Created != "" {
		created = existing.Created
	} else if entry.Created != "" {
		created = entry.Created
	}

	saved := model.KnowledgeEntry{
		ID:        id,
		Title:     strings.TrimSpace(entry.Title),
		Category:  entry.Category,
		Tags:      normalizeList(entry.Tags),
		Summary:   strings.TrimSpace(entry.Summary),
		Created:   created,
		Updated:   now.Format(timeLayout),
		Converted: normalizeList(entry.Converted),
		Content:   entry.Content,
	}
	if err := fileutil.AtomicWriteRaw(s.entryFile(id), []byte(RenderMarkdown(saved)), filePerm); err != nil {
		return "", fmt.Errorf("写入知识库条目失败: %w", err)
	}
	if err := s.upsertIndex(saved); err != nil {
		return "", err
	}
	return id, nil
}

// Delete 删除条目文件并从索引中移除；条目不存在时视为已删除（幂等）。
func (s *Store) Delete(id string) error {
	if !validID(id) {
		return fmt.Errorf("非法的知识库条目 ID: %q", id)
	}
	if err := os.Remove(s.entryFile(id)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("删除知识库条目失败: %w", err)
	}
	entries, err := s.readIndex()
	if err != nil {
		return err
	}
	kept := make([]model.KnowledgeEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != id {
			kept = append(kept, entry)
		}
	}
	return s.writeIndex(kept)
}

// ensureDir 确保存储目录存在。
func (s *Store) ensureDir() error {
	if err := os.MkdirAll(s.dir, dirPerm); err != nil {
		return fmt.Errorf("创建知识库目录失败: %w", err)
	}
	return nil
}

// entryFile 返回条目文件路径。
func (s *Store) entryFile(id string) string {
	return filepath.Join(s.dir, id+markdownExt)
}

// readEntryFile 读取并解析条目文件。
func (s *Store) readEntryFile(id string) (model.KnowledgeEntry, error) {
	data, err := os.ReadFile(s.entryFile(id))
	if err != nil {
		if os.IsNotExist(err) {
			return model.KnowledgeEntry{}, fmt.Errorf("知识库条目不存在: %s", id)
		}
		return model.KnowledgeEntry{}, fmt.Errorf("读取知识库条目失败: %w", err)
	}
	entry := ParseMarkdown(string(data))
	entry.ID = id
	// 说明直接取自 frontmatter，是用户手填的独立字段，不从正文推导
	return normalizeEntry(entry), nil
}

// resolveID 返回最终条目 ID：已有 ID 校验后沿用，空 ID 生成新 ID。
func (s *Store) resolveID(id string, now time.Time) (string, error) {
	if id == "" {
		return s.newID(now)
	}
	if !validID(id) {
		return "", fmt.Errorf("非法的知识库条目 ID: %q", id)
	}
	return id, nil
}

// newID 生成形如 kb-20260916-143022-a1b2 的条目 ID，并确保与已有文件不冲突。
func (s *Store) newID(now time.Time) (string, error) {
	prefix := "kb-" + now.Format("20060102-150405") + "-"
	buf := make([]byte, 2)
	for attempt := 0; attempt < 10; attempt++ {
		if _, err := rand.Read(buf); err != nil {
			return "", fmt.Errorf("生成随机后缀失败: %w", err)
		}
		id := prefix + hex.EncodeToString(buf)
		if _, err := os.Stat(s.entryFile(id)); os.IsNotExist(err) {
			return id, nil
		}
	}
	return "", fmt.Errorf("生成知识库条目 ID 失败: 连续多次冲突")
}

// validID 校验条目 ID 能否安全用作文件名，拒绝路径穿越与非法字符。
func validID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	return !strings.ContainsAny(id, `/\:*?"<>|`)
}
