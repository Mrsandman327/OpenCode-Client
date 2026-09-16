package knowledge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

// categoriesFileName 分类树文件名。
const categoriesFileName = "categories.json"

// categoriesFile 返回分类树文件路径。
func (s *Store) categoriesFile() string {
	return filepath.Join(s.dir, categoriesFileName)
}

// LoadCategories 读取完整分类树；文件不存在时返回空列表。
func (s *Store) LoadCategories() ([]model.KnowledgeCategory, error) {
	data, err := os.ReadFile(s.categoriesFile())
	if err != nil {
		if os.IsNotExist(err) {
			return []model.KnowledgeCategory{}, nil
		}
		return nil, fmt.Errorf("读取知识库分类失败: %w", err)
	}
	var cats []model.KnowledgeCategory
	if err := json.Unmarshal(data, &cats); err != nil {
		return nil, fmt.Errorf("解析知识库分类失败: %w", err)
	}
	if cats == nil {
		return []model.KnowledgeCategory{}, nil
	}
	return cats, nil
}

// SaveCategories 原子写入完整分类树（数量与层级不做限制）。
func (s *Store) SaveCategories(cats []model.KnowledgeCategory) error {
	if err := s.ensureDir(); err != nil {
		return err
	}
	if cats == nil {
		cats = []model.KnowledgeCategory{}
	}
	data, err := json.MarshalIndent(cats, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化知识库分类失败: %w", err)
	}
	if err := fileutil.AtomicWrite(s.categoriesFile(), data, filePerm); err != nil {
		return fmt.Errorf("写入知识库分类失败: %w", err)
	}
	return nil
}
