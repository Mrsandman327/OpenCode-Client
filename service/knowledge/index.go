package knowledge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

// indexFileName 元数据索引文件名。
const indexFileName = "index.json"

// indexFile 返回索引文件路径。
func (s *Store) indexFile() string {
	return filepath.Join(s.dir, indexFileName)
}

// readIndex 读取索引；文件缺失或损坏时扫描 *.md 重建并落盘（自愈）。
func (s *Store) readIndex() ([]model.KnowledgeEntry, error) {
	if data, err := os.ReadFile(s.indexFile()); err == nil {
		var entries []model.KnowledgeEntry
		if err := json.Unmarshal(data, &entries); err == nil {
			return normalizeEntries(entries), nil
		}
	}
	return s.rebuildIndex()
}

// rebuildIndex 扫描目录下所有条目文件重建索引并落盘。
func (s *Store) rebuildIndex() ([]model.KnowledgeEntry, error) {
	if err := s.ensureDir(); err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(s.dir, "*"+markdownExt))
	if err != nil {
		return nil, fmt.Errorf("扫描知识库目录失败: %w", err)
	}
	entries := make([]model.KnowledgeEntry, 0, len(files))
	for _, file := range files {
		id := strings.TrimSuffix(filepath.Base(file), markdownExt)
		entry, err := s.readEntryFile(id)
		if err != nil {
			// 单个文件损坏不阻断整体列表，跳过继续重建
			continue
		}
		entry.Content = ""
		entries = append(entries, entry)
	}
	sortEntries(entries)
	if err := s.writeIndex(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// writeIndex 原子写入索引文件。
func (s *Store) writeIndex(entries []model.KnowledgeEntry) error {
	if err := s.ensureDir(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(normalizeEntries(entries), "", "  ")
	if err != nil {
		return fmt.Errorf("序列化知识库索引失败: %w", err)
	}
	if err := fileutil.AtomicWrite(s.indexFile(), data, filePerm); err != nil {
		return fmt.Errorf("写入知识库索引失败: %w", err)
	}
	return nil
}

// upsertIndex 在索引中新增或替换指定条目（仅存元数据）并落盘。
func (s *Store) upsertIndex(entry model.KnowledgeEntry) error {
	entries, err := s.readIndex()
	if err != nil {
		return err
	}
	meta := entry
	meta.Content = ""
	replaced := false
	for i := range entries {
		if entries[i].ID == meta.ID {
			entries[i] = meta
			replaced = true
			break
		}
	}
	if !replaced {
		entries = append(entries, meta)
	}
	sortEntries(entries)
	return s.writeIndex(entries)
}

// sortEntries 按更新时间倒序排列，时间相同时按 ID 升序，保证输出稳定。
func sortEntries(entries []model.KnowledgeEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Updated != entries[j].Updated {
			return entries[i].Updated > entries[j].Updated
		}
		return entries[i].ID < entries[j].ID
	})
}

// normalizeList 保证数组字段非 nil，序列化结果为 [] 而不是 null。
func normalizeList(items []string) []string {
	if items == nil {
		return []string{}
	}
	return items
}

// normalizeEntry 规范化单个条目的数组字段。
func normalizeEntry(entry model.KnowledgeEntry) model.KnowledgeEntry {
	entry.Tags = normalizeList(entry.Tags)
	entry.Converted = normalizeList(entry.Converted)
	return entry
}

// normalizeEntries 规范化条目列表，空列表返回非 nil 切片。
func normalizeEntries(entries []model.KnowledgeEntry) []model.KnowledgeEntry {
	if entries == nil {
		return []model.KnowledgeEntry{}
	}
	for i := range entries {
		entries[i] = normalizeEntry(entries[i])
	}
	return entries
}
